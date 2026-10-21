#!/usr/bin/env python3
"""Run all three producers against a recording local HTTP server."""
import hashlib
import http.server
import json
import os
import pathlib
import subprocess
import threading
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        self.server.requests.append((self.path, dict(self.headers), body))
        index = len(self.server.requests) - 1
        status = self.server.statuses[min(index, len(self.server.statuses) - 1)]
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(
            b'{"status":"accepted"}' if status == 202 else b'{"error":"fixture"}'
        )

    def log_message(self, *args):
        pass


class Producers(unittest.TestCase):
    commands = {
        "python": ["python3", "examples/python/send_events.py"],
        "curl": ["bash", "examples/curl/send-events.sh"],
        "rust": ["target/debug/eventing-example-producer"],
    }

    def run_case(self, command, statuses, token=None, sid=None):
        with http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            server.statuses, server.requests = statuses, []
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            env = {
                **os.environ,
                "EVENTING_ENDPOINT": f"http://127.0.0.1:{server.server_port}/events",
                "EVENTING_NAMESPACE": "claims" if token else "general",
            }
            env.pop("EVENTING_AUTH_TOKEN", None)
            env.pop("EVENTING_SID", None)
            if sid is not None:
                env["EVENTING_SID"] = sid
            if token:
                env["EVENTING_AUTH_TOKEN"] = token
            result = subprocess.run(
                command, cwd=ROOT, env=env, capture_output=True, text=True, timeout=20
            )
            server.shutdown()
            thread.join()
        return result, server.requests

    def assert_payload(self, requests, token=None):
        self.assertTrue(requests)
        first = requests[0][2]
        for path, headers, body in requests:
            headers = {k.lower(): v for k, v in headers.items()}
            self.assertEqual(path, "/events")
            self.assertEqual(
                headers["x-amz-content-sha256"], hashlib.sha256(body).hexdigest()
            )
            self.assertEqual(
                headers.get("x-event-auth"), "Bearer " + token if token else None
            )
            self.assertEqual(body, first, "Retries must reuse IDs and bytes")
            batch = json.loads(body)
            self.assertEqual(batch["schema_version"], "1")
            self.assertEqual(len(batch["events"]), 2)
            self.assertEqual(len({e["event_id"] for e in batch["events"]}), 2)
            for event in batch["events"]:
                self.assertEqual(
                    event["context"]["namespace"], "claims" if token else "general"
                )
                self.assertTrue(event["context"]["sid"])
            self.assertEqual(len({e["context"]["sid"] for e in batch["events"]}), 1)

    def test_accept_anonymous_and_authenticated(self):
        for runtime, command in self.commands.items():
            for token in [None, "fixture-token"]:
                with self.subTest(runtime=runtime, token=bool(token)):
                    result, requests = self.run_case(command, [202], token)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(len(requests), 1)
                    self.assert_payload(requests, token)

    def test_retry_transient_failure_without_changing_ids(self):
        for runtime, command in self.commands.items():
            with self.subTest(runtime=runtime):
                result, requests = self.run_case(
                    command, [429, 503, 202], "fixture-token"
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(len(requests), 3)
                self.assert_payload(requests, "fixture-token")

    def test_deny_and_residency_failures_are_not_retried(self):
        for runtime, command in self.commands.items():
            for status in [403, 451]:
                with self.subTest(runtime=runtime, status=status):
                    result, requests = self.run_case(
                        command, [status], "never-print-this-token"
                    )
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(len(requests), 1)
                    self.assertNotIn(
                        "never-print-this-token", result.stdout + result.stderr
                    )

    def test_retry_budget_is_bounded(self):
        for runtime, command in self.commands.items():
            with self.subTest(runtime=runtime):
                result, requests = self.run_case(command, [503])
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(len(requests), 3)

    def test_session_override_is_stable_across_retries(self):
        for runtime, command in self.commands.items():
            with self.subTest(runtime=runtime):
                result, requests = self.run_case(
                    command, [503, 202], sid="opaque-session-from-app"
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assert_payload(requests)
                self.assertTrue(
                    all(
                        e["context"]["sid"] == "opaque-session-from-app"
                        for e in json.loads(requests[0][2])["events"]
                    )
                )

    def test_invalid_session_override_never_sends(self):
        for runtime, command in self.commands.items():
            with self.subTest(runtime=runtime):
                result, requests = self.run_case(command, [202], sid=" ")
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(requests, [])


if __name__ == "__main__":
    unittest.main()
