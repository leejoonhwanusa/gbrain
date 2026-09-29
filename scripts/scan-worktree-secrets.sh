#!/usr/bin/env bash
# Scan all tracked files and new files eligible for commit. Local ignored
# credentials are not publishable inputs; tracked files are always included,
# even if a later .gitignore rule would otherwise hide them.
set -euo pipefail
cd "$(dirname "$0")/.."
if command -v python3 >/dev/null 2>&1; then
  PYTHON_COMMAND=python3
elif command -v python >/dev/null 2>&1; then
  PYTHON_COMMAND=python
else
  echo "ERROR: Python 3 (python3 or python) is required for the worktree secret scan." >&2
  exit 1
fi

if ! "$PYTHON_COMMAND" -c 'import sys; raise SystemExit(sys.version_info.major != 3)' >/dev/null 2>&1; then
  echo "ERROR: $PYTHON_COMMAND must be Python 3 for the worktree secret scan." >&2
  exit 1
fi

"$PYTHON_COMMAND" - <<'PY'
import os, pathlib, shutil, subprocess, tempfile
root = pathlib.Path.cwd()
paths = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard']).split(b'\0')
with tempfile.TemporaryDirectory(prefix='gbrain-secrets-') as directory:
    dest = pathlib.Path(directory)
    for raw in set(paths):
        if not raw:
            continue
        relative = pathlib.Path(os.fsdecode(raw))
        source = root / relative
        if not source.is_file():
            continue  # Deleted files and submodules are covered by the Git scan.
        target = dest / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    subprocess.run(['gitleaks', 'dir', '.', '--config', str(root / '.gitleaks.toml'),
                    '--redact', '--no-banner'], cwd=dest, check=True)
PY
