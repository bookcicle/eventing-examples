#!/usr/bin/env python3
"""Exercise the actual stdin/stdout executable; no AWS credentials required."""
import json
import pathlib
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
BINARY = ROOT / 'target/debug/event-auth'

class AuthFixtures(unittest.TestCase):
    def run_auth(self, payload):
        result = subprocess.run([BINARY], input=payload, capture_output=True, check=True, timeout=3)
        self.assertEqual(result.stderr, b'')
        return json.loads(result.stdout)

    def test_fixtures(self):
        for fixture in (ROOT / 'examples/auth/fixtures').glob('*.request.json'):
            with self.subTest(fixture=fixture.name):
                expected = json.loads(fixture.with_name(fixture.name.replace('.request.', '.response.')).read_text())
                self.assertEqual(self.run_auth(fixture.read_bytes()), expected)

    def test_present_empty_and_duplicate_credentials_are_denied(self):
        request = json.loads((ROOT / 'examples/auth/fixtures/anonymous.request.json').read_text())
        for headers in [{'x-event-auth': ''}, {'x-event-auth': 'Bearer valid-claims-token', 'X-Event-Auth': 'invalid'}]:
            request['headers'] = headers
            self.assertEqual(self.run_auth(json.dumps(request).encode())['decision'], 'deny')

    def test_malformed_unsupported_and_oversized_fail_closed(self):
        request = json.loads((ROOT / 'examples/auth/fixtures/anonymous.request.json').read_text())
        request['contract_version'] = '999'
        for payload in [b'{', json.dumps(request).encode(), b' ' * (256 * 1024 + 1)]:
            self.assertEqual(self.run_auth(payload)['decision'], 'deny')

if __name__ == '__main__':
    unittest.main()
