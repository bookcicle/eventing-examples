#!/usr/bin/env python3
"""Python 3.9+ standard library producer. No AWS credentials or SDK required."""
import datetime
import hashlib
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

RETRYABLE = {429, 500, 502, 503, 504}


def endpoint():
    token = os.environ.get("EVENTING_AUTH_TOKEN", "")
    if any(ord(c) < 32 or ord(c) == 127 for c in token):
        raise ValueError("Invalid token characters")
    value = os.environ.get("EVENTING_ENDPOINT", "")
    parsed = urllib.parse.urlsplit(value)
    local = parsed.scheme == "http" and parsed.hostname in (
        "127.0.0.1",
        "localhost",
        "::1",
    )
    if (
        not value
        or (parsed.scheme != "https" and not local)
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError(
            "Set EVENTING_ENDPOINT to the HTTPS public Eventing URL, including /events, /public or /secure"
        )
    if parsed.path not in ("/events", "/public", "/secure"):
        raise ValueError("Endpoint path must be /events, /public or /secure")
    return value


def make_batch(runtime="python"):
    batch = json.loads(
        (pathlib.Path(__file__).resolve().parents[1] / "batch.json").read_text()
    )
    batch["batch_id"] = str(uuid.uuid4())
    sid = os.environ.get("EVENTING_SID", str(uuid.uuid4()))
    if (
        not sid.strip()
        or len(sid.encode()) > 256
        or any(ord(c) < 32 or ord(c) == 127 for c in sid)
    ):
        raise ValueError("Invalid EVENTING_SID")
    for event in batch["events"]:
        event["event_id"] = str(uuid.uuid4())
        event["event_time"] = (
            datetime.datetime.now(datetime.timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
        )
        event["context"]["namespace"] = os.environ.get("EVENTING_NAMESPACE", "general")
        event["context"]["sid"] = sid
        event["properties"]["runtime"] = runtime
    return batch


class NoRedirect(urllib.request.HTTPRedirectHandler):
    # Never forward an authentication token to a redirected URL.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def send_events():
    url = endpoint()
    body = json.dumps(make_batch(), separators=(",", ":")).encode()
    headers = {
        "Content-Type": "application/json",
        "x-amz-content-sha256": hashlib.sha256(body).hexdigest(),
    }
    token = os.environ.get("EVENTING_AUTH_TOKEN")
    if token:
        if any(ord(c) < 32 or ord(c) == 127 for c in token):
            raise ValueError("Invalid token characters")
        headers["x-event-auth"] = "Bearer " + token
    opener = urllib.request.build_opener(NoRedirect())
    for attempt in range(3):
        try:
            with opener.open(
                urllib.request.Request(url, data=body, headers=headers, method="POST"),
                timeout=5,
            ) as response:
                status = response.status
                response.read(65536)
        except urllib.error.HTTPError as error:
            status = error.code
            error.close()
        except (urllib.error.URLError, TimeoutError):
            # Delivery is uncertain. Retrying may duplicate events; IDs stay stable.
            status = 503
        if status == 202:
            print(
                "Accepted 2 events by the ingestion pipeline (S3 delivery is asynchronous)."
            )
            return
        if status not in RETRYABLE or attempt == 2:
            raise RuntimeError(
                f"Eventing request failed: HTTP {status}; inspect deployment metrics and request logs"
            )
        time.sleep(0.25 * 2**attempt)


if __name__ == "__main__":
    try:
        send_events()
    except (ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
