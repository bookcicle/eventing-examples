# Build an Eventing Context Layer

A Context Layer applies your application policy to each validated event batch: transform and normalize events, redact properties, enrich shared request context, verify identity and accept or reject requests. It runs inside ingestion as your trusted ARM64 Lambda Layer at `/opt/bin/event-context`. Choose the capabilities your application needs and compose them in one hook.

## Context Layer contract

Processing is **parse → Context Layer → validate mutations → authorize namespaces → rate limit → deliver**. The hook receives `contract_version: "2"`, request ID, path, method, permitted headers, the existing `batch` summary, `schema_version`, `batch_id`, and an `events` array containing the validated, sanitized event objects. Cookie and ephemeral client metadata forwarding remain opt-in. Only `x-event-auth` is forwarded as an application header.

Return one JSON object on stdout:

```json
{
  "contract_version": "2",
  "decision": "accept",
  "authentication": {
    "decision": "authenticated",
    "context": {"subject": "user-123", "tenant": "acme", "session_id": "verified-session", "rate_limit_tier": "pro"},
    "allowed_namespaces": ["general", "claims"]
  },
  "request_context": {"application": "checkout", "transformation_version": "redaction-v1"},
  "event_mutations": [{"index": 0, "properties": {"path": "/checkout", "redacted": true}}]
}
```

`decision` is required and is `accept` or `reject`. Rejection denies the entire batch with HTTP 403; there is no silent event dropping. Omit `authentication` for an anonymous request. Its decision uses the `anonymous`, `authenticated`, `deny` vocabulary and context allowlist. `/secure` still requires authenticated identity; `/public` still requires anonymous identity. General `request_context` is stored separately from `auth_context`, including for anonymous requests, and never grants namespaces, identity or quota tiers.

`event_mutations` is optional. Each entry targets a zero-based event `index`; duplicate or out-of-range indexes are rejected, even when event IDs repeat. Optional `name`, `properties` and `context` fields each replace that complete field. An empty properties object redacts all properties. Replacing properties also removes the legacy `props` alias. Copy context keys you need to preserve. An existing `context.sid` must remain exactly equal; adding, deleting or changing it is rejected. Top-level legacy SID, event ID, event time, batch identity and event count cannot be mutated. Unknown mutation fields and server-owned fields in replacement context are rejected.

Names, property count, JSON nesting and the complete transformed envelope's 1 MiB limit are checked again, followed by deployment namespace policy and authenticated namespace authorization. Anonymous quotas use the original producer SID; authenticated quotas use only verified authentication context. A transformed batch that fails these checks never reaches quota admission or delivery. Invalid hook output or execution returns HTTP 502. Admission or route denial returns HTTP 403.

Request context permits 16 keys, each 1–64 ASCII letters/digits/underscore/hyphen, with each serialized value at most 1 KiB. Context Layer stdin and stdout are each capped at 2 MiB. Public Rust wire types are available in the examples repository’s `eventing-contract::context_types` module. Execution has a 1500 ms default deadline, bounded stdout and concurrent stdin/stdout I/O. Stderr is discarded to avoid exposing customer payloads or credentials. Timeout, crash, malformed JSON and oversize output fail closed. The layer shares the ingestion function's environment, filesystem and IAM permissions; it is trusted deployment code, not a sandbox.

## Deploy a Context Layer

Use `EUContextPluginLayerArn`, `USContextPluginLayerArn`, `APACContextPluginLayerArn`, `Additional1ContextPluginLayerArn` or `Additional2ContextPluginLayerArn` in the coordinated stack. Each must point to an immutable ARM64 layer version in that enabled region, containing executable `bin/event-context`. The coordinated stack enables version 2 automatically. Standalone regional stacks use `ContextPluginLayerArn` and `ContextPluginEnabled=true`. Set `ContextPluginPassClientMetadata=true` only if your policy requires ephemeral source IP and coarse geo.

Runtime overrides are `CONTEXT_PLUGIN_ENABLED`, `CONTEXT_PLUGIN_PATH`, `CONTEXT_PLUGIN_TIMEOUT_MS`, `CONTEXT_PLUGIN_PASS_CLIENT_METADATA` and `CONTEXT_PLUGIN_CONTRACT_VERSION`. Use contract version `2`.

## Enrichment and redaction starter

From the public [eventing-examples repository](https://github.com/bookcicle/eventing-examples) root, build and run the transformation starter:

```bash
cargo build --locked -p event-context-reference
target/debug/event-context < examples/context/fixtures/anonymous.request.json
scripts/build-auth-layer.sh context
```

The canonical request fixture uses contract version 2. The starter adds application and transformation-version request context, removes top-level `email` and `phone` properties, and adds `processed_by`. It is anonymous and does not verify credentials. Adapt the example policy to your event schema; nested property redaction needs your explicit schema-aware transformation.

## Authentication starter

Use the JWT/JWKS starter to apply authentication within your Context Layer. It returns verified identity under `authentication`, separately from request enrichment and event transformations. Build with `scripts/build-auth-layer.sh context-jwt /path/to/config-directory` to package the executable as `bin/event-context`. Compose authentication with schema-specific enrichment and redaction when your application needs both.

## Retries and deterministic transformations

Producer event snapshots remain unchanged in SDK queues. A Context Layer may run again when an HTTP request is retried. Preserve event IDs, use deterministic transformations and record a transformation version in request context. Avoid a random value or current time in a transformation intended to produce the same stored payload for the same ID. Downstream duplicate handling must define retention and conflicting-payload policy; the layer adds no exactly-once guarantee.

## Route and namespace behavior

`/events` accepts either anonymous or authenticated decisions. `/public` requires anonymous; a valid authenticated credential is rejected there. `/secure` requires authenticated. A deny decision rejects all three. The Context Layer's verified namespace list is additionally constrained by the regional deployment's `AllowedNamespaces` and `AnonymousAllowedNamespaces`; it cannot grant an undeclared namespace. Keep `EnforcePluginNamespaceAuth=true`.

The Context Layer shares the ingestion function's process environment, filesystem and IAM role. A layer is trusted deployment code, not a sandbox or a way to isolate third-party code. Keep its permissions minimal and validate its output through the runtime contract. Client metadata is omitted unless `ContextPluginPassClientMetadata=true`; enable it only for a policy that requires it.

The complete [transformation starter](https://github.com/bookcicle/eventing-examples/tree/main/crates/event-context-reference), [contract types](https://github.com/bookcicle/eventing-examples/tree/main/crates/eventing-contract), fixtures and packaging scripts are available in that public project. No service-source checkout is required.

## Build a Lambda Layer ZIP

Install Rust, the `aarch64-unknown-linux-gnu` target, [cargo-zigbuild](https://github.com/rust-cross/cargo-zigbuild) and [Zig](https://ziglang.org/download/). The build pins glibc 2.34 for the `provided.al2023` runtime:

```bash
rustup target add aarch64-unknown-linux-gnu
cargo install --locked cargo-zigbuild
scripts/build-auth-layer.sh context
unzip -l target/layers/event-context.zip
```

The ZIP contains an executable `bin/event-context` with mode 0755. The packager checks the binary is ELF64 ARM64, rejects an x86 binary, and includes no development private keys. For CI, preserve the checked-in Cargo lockfile and pin the Rust/Zig toolchain versions used by your build image.

## Publish your layer and configure Marketplace launch

Customers launch Eventing through AWS Marketplace using [guided onboarding](onboarding.md). The local build commands above create a developer artifact; they are not the buyer provisioning flow.

Declare the custom layer as `AWS::Lambda::LayerVersion` (or the equivalent CDK/Terraform resource) in your application's regional infrastructure. Bind the layer ZIP asset through that pipeline, use `arm64` and `provided.al2023`, and supply the resulting immutable version ARN in the Marketplace deployment settings:

```json
{
  "EUContextPluginLayerArn": "arn:aws:lambda:eu-west-1:111122223333:layer:eventing-context:3",
  "EnforcePluginNamespaceAuth": "true"
}
```

The ARN above illustrates the parameter's value; your IaC tool should bind it from the layer resource output rather than asking an operator to copy it. Use `USContextPluginLayerArn`, `APACContextPluginLayerArn`, `Additional1ContextPluginLayerArn` and `Additional2ContextPluginLayerArn` for their corresponding regions. A nonempty regional layer ARN enables the plugin for that region automatically. Never pass the same regional layer ARN to another region.

Review the root change set and promote the layer version through the same infrastructure workflow. Standalone regional templates use `ContextPluginLayerArn` and `ContextPluginEnabled`; the coordinated root supplies them for you. Review transformations and authentication policy together when promoting a layer version.

## Browser SDK integration

Use your existing identity SDK to acquire an access token for the configured Eventing audience. Do not place client secrets in the browser. The Eventing client reads a fresh token at flush time and keeps it out of its persistent event queue:

```javascript
import { createEventingClient } from '@bookcicle/eventing-sdk';

const events = createEventingClient({
  endpoint: 'https://events.example.com/secure',
  getAuthToken: async () => identityClient.getAccessToken()
});
await events.track({
  name: 'document_opened',
  properties: { document_type: 'invoice' },
  context: { namespace: 'claims' }
});
await events.flush();
```

`identityClient` represents your application's existing identity integration. Return the raw access token; the SDK adds `Bearer`. Configure an explicit browser origin in `AllowedCorsOrigins`. Tokens belong in `x-event-auth`; cookie forwarding and cookie CORS are separate settings. See the [SDK tabs](https://eventing.bookcicle.com/#guides-sdk) for Python, Rust, Java and curl.

## JWT/JWKS identity-provider starter

The public [JWT/JWKS starter](https://github.com/bookcicle/eventing-examples/tree/main/crates/event-auth-jwt) is a separate executable with no demo-token bypass. It validates RS256 signatures, the configured issuer and audience, required expiration and subject, and `nbf` when present, using 30 seconds of clock leeway. The token must have a `kid` matching exactly one configured RSA signing key and a `tenant` claim present in your operator-maintained namespace policy. It returns the verified subject and tenant, and optionally maps signed `sid` to `session_id` and signed `rate_limit_tier` to a configured rate-limit policy; arbitrary JWT claims cannot grant namespaces.

```bash
cargo test --locked -p event-auth-jwt
cargo build --locked -p event-auth-jwt
mkdir -p /tmp/eventing-jwt-config
cp examples/jwt/config.example.json /tmp/eventing-jwt-config/config.json
```

Edit `config.json` to use your issuer's exact HTTPS issuer URL, the intended access-token audience, and your tenant-to-namespace mapping. Obtain the **public** JWKS from your provider's trusted discovery configuration, verify its issuer and source, and save it as `/tmp/eventing-jwt-config/jwks.json`. Do not use the test fixtures as production keys. Providers with other algorithms or claim conventions need an explicit policy adaptation and tests.

```json
{
  "issuer": "https://identity.example.com/",
  "audience": "https://events.example.com",
  "jwks_file": "jwks.json",
  "anonymous_namespaces": ["general"],
  "tenant_namespaces": {"claims": ["general", "claims"]}
}
```

Set `anonymous_namespaces` to `[]` to deny requests without credentials. A present but empty or malformed credential is denied; it never downgrades to anonymous. Missing configuration, missing keys, unknown or duplicate `kid`, wrong algorithm/signature, expired/future tokens and unknown tenants fail closed.

```bash
scripts/build-auth-layer.sh context-jwt /tmp/eventing-jwt-config
unzip -l target/layers/event-context-jwt.zip
EVENT_CONTEXT_CONFIG=/tmp/eventing-jwt-config/config.json \
  target/debug/event-auth-jwt < examples/context/fixtures/anonymous.request.json
```

The JWT Context Layer ZIP contains `bin/event-context`, `event-context/config.json` and `event-context/jwks.json`. Declare that ZIP in your regional layer resource and promote its version through the IaC workflow above. The default config path inside Lambda is `/opt/event-context/config.json`; no extra runtime variable is necessary. For local execution, set `EVENT_CONTEXT_CONFIG` to the configuration file. The starter accepts only the version 2 Context Layer request and always returns version 2 output, including rejection paths. The package script rejects private and symmetric JWK material. No signing private key belongs in the verifier layer.

## Key rotation and operational checks

This starter deliberately verifies against bundled public keys; it does not fetch a URL selected by token headers or perform a network request per batch. Add the next trusted public key alongside the old key, publish a new immutable layer version, update every regional stack, and verify new tokens before your provider switches signing keys. Remove the old key after all tokens signed with it have expired plus clock leeway. Monitor identity-provider rotation announcements and failed-auth metrics; an unknown key is denied until the layer is updated. Use your provider's trusted JWKS URL during this deployment workflow, never a token's `jku` or embedded `jwk`.

Tests cover signatures, issuer/audience, expiration, future `nbf`, required claims, algorithm confusion, unknown/duplicate key IDs, malformed credentials, anonymous policy and operator-controlled namespaces. The checked-in private test key is disposable test data and is never included by the packaging script. Configure a tenant claim minted by your trusted issuer, not an unvalidated user-editable profile field. Add revocation/session checks if your policy requires immediate revocation; offline JWT verification accepts otherwise valid tokens until expiration.

## Session and rate-limit policy context

The ingestion runtime accepts `session_id` and `rate_limit_tier` from the trusted
layer's authenticated context. The JWT starter forwards them from the validated
`sid` and `rate_limit_tier` claims. Their values must be nonempty strings up to
256 bytes without control characters. The issuer must control both claims;
user-editable profile fields must not grant a higher tier. The runtime maps a tier
name to customer-configured `RateLimitTiers`; the layer cannot supply an arbitrary
numeric allowance. Missing/unknown tiers use the default quota. Anonymous client
`context.sid` has a separate best-effort bucket and cannot select a higher tier.
See [service rate limits](configuration.md#service-rate-limits).
