#!/usr/bin/env python3
"""Generate disposable local JWT signing fixtures; never distribute signing keys."""
import base64
import json
import pathlib
import subprocess
import tempfile
root = pathlib.Path(__file__).resolve().parents[1]
fixtures = root / 'crates/event-auth-jwt/tests/fixtures'
fixtures.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory() as folder:
    key = pathlib.Path(folder) / 'key.pem'
    subprocess.run(['openssl', 'genrsa', '-out', str(key), '2048'], check=True, capture_output=True)
    subprocess.run(['openssl', 'rsa', '-in', str(key), '-traditional', '-outform', 'DER', '-out', str(fixtures / 'TEST-ONLY-private.der')], check=True, capture_output=True)
    modulus = subprocess.run(['openssl', 'rsa', '-in', str(key), '-noout', '-modulus'], check=True, capture_output=True, text=True).stdout.strip().split('=', 1)[1]
    encoded = base64.urlsafe_b64encode(bytes.fromhex(modulus)).decode().rstrip('=')
    (fixtures / 'jwks.json').write_text(json.dumps({'keys': [{'kty': 'RSA', 'kid': 'test-key', 'use': 'sig', 'alg': 'RS256', 'n': encoded, 'e': 'AQAB'}]}, indent=2) + '\n')
print('Generated disposable JWT fixtures (ignored by Git).')
