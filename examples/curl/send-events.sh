#!/usr/bin/env bash
# Requires bash, curl, Python 3 and sha256sum. Token headers are supplied via stdin.
set -euo pipefail
cd "$(dirname "$0")/.."
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
python3 - "$work" <<'PY'
import sys, json, pathlib
sys.path.insert(0, str(pathlib.Path('python').resolve()))
from send_events import endpoint, make_batch
root=pathlib.Path(sys.argv[1])
root.joinpath('url').write_text(endpoint())
root.joinpath('batch.json').write_text(json.dumps(make_batch('curl'), separators=(',', ':')))
PY
endpoint=$(cat "$work/url")
hash=$(sha256sum "$work/batch.json" | cut -d ' ' -f 1)
for attempt in 0 1 2; do
  # Build curl config on stdin so credentials do not appear in process arguments.
  status=$(python3 - <<'PY' | curl --config - --silent --show-error --connect-timeout 2 --max-time 5 --request POST --header 'Content-Type: application/json' --header "x-amz-content-sha256: $hash" --data-binary "@$work/batch.json" --output "$work/response" --write-out '%{http_code}' "$endpoint"
import os, sys
value=os.environ.get('EVENTING_AUTH_TOKEN')
if value:
    if any(ord(c)<32 or ord(c)==127 for c in value):
        sys.exit('Invalid token characters')
    value=value.replace('\\','\\\\').replace('"','\\"')
    print('header = "x-event-auth: Bearer '+value+'"')
PY
) || status=000
  if [ "$status" = 202 ]; then
    echo 'Accepted 2 events by the ingestion pipeline (S3 delivery is asynchronous).'
    exit 0
  fi
  case "$status" in
    000|429|500|502|503|504) ;;
    *) echo "Eventing request failed: HTTP $status" >&2; exit 1 ;;
  esac
  if [ "$attempt" -eq 2 ]; then echo "Eventing request failed: HTTP $status after 3 attempts" >&2; exit 1; fi
  sleep "$((attempt + 1))"
done
