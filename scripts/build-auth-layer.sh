#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
variant="${1:-demo}"
case "$variant" in
  demo) package=event-auth-reference; binary=event-auth ;;
  jwt) package=event-auth-jwt; binary=event-auth-jwt ;;
  *) echo 'Usage: scripts/build-auth-layer.sh [demo|jwt] [JWT-config-directory]' >&2; exit 2 ;;
esac
args=()
if [ "$variant" = jwt ]; then
  : "${2:?Supply a directory containing your config.json and public jwks.json}"
  args=(--config-dir "$2")
fi
# cargo-zigbuild and Zig provide a cross linker without requiring Docker.
# Pin glibc 2.34 for the Amazon Linux 2023 provided.al2023 runtime.
cargo zigbuild --locked --release --target aarch64-unknown-linux-gnu.2.34 -p "$package" --bin "$binary"
python3 scripts/package-auth-layer.py "target/aarch64-unknown-linux-gnu/release/$binary" "target/layers/event-auth-$variant.zip" "${args[@]}"
