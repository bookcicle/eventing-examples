# Build an Eventing auth layer

Use the demo starter to learn the subprocess contract, then use the separate JWT/JWKS starter with your identity provider. Both run locally and package as an ARM64 Lambda Layer. The regional ingestion function launches `/opt/bin/event-auth` once per batch; this is a customer policy hook, not a separate network service.

## Run the demo locally

Use the public [eventing-examples repository](https://github.com/bookcicle/eventing-examples). From its root, with Rust, Python 3 and OpenSSL installed:

```bash
python3 scripts/generate-test-keys.py
cargo build --locked -p event-auth-reference
python3 scripts/test-auth-reference.py
target/debug/event-auth < examples/auth/fixtures/anonymous.request.json
target/debug/event-auth < examples/auth/fixtures/authenticated.request.json
target/debug/event-auth < examples/auth/fixtures/deny.request.json
```

The matching `.response.json` fixtures show the exact expected contract. No credential returns `anonymous`, with only `general`. `Bearer valid-claims-token` returns `authenticated` with a demo subject, tenant and email, allowing `general` and `claims`. `Bearer valid-security-token` allows `general`, `security` and `claims`. An unrecognized token, malformed JSON, unsupported contract version or input larger than 256 KiB returns `deny`. These hardcoded credentials are public teaching fixtures: use only synthetic data in an isolated development deployment.

```json
{
  "contract_version": "1",
  "decision": "authenticated",
  "context": {"subject": "employee_123", "tenant": "claims", "email": "adjuster@customer.example"},
  "allowed_namespaces": ["general", "claims"]
}
```

The header is **`x-event-auth: Bearer <token>`**, not the Authorization header used by CloudFront's origin access signing. The runtime supplies request ID, method, path, normalized headers and a batch summary on stdin. Write one JSON result to stdout; send only sanitized diagnostics to stderr. Never echo credentials or raw payloads. The runtime limits auth stdout to 64 KiB and its default subprocess deadline is 1500 ms.

## Route and namespace behavior

`/events` accepts either anonymous or authenticated decisions. `/public` requires anonymous; a valid authenticated credential is rejected there. `/secure` requires authenticated. A deny decision rejects all three. The plugin's namespace list is additionally constrained by the regional deployment's `AllowedNamespaces` and `AnonymousAllowedNamespaces`; it cannot grant an undeclared namespace. Keep `EnforcePluginNamespaceAuth=true`.

The plugin shares the ingestion function's process environment, filesystem and IAM role. A layer is trusted deployment code, not a sandbox or a way to isolate third-party code. Keep its permissions minimal and validate its output through the runtime contract. Client metadata is omitted unless `AuthPluginPassClientMetadata=true`; enable it only for a policy that requires it.

The complete [demo source](https://github.com/bookcicle/eventing-examples/tree/main/crates/event-auth-reference), [contract types](https://github.com/bookcicle/eventing-examples/tree/main/crates/eventing-contract), fixtures and packaging scripts are available in that public project. No service-source checkout is required.

## Build a Lambda Layer ZIP

Install Rust, the `aarch64-unknown-linux-gnu` target, [cargo-zigbuild](https://github.com/rust-cross/cargo-zigbuild) and [Zig](https://ziglang.org/download/). The build pins glibc 2.34 for the `provided.al2023` runtime:

```bash
rustup target add aarch64-unknown-linux-gnu
cargo install --locked cargo-zigbuild
scripts/build-auth-layer.sh demo
python3 scripts/test-layer-package.py
unzip -l target/layers/event-auth-demo.zip
```

The ZIP contains an executable `bin/event-auth` with mode 0755. The packager checks the binary is ELF64 ARM64, rejects an x86 binary, and includes no development private keys. For CI, preserve the checked-in Cargo lockfile and pin the Rust/Zig toolchain versions used by your build image.

## Attach through your IaC workflow

Customers launch Eventing through [guided onboarding](onboarding.md), or consume the same root template in their existing infrastructure pipeline. The local build commands above create a developer artifact; they are not the buyer provisioning flow.

Declare the custom layer as `AWS::Lambda::LayerVersion` (or the equivalent CDK/Terraform resource) in your application's regional infrastructure. Bind the layer ZIP asset through that pipeline, use `arm64` and `provided.al2023`, and pass the resulting immutable version ARN automatically into the coordinated Eventing root parameters:

```json
{
  "EUAuthPluginLayerArn": "arn:aws:lambda:eu-west-1:111122223333:layer:eventing-auth-jwt:3",
  "EnforcePluginNamespaceAuth": "true"
}
```

The ARN above illustrates the parameter's value; your IaC tool should bind it from the layer resource output rather than asking an operator to copy it. Use `USAuthPluginLayerArn` and `APACAuthPluginLayerArn` for their corresponding regions. A nonempty regional layer ARN enables the plugin for that region automatically. Never pass the same regional layer ARN to another region.

Review the root change set and promote the layer version through the same infrastructure workflow. For existing independently managed regional templates, the equivalent advanced parameters remain `AuthPluginLayerArn` and `AuthPluginEnabled`; the coordinated root supplies them for you. Disabling auth changes protected-route behavior and requires a deliberate reviewed configuration change.

## Browser SDK integration

Use your existing identity SDK to acquire an access token for the configured Eventing audience. Do not place client secrets in the browser. The Eventing client reads a fresh token at flush time and keeps it out of its persistent event queue:

```javascript
import { createEventingClient } from './sdk/js/src/index.js';

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

`identityClient` represents your application's existing identity integration. Return the raw access token; the SDK adds `Bearer`. Configure an explicit browser origin in `AllowedCorsOrigins`. Tokens belong in `x-event-auth`; cookie forwarding and cookie CORS are separate settings. See [runtime examples](runtime-examples.md) for Python, Rust and curl.

## JWT/JWKS identity-provider starter

The public [JWT/JWKS starter](https://github.com/bookcicle/eventing-examples/tree/main/crates/event-auth-jwt) is a separate executable with no demo-token bypass. It validates RS256 signatures, the configured issuer and audience, required expiration and subject, and `nbf` when present, using 30 seconds of clock leeway. The token must have a `kid` matching exactly one configured RSA signing key and a `tenant` claim present in your operator-maintained namespace policy. It returns only the verified subject and tenant; arbitrary JWT claims cannot grant namespaces.

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
EVENT_AUTH_CONFIG=/tmp/eventing-jwt-config/config.json \
  target/debug/event-auth-jwt < examples/auth/fixtures/anonymous.request.json
scripts/build-auth-layer.sh jwt /tmp/eventing-jwt-config
unzip -l target/layers/event-auth-jwt.zip
```

The JWT ZIP contains `bin/event-auth`, `event-auth/config.json` and `event-auth/jwks.json`. Declare that ZIP in your regional layer resource and promote its version through the IaC workflow above. The default config path inside Lambda is `/opt/event-auth/config.json`; no extra runtime variable is necessary. The package script rejects private and symmetric JWK material. No signing private key belongs in the verifier layer.

## Key rotation and operational checks

This starter deliberately verifies against bundled public keys; it does not fetch a URL selected by token headers or perform a network request per batch. Add the next trusted public key alongside the old key, publish a new immutable layer version, update every regional stack, and verify new tokens before your provider switches signing keys. Remove the old key after all tokens signed with it have expired plus clock leeway. Monitor identity-provider rotation announcements and failed-auth metrics; an unknown key is denied until the layer is updated. Use your provider's trusted JWKS URL during this deployment workflow, never a token's `jku` or embedded `jwk`.

Tests cover signatures, issuer/audience, expiration, future `nbf`, required claims, algorithm confusion, unknown/duplicate key IDs, malformed credentials, anonymous policy and operator-controlled namespaces. The checked-in private test key is disposable test data and is never included by the packaging script. Configure a tenant claim minted by your trusted issuer, not an unvalidated user-editable profile field. Add revocation/session checks if your policy requires immediate revocation; offline JWT verification accepts otherwise valid tokens until expiration.
