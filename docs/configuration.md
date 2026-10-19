# Eventing configuration reference

## Buffered delivery with selective retries

Eventing provides **buffered delivery with selective retries**, not guaranteed end-to-end delivery. There is no zero-loss, exactly-once or event-ordering guarantee.

- **HTTP 202 is stream acceptance.** In the published delivery path, all submitted records were acknowledged by Firehose. It does not confirm arrival in S3 or delivery to any downstream destination.
- **Retries are bounded.** The runtime selectively retries records explicitly reported as failed; it does not resend acknowledged records in those retries. The candidate implementation permits three application submission rounds; AWS SDK retries are separate. An API/transport error or exhausted retries returns HTTP 502. A failed request may already have accepted some records; a timeout can leave the outcome unknown.
- **Loss and duplicates remain possible.** Events that never reach ingestion, exhaust producer retries, or cannot be recovered before buffer retention expires can be lost. Client retries and uncertain write outcomes can produce duplicates. Preserve stable event IDs and deduplicate in the appropriate tenant/namespace scope. The service has no server-side deduplication store or guaranteed replay of rejected requests.
- **Recovery needs an owner.** Persist pending events in a durable producer queue when required. Monitor ingestion errors/throttles, delivery freshness, error prefixes and actual S3 arrival; investigate failures and reconcile expected IDs against stored records. Metrics alone do not prove every event arrived.
- **Buffering is not a delivery guarantee.** The published path is Lambda → Firehose → S3. Downstream filtering, forwarding, retries and destination acknowledgements are customer-owned.

Use the [complete public configuration guide](https://eventing.bookcicle.com/configuration) for recommended settings, exact WAF controls, region routing and scaling expectations. The machine-readable [configuration reference](../reference/configuration.json) lists the coordinated root parameters, advanced regional/edge parameters, defaults, validation constraints, environment mappings, WAF rules and residency country groups.

## Deploy through AWS Marketplace

Subscribe through AWS Marketplace and use the product's Configure and launch flow. Marketplace supplies the versioned infrastructure package. The examples repository is not a service installer. Users do not run regional deployment commands or copy origin URLs.

The root launches in us-east-1 and coordinates selected commercial EU, US and APAC regions. At least one region is required. The current guided DNS flow requires a first-party hostname and an existing public Route53 hosted zone in the same account. Keep production and non-production installations in separate accounts where possible.

## Restricted accounts

Use `IamMode: preprovisioned` to bind existing platform-owned administration/execution, lookup, edge and regional ingestion/delivery roles, plus their expected boundary ARNs. Missing enabled-region inputs are rejected. The application stack creates no IAM roles/policies and never attaches or changes boundaries in this mode. Your platform must verify actual role trusts, identity policies and boundary attachments.

Use a delegated root CloudFormation service role for Marketplace launch. If launch permission is not delegated, your platform team conducts the Marketplace launch on your behalf. See [onboarding](onboarding.md) and [permissions boundaries](permissions-boundaries.md).

## Recommended defaults and controls

- Keep `ResidencyMode=fail_closed`. Unmapped or disabled country groups are rejected unless fallback has been explicitly authorized.
- Keep `CaptureIp=false`; explicitly decide whether coarse geographic enrichment is needed.
- Set exact browser origins; server-only producers can leave CORS origins empty. Do not embed secrets in parameters or event properties.
- Keep plugin namespace enforcement enabled and use an explicit namespace allowlist. Attach a separately versioned auth layer in each enabled region when required.
- Coordinate Lambda reserved concurrency with account quotas, Firehose capacity and upstream burst behavior. Throttling/retries are not a durable producer queue or an exactly-once guarantee.
- The WAF IP rate limit defaults to 5000 requests per five minutes. Managed rule groups can reject bodies above 8192 bytes even though the ingestion contract allows up to 1 MiB and 500 events. Start with small batches and measure representative traffic.
- Configure alarms and inspect ingestion errors/throttles, Firehose delivery success/freshness and S3 arrival. HTTP 202 and stack completion do not establish completed delivery.

## Updates and ownership

Update the existing coordinated deployment through the Marketplace offering’s approved update workflow. Do not independently modify its managed children. Bind regional layer/key/topic ARNs from their platform resources. Treat IAM mode, installation identity and enabled-region changes as reviewed migrations. Stop producers and drain delivery buffers before removal; retained S3 objects and edge replicas require lifecycle review.

Public JSON files describe the supported customer contract. Always review the actual approved release/change set and your account policies before deployment; these references do not perform live IAM verification.

## Capacity and published delivery path

See the [capacity and delivery guide](scaling.md) for monthly-request planning examples, the measured internal dev baseline, auth overhead and stable event IDs. The published path is Lambda → Firehose → S3.

## Optional retained stream for the next release

Firehose is the default (`IngestionMode=direct`). The next release candidate also supports `IngestionMode=kinesis`: Lambda → Kinesis Data Streams → Firehose → S3. It is not part of published 0.1.4. Configure retention (24–8760 hours, default 24), on-demand Standard or provisioned capacity, initial provisioned shard count and optional enhanced shard monitoring through coordinated IaC. See the [delivery options comparison](scaling.md#delivery-options) for exact parameters, additional costs, migration and recovery limits. Dedicated-account acceptance and measured cost tests are pending; retained data does not establish guaranteed delivery.
