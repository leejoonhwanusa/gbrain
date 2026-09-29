#!/usr/bin/env bash
# Prove the configured detector is active and fixture exceptions stay narrow.
set -euo pipefail
repo_root=$(cd "$(dirname "$0")/.." && pwd)
fixture_root=$(mktemp -d)
trap 'rm -rf "$fixture_root"' EXIT
mkdir -p "$fixture_root/test"
cd "$fixture_root"
printf "const clientSecret = '%s%s';\n" 'gbrain_cs_' 'secret456' > "$fixture_root/test/auth-register-client-output-pin.test.ts"
gitleaks dir . --config "$repo_root/.gitleaks.toml" --redact --no-banner --log-level error
if command -v python3 >/dev/null 2>&1; then
  PYTHON_COMMAND=python3
elif command -v python >/dev/null 2>&1; then
  PYTHON_COMMAND=python
else
  echo "ERROR: Python 3 (python3 or python) is required for gitleaks config checks." >&2
  exit 1
fi

if ! "$PYTHON_COMMAND" -c 'import sys; raise SystemExit(sys.version_info.major != 3)' >/dev/null 2>&1; then
  echo "ERROR: $PYTHON_COMMAND must be Python 3 for gitleaks config checks." >&2
  exit 1
fi

"$PYTHON_COMMAND" - "$fixture_root/test/auth-register-client-output-pin.test.ts" <<'PY'
import hashlib, sys
with open(sys.argv[1], 'a') as fixture:
    fixture.write('const api_key = "' + hashlib.sha256(b'synthetic-gitleaks-canary').hexdigest() + '";\n')
PY
set +e
gitleaks dir . --config "$repo_root/.gitleaks.toml" --redact --no-banner --log-level error
result=$?
set -e
if [ "$result" -ne 1 ]; then
  echo "gitleaks configuration failed its synthetic detection canary (exit $result)" >&2
  exit 1
fi
echo "gitleaks configuration: fixture accepted; independent synthetic secret detected"
