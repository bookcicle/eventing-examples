"""Privacy-conscious synchronous Eventing producer. Explicitly flush before shutdown."""

import copy
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import math
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

__version__ = "2.0.0"
RETRYABLE = {429, 500, 502, 503, 504}
FORBIDDEN = set(
    "email name full_name phone ssn source_ip ip gclid fbclid msclkid li_fat_id rdt_cid oppref x-event-auth authorization token".split()
)
CREDENTIALS = {"x-event-auth", "authorization", "token"}


def sanitize(value, allow=False):
    if isinstance(value, dict):
        return {
            k: sanitize(v, allow)
            for k, v in value.items()
            if k.lower() not in CREDENTIALS and (allow or k.lower() not in FORBIDDEN)
        }
    if isinstance(value, list):
        return [sanitize(v, allow) for v in value]
    return value


def validate_endpoint(value):
    u = urllib.parse.urlsplit(value)
    local = u.scheme == "http" and u.hostname in ("localhost", "127.0.0.1", "::1")
    if (
        not u.hostname
        or (u.scheme != "https" and not local)
        or u.username
        or u.password
        or u.query
        or u.fragment
        or u.path not in ("/events", "/public", "/secure")
    ):
        raise ValueError("Invalid public Eventing endpoint")
    _ = u.port
    return value


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def _transport(endpoint, body, headers, timeout):
    opener = urllib.request.build_opener(_NoRedirect())
    try:
        with opener.open(
            urllib.request.Request(endpoint, data=body, headers=headers, method="POST"),
            timeout=timeout,
        ) as r:
            return r.status
    except urllib.error.HTTPError as e:
        status = e.code
        e.close()
        return status


class EventingClient:
    """Durable bounded queue with automatic batching and outage recovery.

    Calls are serialized by a lock. On any failed batch its events remain queued.
    max_retries is the total number of attempts, matching the JS API.
    """

    def __init__(
        self,
        endpoint,
        *,
        default_namespace="general",
        environment="prod",
        get_auth_token=None,
        max_batch_events=25,
        max_queue_items=1000,
        max_batch_bytes=8192,
        max_retries=3,
        base_backoff_ms=200,
        timeout=5,
        allow_sensitive_properties=False,
        transport=None,
        sleep=time.sleep,
        flush_interval_ms=1000,
        max_batch_age_ms=5000,
        queue_path=None,
        on_error=None,
    ):
        self._client_sid = str(uuid.uuid4())
        self._endpoint = validate_endpoint(endpoint)
        if environment not in ("dev", "test", "prod"):
            raise ValueError("environment must be dev, test or prod")
        self._environment = environment
        self._scope = {
            "endpoint": self.endpoint,
            "environment": environment,
            "namespace": default_namespace,
        }
        for value in (
            max_batch_events,
            max_queue_items,
            max_batch_bytes,
            max_retries,
            flush_interval_ms,
            max_batch_age_ms,
        ):
            if not isinstance(value, int) or isinstance(value, bool) or value < 1:
                raise ValueError("Limits must be positive integers")
        if (
            max_batch_events > 500
            or max_retries > 10
            or not math.isfinite(base_backoff_ms)
            or not math.isfinite(timeout)
            or base_backoff_ms < 0
            or timeout <= 0
            or not default_namespace.strip()
        ):
            raise ValueError("Invalid client configuration")
        self.namespace, self.get_auth_token = default_namespace, get_auth_token
        self.max_batch_events, self.max_queue_items = max_batch_events, max_queue_items
        self.max_batch_bytes, self.max_retries = max_batch_bytes, max_retries
        self.backoff, self.timeout, self.allow = (
            base_backoff_ms / 1000,
            timeout,
            allow_sensitive_properties,
        )
        self.transport, self.sleep = transport or _transport, sleep
        self._lock = threading.RLock()
        self._timer, self._started, self._closed = None, None, False
        self.interval, self.max_age = flush_interval_ms / 1000, max_batch_age_ms / 1000
        self.on_error = on_error or (lambda result: None)
        # None chooses durable user storage; False explicitly selects memory only.
        key = hashlib.sha256(
            (
                ("" if environment == "prod" else environment + ":")
                + self.endpoint
                + ":"
                + self.namespace
            ).encode()
        ).hexdigest()
        self.queue_path = (
            pathlib.Path.home() / ".cache/bookcicle/eventing/python" / (key + ".json")
            if queue_path is None
            else pathlib.Path(queue_path) if queue_path else None
        )
        self._events = []
        if self.queue_path:
            self.queue_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            try:
                fd = os.open(
                    self.queue_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
                )
            except FileExistsError:
                pass
            else:
                with os.fdopen(fd, "w", encoding="utf-8") as stream:
                    json.dump(
                        {"version": 2, "scope": self._scope, "events": []}, stream
                    )
                    stream.flush()
                    os.fsync(stream.fileno())
            data = json.loads(self.queue_path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                if data:
                    raise ValueError(
                        "Unscoped queue contains events; drain or explicitly migrate it before upgrading"
                    )
            elif (
                not isinstance(data, dict)
                or data.get("version") != 2
                or data.get("scope") != self._scope
            ):
                raise ValueError("Queue endpoint/environment/namespace scope mismatch")
            else:
                self._events = data.get("events")
            if (
                not isinstance(self._events, list)
                or len(self._events) > max_queue_items
            ):
                raise ValueError("Invalid persisted queue")
            if isinstance(data, list):
                self._persist()
        if self._events:
            self._schedule()

    @property
    def endpoint(self):
        return self._endpoint

    @property
    def environment(self):
        return self._environment

    def _persist(self):
        if self.queue_path:
            self.queue_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            fd, name = tempfile.mkstemp(dir=self.queue_path.parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(
                        {"version": 2, "scope": self._scope, "events": self._events},
                        f,
                        ensure_ascii=False,
                        allow_nan=False,
                    )
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(name, self.queue_path)
            finally:
                if os.path.exists(name):
                    os.unlink(name)

    def _schedule(self):
        if self._closed:
            return
        if self._timer and len(self._events) < self.max_batch_events:
            return
        if self._timer:
            self._timer.cancel()
        self._started = self._started or time.monotonic()
        delay = (
            0
            if len(self._events) >= self.max_batch_events
            else min(
                self.interval, max(0, self.max_age - (time.monotonic() - self._started))
            )
        )
        self._timer = threading.Timer(delay, self._background)
        self._timer.daemon = True
        self._timer.start()

    def _background(self):
        try:
            result = self.flush()
            if not result["ok"]:
                self.on_error(result)
        except Exception as error:
            try:
                self.on_error(error)
            except Exception:
                pass
        with self._lock:
            if (
                self._events
                and not self._closed
                and ("result" not in locals() or result.get("retryable", False))
            ):
                self._schedule_recovery()

    def _schedule_recovery(self):
        if not self._closed:
            if self._timer:
                self._timer.cancel()
            self._started = None
            self._timer = threading.Timer(self.interval, self._background)
            self._timer.daemon = True
            self._timer.start()

    def close(self):
        with self._lock:
            self._closed = True
            if self._timer:
                self._timer.cancel()
            return self.flush()

    @staticmethod
    def _body(events, batch_id=None):
        return json.dumps(
            {
                "schema_version": "1",
                "batch_id": batch_id or str(uuid.uuid4()),
                "events": events,
            },
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")

    def track(self, event):
        """Persist an event snapshot and return its immutable event_id.

        Optional sid (or context.sid) overrides the session for this event only.
        Omitted event_id generates a UUID; explicit IDs must be 1–128 UTF-8 bytes
        without controls or surrounding whitespace. Use flush to retry pending events.
        """
        with self._lock:
            if self._closed:
                raise ValueError("Client is closed")
            name = event.get("name")
            if (
                not isinstance(name, str)
                or not name.strip()
                or len(name.strip().encode()) > 128
                or any(ord(c) < 32 or ord(c) == 127 for c in name)
            ):
                raise ValueError("Invalid event name")
            namespace = event.get(
                "namespace", event.get("context", {}).get("namespace", self.namespace)
            )
            sid = event.get(
                "sid", event.get("context", {}).get("sid", self._client_sid)
            )
            if (
                not isinstance(sid, str)
                or not sid.strip()
                or len(sid.encode("utf-8")) > 256
                or any(ord(c) < 32 or ord(c) == 127 for c in sid)
            ):
                raise ValueError("Invalid sid")
            props = event.get("properties", event.get("props", {}))
            if (
                not isinstance(namespace, str)
                or not namespace.strip()
                or not isinstance(props, dict)
            ):
                raise ValueError("Invalid namespace or properties")
            event_id = event.get("event_id", str(uuid.uuid4()))
            event_time = event.get(
                "event_time",
                dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
            )
            if (
                not isinstance(event_id, str)
                or not event_id
                or len(event_id.encode("utf-8")) > 128
                or event_id.strip("\ufeff").strip() != event_id
                or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in event_id)
                or not isinstance(event_time, str)
            ):
                raise ValueError("Invalid event ID or time")
            if not re.fullmatch(
                r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})",
                event_time,
            ):
                raise ValueError("event_time must use RFC 3339")
            dt.datetime.fromisoformat(event_time.replace("Z", "+00:00"))
            normalized = {
                "event_id": event_id,
                "name": name.strip(),
                "event_time": event_time,
                "context": {"namespace": namespace, "sid": sid},
                "properties": sanitize(props, self.allow),
            }
            if len(self._body([normalized])) > self.max_batch_bytes:
                raise ValueError("Event exceeds max_batch_bytes")
            if any(e["event_id"] == event_id for e in self._events):
                raise ValueError("Duplicate queued event ID")
            if len(self._events) >= self.max_queue_items:
                raise ValueError("Event queue is full")
            self._events.append(copy.deepcopy(normalized))
            try:
                self._persist()
            except Exception:
                self._events.pop()
                raise
            self._schedule()
            return event_id

    def get_queue_items(self):
        with self._lock:
            return copy.deepcopy(self._events)

    def discard(self, event_ids):
        with self._lock:
            previous = self._events[:]
            self._events = [e for e in self._events if e["event_id"] not in event_ids]
            try:
                self._persist()
            except Exception:
                self._events = previous
                raise

    def flush(self):
        try:
            return self._flush()
        except Exception:
            with self._lock:
                self._schedule_recovery()
            raise

    def _flush(self):
        with self._lock:
            if self._timer:
                self._timer.cancel()
            self._started = None
            self._timer = None
            flushed = 0
            while self._events:
                batch = []
                for event in self._events[: self.max_batch_events]:
                    if len(self._body(batch + [event])) > self.max_batch_bytes:
                        break
                    batch.append(event)
                if not batch:
                    raise ValueError("Queued event exceeds max_batch_bytes")
                body = self._body(batch)
                headers = {
                    "Content-Type": "application/json",
                    "x-amz-content-sha256": hashlib.sha256(body).hexdigest(),
                }
                token = self.get_auth_token() if self.get_auth_token else None
                if token:
                    if not isinstance(token, str) or any(
                        ord(c) < 32 or ord(c) == 127 for c in token
                    ):
                        raise ValueError("Invalid auth token")
                    if token.strip():
                        headers["x-event-auth"] = (
                            token.strip()
                            if token.strip().startswith("Bearer ")
                            else "Bearer " + token.strip()
                        )
                status = 503
                for attempt in range(self.max_retries):
                    try:
                        status = self.transport(
                            self.endpoint, body, headers, self.timeout
                        )
                    except (OSError, urllib.error.URLError):
                        status = 503
                    if status == 202 or status not in RETRYABLE:
                        break
                    if attempt + 1 < self.max_retries:
                        self.sleep(self.backoff * 2**attempt)
                if status != 202:
                    if status in RETRYABLE:
                        self._schedule_recovery()
                    return {
                        "ok": False,
                        "status": status,
                        "retryable": status in RETRYABLE,
                        "flushed": flushed,
                    }
                previous = self._events[:]
                del self._events[: len(batch)]
                try:
                    self._persist()
                except Exception:
                    self._events = previous
                    raise
                flushed += len(batch)
            return {"ok": True, "flushed": flushed}
