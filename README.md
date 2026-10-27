# Eventing examples

Public customer examples for [Eventing by Bookcicle](https://eventing.bookcicle.com).
No access to the service implementation repository is required.

- [Guided onboarding](docs/onboarding.md), including Marketplace launch with platform-owned roles for restricted accounts.
- [Configuration reference](docs/configuration.md), [capacity and delivery guide](docs/scaling.md), and [platform IAM guidance](docs/permissions-boundaries.md).
- [Build a Context Layer](docs/auth-layer.md): event transformations, enrichment, redaction and JWT/JWKS authentication.
- [JavaScript, Python, Rust and Java SDK guide](https://eventing.bookcicle.com/#guides-sdk), plus [low-level HTTP producer fixtures](docs/runtime-examples.md).
- JavaScript client sources in `sdk/js`; public Context Layer wire types in `crates/eventing-contract`.

Deploy the service using the version-pinned release supplied through your subscribed Marketplace offering. This repository is a supporting examples project, not a service installer. The sample MIT license covers this repository; it does not license or grant access to the Eventing service implementation.

## Local verification

Requires Rust, Python 3, Node.js, OpenSSL, Bash, curl and sha256sum. No AWS account is required for local tests.

```bash
cargo install cargo-audit
cargo audit
python3 scripts/generate-test-keys.py
cargo test --locked --workspace
cargo build --locked --workspace
python3 scripts/test-producers.py
npm --prefix sdk/js ci
npm --prefix sdk/js test
```

The key-generation script creates disposable signing keys locally, ignored by Git. Never use test keys or demo bearer tokens for real traffic. The JWT starter must be configured with your actual issuer, audience and trusted public JWKS.

For ARM64 Context Layer packaging, install cargo-zigbuild and Zig as described in the Context Layer walkthrough; run `scripts/build-auth-layer.sh context`, or `scripts/build-auth-layer.sh context-jwt /path/to/config-directory` for JWT authentication.
