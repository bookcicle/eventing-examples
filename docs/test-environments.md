# Test environments

Use a separate installation of the real Eventing pipeline for SDK integration tests. `Stage=test` does not introduce a mock ingestion path or different delivery guarantees.

## Deploy an isolated test installation

Create a new coordinated root through your subscribed Marketplace launch flow. Use a separate AWS account where possible, plus a unique deployment ID, first-party hostname and CORS origins. Do not change an existing production stack into a test stack.

```json
{
  "DeploymentId": "ev-acme-test",
  "Stage": "test",
  "CustomDomainName": "events-test.example.com",
  "HostedZoneId": "Z0123456789EXAMPLE",
  "AllowedCorsOrigins": "https://app-test.example.com",
  "USRegion": "us-east-1",
  "EURegion": "",
  "APACRegion": "",
  "Additional1Region": "",
  "Additional2Region": "",
  "RetentionDays": 0,
  "LogRetentionDays": 0
}
```

The default is one ingestion region. With `RetentionDays=0`, test S3 objects expire after seven days; dev/prod resolve to 365 days. With `LogRetentionDays=0`, managed regional and lookup logs retain seven days for test; dev/prod resolve to 30 days. Edge-created log groups require their own retention policy. Positive supported values override these defaults. Existing stacks retain their current parameter values during normal updates unless you explicitly change them; use zero to adopt the stage defaults.

The test endpoint, regional buckets, Firehose/Kinesis resources and quota tables belong to the separate installation. Each regional bucket remains subject to its lifecycle policy even when retained after stack deletion. Authentication, namespace checks, rate limits, batching, retry policy and delivery semantics remain the same. AWS resources remain billable; subscription treatment follows your Marketplace offer.

## Configure every SDK explicitly

The client option `environment` accepts `dev`, `test` or `prod` and defaults to `prod` in all four SDKs. It scopes local queues; it does not discover, rewrite or authenticate the endpoint. Pair `environment=test` with the actual test endpoint. The SDK does not verify the server's deployment stage, and an environment label is not an access control.

```javascript
const events = createEventingClient({
  endpoint: "https://events-test.example.com/events",
  environment: "test"
});
```

```python
client = EventingClient(
    "https://events-test.example.com/events",
    environment="test",
)
```

```rust
let mut config = Config::new("https://events-test.example.com/events");
config.environment = "test".into();
```

```java
var config = new EventingClient.Config("https://events-test.example.com/events");
config.environment = "test";
```

Each default queue is partitioned by endpoint, environment and default namespace. Built-in file queues persist that binding in a version 2 envelope; IndexedDB stores it in database metadata. Reusing a custom queue location for a different binding rejects before background recovery or delivery starts, including when the queue is empty. Give each client its own storage path/database for each authentication identity, and run only one live client per path/database. Authentication identity separation remains application-owned.

Client configuration and queue metadata do not add an environment field to event payloads or change event IDs, SIDs, batching, privacy filtering or retries. Queue recovery preserves event snapshots. Python's endpoint and environment properties are read-only; construct a new client when switching destinations.

## Upgrade existing queues

Nonempty legacy queues without binding metadata cannot establish which environment owns their events, so the new SDK rejects them instead of claiming or replaying them. Drain pending events with the previous SDK before upgrading. If draining is impossible, preserve a backup and explicitly migrate/re-enqueue verified snapshots into the correct destination while preserving event IDs and timestamps. Do not delete pending events merely to clear an initialization error.

The default `prod` queue location is retained for compatibility. New `dev` and `test` labels use separate locations and do not automatically import older queues. Empty legacy queues can be initialized with the new binding. A custom JavaScript queue must implement `bind(scope)` and persist/check the endpoint, environment and namespace before allowing queue operations. The binding is local metadata and contains no authentication token.

## Verify actual S3 delivery

From a public Eventing examples checkout (or Eventing source checkout) with Python and boto3 installed:

```bash
python3 scripts/verify-test-environment.py \
  --stack-name ev-acme-test \
  --profile your-test-profile
```

The checker verifies the root's `Stage=test`, completed status, account and endpoint outputs, then verifies the regional buckets' ownership, stage/deployment tags and locations before sending one synthetic event through the Python SDK. It searches enabled regional buckets for that event's immutable ID and fails if S3 arrival is not observed within ten minutes. HTTP 202 alone is insufficient. It reads only recent matching-prefix objects, caps object sizes, and reports the matching event ID and destination without printing event payloads. Keep the test Context Layer's namespace mapping aligned with the smoke namespace.

Set `EVENTING_TEST_AUTH_TOKEN` in the environment when the test Context Layer requires authentication. Do not place tokens in command arguments or event properties. The checker uses an in-memory queue for its disposable synthetic event; production applications should use durable queues.

The GitHub workflow **Eventing test environment delivery** runs the same check on demand. Configure the protected `eventing-test` environment with `EVENTING_TEST_ROLE_ARN` as a variable and an optional `EVENTING_TEST_AUTH_TOKEN` secret. Restrict the role's OIDC trust to that repository/environment and grant read access only to the designated test stack and regional test buckets: `cloudformation:DescribeStacks`, `s3:GetBucketTagging`, `s3:GetBucketLocation`, `s3:ListBucket` and `s3:GetObject`. For customer-managed SSE-KMS storage, also grant `kms:Decrypt` on the relevant test keys. It does not deploy stacks or publish SDKs.

## Local unit tests

Use the existing JavaScript `fetchImpl` and Python `transport` injection points, or local HTTP fixtures for Rust and Java, for fast deterministic tests. A local response fixture does not prove real ingestion or S3 delivery. Keep the deployed test environment as the end-to-end check.
