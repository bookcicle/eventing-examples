# Send events from Python, Rust and curl

These runnable producers use the same canonical batch envelope as the browser SDK. Send to the public CloudFront hostname, including `/events`, `/public` or `/secure`; the private Lambda Function URL requires CloudFront origin access control. No AWS credentials belong in a producer.

## Shared request contract

`examples/batch.json` contains two synthetic events for learning and parser tests. Each runnable producer generates new batch/event UUIDs and timestamps for every invocation, serializes once, hashes those exact bytes, and keeps them unchanged during retries. Change the example event names and properties to fit your application; do not send credentials or unnecessary personal data as properties.

```json
{
  "schema_version": "1",
  "batch_id": "4d56bfd2-4659-4f0c-8442-18c20ccf2001",
  "events": [{
    "event_id": "4d56bfd2-4659-4f0c-8442-18c20ccf2002",
    "name": "example_started",
    "event_time": "2026-10-19T10:30:00Z",
    "context": {"namespace": "general"},
    "properties": {"runtime": "example"}
  }]
}
```

Get the public [eventing-examples repository](https://github.com/bookcicle/eventing-examples), then set the complete endpoint and run one producer from its root. No private repository access is required. HTTPS is required except for loopback HTTP used by local tests. The examples reject endpoint credentials, query strings, fragments and unsupported paths; redirects are not followed.

```bash
export EVENTING_ENDPOINT=https://events.example.com/events
export EVENTING_NAMESPACE=general
unset EVENTING_AUTH_TOKEN
```

## Python standard library

Requires Python 3.9 or later; no pip packages are required. The implementation uses `urllib.request`, SHA-256, UUIDs and JSON from the standard library.

```bash
python3 examples/python/send_events.py
```

The complete source is [examples/python/send_events.py](https://github.com/bookcicle/eventing-examples/blob/main/examples/python/send_events.py). It has a five-second per-attempt timeout, a three-attempt budget and bounded exponential backoff. It sends `Content-Type: application/json` and `x-amz-content-sha256`; it adds `x-event-auth` only when configured.

## Rust

Requires the Rust toolchain. The workspace lockfile pins the dependencies. The implementation uses blocking reqwest with rustls, a two-second connection timeout, a five-second request timeout and the same three-attempt retry budget.

```bash
cargo run --locked -p eventing-example-producer
```

The complete source is [examples/rust/src/main.rs](https://github.com/bookcicle/eventing-examples/blob/main/examples/rust/src/main.rs). This small CLI intentionally uses a blocking client; in an async service, use reqwest's async client and a bounded application queue instead of blocking the executor.

## curl

Requires Bash, curl, Python 3 and `sha256sum`. Python generates the canonical batch and validates the endpoint; curl sends the request. Credentials are passed through curl's stdin configuration, rather than appearing in its command-line arguments.

```bash
bash examples/curl/send-events.sh
```

The source is [examples/curl/send-events.sh](https://github.com/bookcicle/eventing-examples/blob/main/examples/curl/send-events.sh). It retries only transient responses or connection failures, at most three attempts, and uses five-second request/two-second connection timeouts. For a single manual smoke request without retries, the fixture can also be sent directly:

```bash
curl --silent --show-error --fail-with-body \
  --connect-timeout 2 --max-time 5 \
  -H 'Content-Type: application/json' \
  -H "x-amz-content-sha256: $(sha256sum examples/batch.json | cut -d ' ' -f 1)" \
  --data-binary @examples/batch.json "$EVENTING_ENDPOINT"
```

The manual fixture has fixed IDs and timestamps. Use the runnable producers for repeated requests; they generate fresh IDs. The manual command is anonymous and sends no token.

## Authenticated calls

Deploy the [auth layer](auth-layer.md), set a token minted for your configured issuer/audience, and request an allowed namespace. `/secure` requires authentication. `/events` permits either decision; `/public` requires anonymous and rejects authenticated tokens.

```bash
export EVENTING_ENDPOINT=https://events.example.com/secure
export EVENTING_NAMESPACE=claims
# Populate EVENTING_AUTH_TOKEN securely from your identity integration.
# It contains the raw access token, without the Bearer prefix.
python3 examples/python/send_events.py
cargo run --locked -p eventing-example-producer
bash examples/curl/send-events.sh
unset EVENTING_AUTH_TOKEN
```

All three use `x-event-auth: Bearer <token>`. For the synthetic demo layer only, `EVENTING_AUTH_TOKEN=valid-claims-token` exercises the claims policy. The JWT starter requires a real signed access token and never accepts the demo tokens. Environment variables are convenient for these CLIs; production services should obtain/refresh short-lived tokens from their identity integration and avoid logging them. Native/server producers do not need browser CORS configuration.

## Responses, retries and delivery semantics

HTTP 202 means the ingestion function accepted the batch into Firehose; it does not confirm that S3 delivery has completed. The actual response includes `status: accepted` and `accepted_events`; inspect regional Firehose/S3 metrics for delivery completion. Each CLI reports acceptance without printing raw response bodies or credentials.

Retry HTTP 429, 500, 502, 503 and 504 with bounded backoff. A connection failure or timeout has an uncertain outcome; these examples retry while preserving IDs and serialized bytes. **Exactly-once delivery and server-side deduplication are not promised.** Downstream consumers should deduplicate by event ID when needed. These starter CLIs have no durable offline queue; production services should persist pending events and handle exhausted retries according to their delivery requirements.

Do not retry malformed requests, denied credentials/namespaces, WAF blocks or residency rejection without correcting their cause. In particular, 403 can come from WAF, origin access control or authentication policy; 451 means the router could not satisfy regional residency. The exact error response can vary by rejecting layer. Keep sample batches small: the default managed WAF Common Rule Set can reject bodies above 8192 bytes even though the runtime parser supports 1 MiB and 500 events. See [configuration and WAF limits](configuration.md).

## Local verification

No AWS endpoint or identity provider is needed for these checks. A recording loopback server checks both anonymous/authenticated requests, body hashes, namespace selection, unchanged IDs across 429/503 retries, no retry on 403/451, no token logging, and the three-attempt limit.

```bash
cargo build --locked -p eventing-example-producer
python3 scripts/test-producers.py
python3 scripts/generate-test-keys.py
cargo test --locked --workspace
```

The fixture parser test uses the real ingestion parser. Network tests use a local HTTP fixture rather than an AWS deployment; regional IAM, WAF and Firehose behavior still require a controlled deployment smoke test before production rollout.
