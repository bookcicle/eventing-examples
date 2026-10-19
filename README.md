# Eventing examples

Public customer examples for [Eventing by Bookcicle](https://eventing.bookcicle.com).
No access to the service implementation repository is required.

- [Guided onboarding](docs/onboarding.md), including Marketplace launch with platform-owned roles for restricted accounts.
- [Configuration reference](docs/configuration.md), [capacity and delivery guide](docs/scaling.md), and [platform IAM guidance](docs/permissions-boundaries.md).
- [Build an auth layer](docs/auth-layer.md): local demo and a separate JWT/JWKS starter.
- [Python, Rust and curl producers](docs/runtime-examples.md).
- Browser SDK in `sdk/js`; public wire types in `crates/eventing-contract`.

Deploy the service using the version-pinned release supplied through your subscribed Marketplace offering. This repository is a supporting examples project, not a service installer. The sample MIT license covers this repository; it does not license or grant access to the Eventing service implementation.

## Local verification

Requires Rust, Python 3, Node.js, OpenSSL, Bash, curl and sha256sum. No AWS account is required for local tests.

```bash
python3 scripts/generate-test-keys.py
cargo test --locked --workspace
cargo build --locked --workspace
python3 scripts/test-auth-reference.py
python3 scripts/test-producers.py
node --test sdk/js/test/*.test.mjs
```

The key-generation script creates disposable signing keys locally, ignored by Git. Never use test keys or demo bearer tokens for real traffic. The JWT starter must be configured with your actual issuer, audience and trusted public JWKS.

For ARM64 layer packaging, install cargo-zigbuild and Zig as described in the auth walkthrough; run `scripts/build-auth-layer.sh demo` and `python3 scripts/test-layer-package.py`.
