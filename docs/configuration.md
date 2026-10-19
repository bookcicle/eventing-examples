# Eventing configuration reference

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

## Capacity and optional durable ingestion

See the [capacity and delivery guide](scaling.md) for monthly-request planning examples, the measured internal dev baseline, auth-layer overhead, stable IDs and opt-in Kinesis buffering. `IngestionMode` defaults to `direct`; `kinesis` adds a retained encrypted buffer and separate AWS charges. Select the mode at installation creation; mode changes require a reviewed migration.
