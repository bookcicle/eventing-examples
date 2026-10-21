# Eventing configuration reference

## Buffered delivery with selective retries

Eventing provides **buffered delivery with selective retries**, not guaranteed end-to-end delivery. There is no zero-loss, exactly-once or event-ordering guarantee.

- **HTTP 202 is stream acceptance.** All submitted records were acknowledged by Firehose in direct mode or Kinesis in retained-stream mode. It does not confirm arrival in S3 or delivery to any downstream destination.
- **Retries are bounded.** The runtime selectively retries records explicitly reported as failed; it does not resend acknowledged records in those retries. The runtime permits three application submission rounds; AWS SDK retries are separate. An API/transport error or exhausted retries returns HTTP 502. A failed request may already have accepted some records; a timeout can leave the outcome unknown.
- **Loss and duplicates remain possible.** Events that never reach ingestion, exhaust producer retries, or cannot be recovered before buffer retention expires can be lost. Client retries and uncertain write outcomes can produce duplicates. Preserve stable event IDs and deduplicate in the appropriate tenant/namespace scope. The service has no server-side deduplication store or guaranteed replay of rejected requests.
- **Recovery needs an owner.** Persist pending events in a durable producer queue when required. Monitor ingestion errors/throttles, delivery freshness, error prefixes and actual S3 arrival; investigate failures and reconcile expected IDs against stored records. Metrics alone do not prove every event arrived.
- **Buffering is not a delivery guarantee.** The default path is Lambda → Firehose → S3; retained-stream mode adds Kinesis before Firehose. Downstream filtering, forwarding, retries and destination acknowledgements are customer-owned.

Use the [complete public configuration guide](https://eventing.bookcicle.com/configuration) for recommended settings, exact WAF controls, region routing and scaling expectations. The machine-readable [configuration reference](https://github.com/bookcicle/eventing-examples/blob/main/reference/configuration.json) lists the coordinated root parameters, advanced regional/edge parameters, defaults, validation constraints, environment mappings, WAF rules and residency country groups.

## Deploy through AWS Marketplace

Subscribe through AWS Marketplace and use the product's Configure and launch flow. Marketplace supplies the versioned infrastructure package. The examples repository is not a service installer. Users do not run regional deployment commands or copy origin URLs.

The root launches in us-east-1 and coordinates selected commercial ingestion regions. It defaults to a single us-east-1 ingestion origin. At least one region is required. The current guided DNS flow requires a first-party hostname and an existing public Route53 hosted zone in the same account. Keep production and non-production installations in separate accounts where possible.

## Test environments

`Stage` accepts `dev`, `test` and `prod`. Deploy test as a separate root installation, with its own account where possible, deployment ID, endpoint, regional buckets and quotas. One us-east-1 origin is enabled by default. `RetentionDays=0` selects seven days for test or 365 for dev/prod; `LogRetentionDays=0` selects seven days for managed regional and lookup logs in test, or 30 for dev/prod; edge-created groups need their own retention policy. Explicit supported values override these defaults. Existing parameter values are preserved on ordinary stack updates unless explicitly changed.

Set the SDK client’s `environment` to `test` and provide the test endpoint explicitly. All four SDKs use the same batching, retries and validation. Endpoint/environment/namespace-bound queues reject reuse for another scope; nonempty legacy unbound queues require draining or explicit migration. The environment label does not change or verify the endpoint and is not authentication. See the [test environment guide](test-environments.md), including the live synthetic-event checker that requires observing S3 arrival.

## Restricted accounts

Use `IamMode: preprovisioned` to bind existing platform-owned administration/execution, lookup, edge and regional ingestion/delivery roles, plus their expected boundary ARNs. Missing enabled-region inputs are rejected. The application stack creates no IAM roles/policies and never attaches or changes boundaries in this mode. Your platform must verify actual role trusts, identity policies and boundary attachments.

Use a delegated root CloudFormation service role for Marketplace launch. If launch permission is not delegated, your platform team conducts the Marketplace launch on your behalf. See [onboarding](onboarding.md) and [permissions boundaries](permissions-boundaries.md).

## Recommended defaults and controls

- Default to `USRegion=us-east-1` and `ResidencyMode=nearest`. CloudFront viewer coordinates select the nearest enabled origin. Missing location uses the default origin. Choose `fail_closed` explicitly only when country-group residency restrictions are required.
- Keep `CaptureIp=false`; explicitly decide whether coarse geographic enrichment is needed.
- Set exact browser origins; server-only producers can leave CORS origins empty. Do not embed secrets in parameters or event properties.
- Keep plugin namespace enforcement enabled and use an explicit namespace allowlist. Attach a separately versioned Context Layer in each enabled region when required.
- Coordinate Lambda reserved concurrency with account quotas, Firehose capacity and upstream burst behavior. Throttling/retries are not a durable producer queue or an exactly-once guarantee.
- The WAF IP rate limit defaults to 5000 requests per five minutes. Managed rule groups can reject bodies above 8192 bytes even though the ingestion contract allows up to 1 MiB and 500 events. Start with small batches and measure representative traffic.
- Configure alarms and inspect ingestion errors/throttles, Firehose delivery success/freshness and S3 arrival. HTTP 202 and stack completion do not establish completed delivery.

## SDK event IDs and replay

All SDKs assign a random UUID before enqueueing when `event_id` is omitted, then
persist the event snapshot. Supply an opaque application-outbox ID when replay
must retain the same logical identity across fresh producer calls. Explicit IDs
are limited to 128 UTF-8 bytes and must have no controls or surrounding whitespace;
the backend and SDKs reject invalid IDs. Omitted IDs still get a
request-local fallback on the backend, which cannot identify repeated requests.

Use `flush` or queue recovery for retries. The event snapshot stays unchanged.
Each retry round reuses identical serialized request bytes; a later round or
restart may rebuild the batch envelope and use a new `batch_id`. Event IDs stay
stable across those rounds. An ID is neither authentication nor server-side
idempotency: downstream deduplication remains customer-owned. See
[IDs and duplicate handling](scaling.md#ids-and-duplicate-handling).

## Service rate limits

The packaged root enables a customer-owned DynamoDB Global Table limiter after
WAF, authentication, payload validation and namespace authorization, before either
Firehose or Kinesis submission. Limits use fixed UTC minute windows and count
**requests**, not events: one batch of 25 events consumes one request. Separate
event and decoded request-body byte caps also apply. Adjacent windows can admit
up to two windows' quota near a boundary; this is not a rolling-window limit.

| Root parameter | Default | Scope per enabled region |
| --- | --- | --- |
| `RateLimitEnabled` | `true` | Enable admission checks and quota infrastructure |
| `RateLimitOwnerRegion` | Release-selected initial region | Enabled region owning the table; preserve across updates |
| `RateLimitUserQuota` | `{"requests":100,"events":50000,"bytes":104857600}` | Each verified session/subject or anonymous client SID |
| `RateLimitTenantQuota` | `{"requests":10000,"events":5000000,"bytes":10737418240}` | All authenticated identities in a tenant |
| `RateLimitAnonymousQuota` | `{"requests":1000,"events":500000,"bytes":1073741824}` | All anonymous traffic in the installation |
| `RateLimitTiers` | `{}` | Named overrides of the identity quota from verified auth context |
| `RateLimitFailureMode` | `closed` | `503` on limiter errors; explicit `open` permits unmetered delivery |

Each quota JSON object requires positive integer `requests`, `events` and `bytes`,
each at most 1,000,000,000,000. Tier maps permit at most 32 names, each 1–64 ASCII
letters, digits, underscores or hyphens. Invalid runtime policy fails startup.
Unknown tiers use the default identity quota. For example:

```json
{
  "RateLimitEnabled": "true",
  "RateLimitUserQuota": "{\"requests\":100,\"events\":50000,\"bytes\":104857600}",
  "RateLimitTiers": "{\"pro\":{\"requests\":1000,\"events\":500000,\"bytes\":1073741824}}",
  "RateLimitFailureMode": "closed"
}
```

For authenticated requests, the key uses verified `auth_context.session_id` when
present, falling back to verified `subject`. Tenant and subject scope the session
key; requests without either session or subject are rejected. Missing tenant
uses an installation scope. The JWT starter maps signed `sid` to `session_id`
and signed `rate_limit_tier` to the configured tier policy. Those claims must be
issuer-controlled. Event properties cannot raise quotas. The tenant ceiling
continues to apply across identities, sessions and tiers.

For anonymous traffic, `context.sid` (or legacy top-level `sid`) selects an
additional best-effort identity bucket using the default user quota. All four
SDKs generate a client UUID when no explicit SID is supplied, keep it stable for
that client instance, and persist it with queued events. A new client instance
gets a new ID for new events. These IDs are not authentication: callers can
rotate them, so every anonymous request also consumes the shared anonymous
quota. Requests without a SID use only that shared quota. IP addresses do not
identify users at this layer; WAF retains its coarse IP protection. An anonymous
batch may contain at most 99 distinct SIDs; each distinct SID consumes one
request, while the shared pool consumes one request for the entire batch. Each
SID is charged its event count and the whole decoded batch's byte count.
For server-side producers, pass the request's non-secret analytics session ID in
`track({name: "page_view", sid: requestSessionId})` rather than sharing one default
SID across unrelated users. Share that client only within one endpoint, verified
tenant and authentication identity; different credentials need separate queues
because authentication is resolved per batch. An override affects only its event; authenticated
quota selection still uses the Context Layer’s verified identity. SID is not an event
ID or an authorization credential. See [SDK session planning](scaling.md#sdk-sessions-and-service-rate-limits).

A single regional DynamoDB transaction reserves all applicable counters, so a
rejected tenant/session reservation does not partially charge another counter.
Exhaustion rejects the whole batch with `429` and `Retry-After` until the next
minute. Limiter outages return `503` with `Retry-After: 1` by default. The SDKs
retain failed batches and retry according to their delivery contract; they do not
yet honor `Retry-After` and instead use their configured backoff/recovery interval. Admission
is charged before delivery and is not refunded after delivery failure; client
retries consume fresh admissions. A timed-out transaction can have committed.
SDK transport retries reuse the DynamoDB transaction token.

The Global Table has replicas **only in enabled ingestion regions**, eventual
consistency, on-demand capacity, encryption and TTL cleanup. Counter keys include
the source region, so independent regions never compete on the same admission
counter. A 100 RPM policy therefore permits 100 RPM in each enabled region,
not 100 RPM globally. Replication provides copies of counters, not automatic
cross-region quota aggregation or quota continuity after regional rerouting.
Only hashed identity keys, region/window identifiers, counts and expiry are
stored; no event payload or raw SID is stored in the quota table. These metadata
copies cross the enabled regions and add replication/write charges. TTL is
cleanup only; the window in the key determines expiration of the quota.

One regional stack owns the Global Table, selected by `RateLimitOwnerRegion`.
The default matches the release's initially enabled region. If choosing different
regions during installation, select an enabled region as owner. The root rejects
an owner that is not enabled. Preserve this parameter when adding replicas;
changing/removing the owner requires a reviewed table ownership migration. Apply replica additions/removals as reviewed deployment
changes; no replicas are created in disabled regions. The table contains only
ephemeral quota state and is deleted when its owning resource is removed.

Monitor `RateLimitLimited`, `RateLimitUnavailable` and `RateLimitBypassed` in
`Eventing/<DeploymentId>/<Stage>`. Outage and bypass alarms use the regional
alarm topic when configured. Runtime roles require only scoped
`dynamodb:UpdateItem` transaction permissions on their local quota replica and
region-prefixed keys. Customer-managed roles/boundaries must add those grants
before enabling admission quotas. See [permissions boundaries](permissions-boundaries.md).

## Updates and ownership

Update the existing coordinated deployment through the Marketplace offering’s approved update workflow. Do not independently modify its managed children. Bind regional layer/key/topic ARNs from their platform resources. Treat IAM mode, installation identity and enabled-region changes as reviewed migrations. Stop producers and drain delivery buffers before removal; retained S3 objects and edge replicas require lifecycle review.

Public JSON files describe the supported customer contract. Always review the actual approved release/change set and your account policies before deployment; these references do not perform live IAM verification.

## Capacity and configured delivery paths

See the [capacity and delivery guide](scaling.md) for monthly-request planning examples, the measured internal dev baseline, auth overhead and stable event IDs. The default path is Lambda → Firehose → S3; retained-stream mode adds Kinesis before Firehose.

## Optional retained stream

Firehose is the default (`IngestionMode=direct`). Select `IngestionMode=kinesis` for Lambda → Kinesis Data Streams → Firehose → S3. Configure retention (24–8760 hours, default 24), on-demand Standard or provisioned capacity, initial provisioned shard count and optional enhanced shard monitoring through coordinated IaC. See the [delivery options comparison](scaling.md#delivery-options) for settings, costs, migration and recovery limits. Test actual S3 arrival and recovery in your test installation before production rollout.

## Context Layer configuration

Use an immutable regional `EUContextPluginLayerArn`, `USContextPluginLayerArn`, `APACContextPluginLayerArn`, `Additional1ContextPluginLayerArn` or `Additional2ContextPluginLayerArn` to enable the version 2 Context Layer. It may authenticate, enrich shared request context and replace event names/properties/context. Standalone regional stacks use `ContextPluginLayerArn` and `ContextPluginEnabled=true`. `ContextPluginPassClientMetadata` controls ephemeral source IP/coarse geo independently of persisted enrichment flags.

Validation runs again after mutations, before namespace authorization, quota admission and delivery. IDs, timestamps and producer SIDs remain immutable. General request context is stored under `request_context`; only `auth_context` supplies verified identity and rate tiers. See the [Context Layer contract and starters](auth-layer.md) for limits, replacement semantics, deterministic retries, enrichment/redaction and JWT authentication examples.

## Supported ingestion regions

The configured release catalog supports the standard commercial AWS regions listed below. The five core regions are the recommended coverage set; Tokyo and Sydney are additional supported choices. Each installation can enable **up to five distinct regions**, with only **us-east-1 enabled by default**. The allowed values in your approved Marketplace release determine the choices available to that installation.

| Region code | AWS location | Coverage |
| --- | --- | --- |
| `us-east-1` | US East (N. Virginia) | Core; default origin |
| `us-west-2` | US West (Oregon) | Core |
| `eu-west-1` | Europe (Ireland) | Core |
| `eu-central-1` | Europe (Frankfurt) | Core |
| `ap-southeast-1` | Asia Pacific (Singapore) | Core |
| `ap-southeast-2` | Asia Pacific (Sydney) | Additional |
| `ap-northeast-1` | Asia Pacific (Tokyo) | Additional |

`USRegion` offers Northern Virginia or Oregon; `EURegion` offers Ireland or Frankfurt; `APACRegion` offers Singapore, Sydney or Tokyo. Each main slot selects one origin. `Additional1Region` and `Additional2Region` can select any region in the catalog, so an installation can enable both US regions or both European regions. A region must occupy only one slot.

`us-west-1` (N. California) and `us-east-2` (Ohio) are recognized by the router but are **not in the configured release catalog**. They are not currently selectable in that catalog; adding them requires a release containing their regional artifacts. There is no AWS region named `us-central`. GovCloud, China and other commercial AWS regions are not supported by this catalog. The global control/edge stack always launches in `us-east-1`, independently of which ingestion origins are enabled.

## Dynamic geographic routing

Start with the default origin and add locations from the supported catalog as your traffic warrants. The core coverage set is a coverage choice, not a popularity ranking.

`ResidencyMode=nearest` ranks enabled origins by great-circle geographic distance using CloudFront's approximate viewer latitude/longitude. It does not use fixed country-to-region lists. With one enabled origin, every request uses it. Add a western US origin and western viewers use that origin; add another supported origin and nearby viewers move there automatically. Removed origins stop participating after the coordinated update propagates. There are no manually maintained geographic groups for nearest mode.

Each enabled ingestion region has its own customer-owned S3 bucket and regional Firehose delivery stream. A routed request is ingested in the selected region and its events are delivered to that region’s bucket, either directly through Firehose or through the optional Kinesis → Firehose path. For example, a request routed to `eu-west-1` lands in the Ireland bucket; one routed to `us-east-1` lands in the Northern Virginia bucket. The default origin is a routing fallback, not a central storage destination.

The package does not configure cross-region S3 replication or a consolidated event bucket. Query or aggregate across the regional buckets in your downstream pipeline when needed. Adding or removing origins changes routing for future requests after propagation; it does not move or merge historical objects. Removed regional stacks retain their buckets, with configured lifecycle expiration still applying.

Use `USRegion`, `EURegion`, `APACRegion`, `Additional1Region` and `Additional2Region` to select up to five distinct enabled origins. The two additional slots can be in the same geography as an existing slot, including both supported US regions. Only regions whose immutable runtime artifacts are present in the approved release are selectable; newly supported locations require a seller release before buyers enable them. Each slot has corresponding layer, KMS, topic and platform-role parameters. Duplicate region selections are rejected.

```json
{
  "USRegion": "us-east-1",
  "EURegion": "",
  "APACRegion": "",
  "Additional1Region": "us-west-2",
  "Additional2Region": "",
  "ResidencyMode": "nearest",
  "RateLimitOwnerRegion": "us-east-1"
}
```

With unavailable or invalid viewer coordinates, the router uses `us-east-1` when enabled; otherwise it uses the configured primary enabled origin. It never sends to a disabled region. Exact coordinates are removed before forwarding to ingestion and are not persisted as event enrichment.

Geographic distance is an estimate, not measured latency or health-based failover. The edge does not automatically replay failed ingestion requests to another origin. Origin outages can still return CloudFront errors; producers retain IDs and retry through their queues. Use explicit `fail_closed` for the legacy EU/US/APAC country-group policy, or `default_fallback` for its primary-origin fallback. Additional slots participate in nearest mode, not in legacy country-group mappings. Switching an existing strict-residency installation to nearest changes which enabled region may receive data and should be an explicit configuration update.

Adding/removing an origin updates the router fingerprint, publishes a new immutable edge version and changes distribution permissions. Quota-table replicas follow enabled origins, while admission keys remain per region. Keep `RateLimitOwnerRegion` stable and enabled during expansion. Drain producers and delivery buffers before region removal. See [CloudFront geolocation headers](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/adding-cloudfront-headers.html).
