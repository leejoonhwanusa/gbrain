#!/usr/bin/env bash
# CI guard: fail if any non-serial unit test file violates intra-process
# isolation rules. The v0.26.4 parallel runner loads multiple test files
# into one bun process per shard; module-level state (env vars, PGLite
# engines, mock.module overrides) leaks across files in that process and
# silently flakes other tests.
#
# Rules enforced (non-serial unit test files only):
#  R1: no `process.env.X = ...`, `process.env['X'] = ...`,
#      `delete process.env.X`, `Object.assign(process.env, ...)`,
#      `Reflect.set(process.env, ...)` mutations. Use withEnv() helper or
#      rename the file to `*.serial.test.ts`.
#  R2: no `mock.module(...)` anywhere. Top-level module mocks affect every
#      other file in the same shard process. Rename to `*.serial.test.ts`.
#  R3: `new PGLiteEngine(` may only appear within ~50 lines following a
#      `beforeAll(` line. Engines created at module scope (or in describe
#      bodies) leak across files in the shard process.
#  R4: any file that creates `new PGLiteEngine(` must call `.disconnect(`
#      inside an `afterAll(` block. Without disconnect, engines leak across
#      file boundaries within a shard process.
#
# Scope:
#  - Recursively scans `test/**/*.test.ts`.
#  - Skips `*.serial.test.ts` entirely (the quarantine escape hatch).
#  - Skips `test/e2e/**` (E2E runs sequentially in its own runner; not in
#    the parallel pool).
#
# Allow-list:
#  Files in `scripts/check-test-isolation.allowlist` (one filename per
#  line, # comments allowed) are skipped. This exists because v0.26.7
#  ships the lint as a foundation; v0.26.8 (env sweep) and v0.26.9
#  (PGLite sweep) remove entries as files get fixed. New files MUST NOT
#  be added — the allow-list shrinks over time, never grows.
#
# Usage: scripts/check-test-isolation.sh [TARGET_DIR]
# Exit:  0 when clean, 1 when un-allow-listed violations found.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

TARGET_DIR="${1:-test}"
ALLOWLIST_FILE="$ROOT/scripts/check-test-isolation.allowlist"

# Read allowlist (one filename per line, # comments allowed). Empty file
# is fine — every violation will fail. Cached into ALLOWLIST so the
# per-file check (~700 lookups per run) is one pure-bash `case` match.
ALLOWLIST=""
if [ -f "$ALLOWLIST_FILE" ]; then
  ALLOWLIST="$(grep -v '^[[:space:]]*#' "$ALLOWLIST_FILE" | grep -v '^[[:space:]]*$' || true)"
fi

is_allowlisted() {
  local f="$1"
  if [ -z "$ALLOWLIST" ]; then
    return 1
  fi
  # Use a pure-bash `case` whole-line match against the newline-delimited
  # allowlist instead of `echo | grep -qxF`. v0.41.8 CI flake (verify job
  # 77771356276): the grep pipe form occasionally failed to match the
  # first allowlist entry on Ubuntu 24.04 + bash 5 under
  # `bun run` + GNU `timeout` (couldn't reproduce on macOS bash 3.2 with
  # the same allowlist file content + lint script content + checkout
  # state). Pure-bash case is locale-free, pipe-free, subshell-free,
  # set-e-quirk-free, and ~100x faster on every call.
  case $'\n'"$ALLOWLIST"$'\n' in
    *$'\n'"$f"$'\n'*) return 0 ;;
  esac
  return 1
}

# Find non-serial unit test files (excluding test/e2e). Portable across
# bash 3.2 (macOS default) and bash 4+; no mapfile.
FILE_LIST="$(find "$TARGET_DIR" -name '*.test.ts' \
  -not -name '*.serial.test.ts' \
  -not -path "*/e2e/*" \
  -type f 2>/dev/null | sort)"

violations=0
file_count=0

emit_violation() {
  local f="$1" rule="$2" detail="$3" lines="$4"
  if is_allowlisted "$f"; then
    return
  fi
  echo "ERROR: $f"
  echo "       rule $rule: $detail"
  if [ -n "$lines" ]; then
    echo "$lines" | head -3 | sed 's/^/         /'
  fi
  violations=$((violations + 1))
}

ENV_MUTATION_RE='process\.env\.[A-Za-z_][A-Za-z_0-9]*[[:space:]]*=[^=]|process\.env\[[^]]+\][[:space:]]*=[^=]|delete[[:space:]]+process\.env\.|delete[[:space:]]+process\.env\[|Object\.assign[[:space:]]*\([[:space:]]*process\.env|Reflect\.set[[:space:]]*\([[:space:]]*process\.env'
MOCK_MODULE_RE='mock\.module[[:space:]]*\('
PGLITE_RE='new PGLiteEngine[[:space:]]*\('

file_count=$(printf '%s\n' "$FILE_LIST" | awk 'NF { n++ } END { print n + 0 }')

if command -v rg >/dev/null 2>&1; then
  # Fast path: one recursive search per rule finds candidates, then only the
  # small candidate set gets file-local detail checks. This avoids thousands
  # of grep/awk process launches on Windows while preserving every rule.
  ENV_FILES=$(rg -l -g '*.test.ts' -g '!*.serial.test.ts' -g '!**/e2e/**' "$ENV_MUTATION_RE" "$TARGET_DIR" 2>/dev/null || true)
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    f="${f//\\//}"
    env_lines=$(rg -n "$ENV_MUTATION_RE" "$f" 2>/dev/null || true)
    emit_violation "$f" "R1" "process.env mutation; use withEnv() or rename to *.serial.test.ts" "$env_lines"
  done <<< "$ENV_FILES"

  MOCK_FILES=$(rg -l -g '*.test.ts' -g '!*.serial.test.ts' -g '!**/e2e/**' "$MOCK_MODULE_RE" "$TARGET_DIR" 2>/dev/null || true)
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    f="${f//\\//}"
    mock_lines=$(rg -n "$MOCK_MODULE_RE" "$f" 2>/dev/null || true)
    emit_violation "$f" "R2" "mock.module() leaks across files in the shard process; rename to *.serial.test.ts" "$mock_lines"
  done <<< "$MOCK_FILES"

  PGLITE_FILES=$(rg -l -g '*.test.ts' -g '!*.serial.test.ts' -g '!**/e2e/**' "$PGLITE_RE" "$TARGET_DIR" 2>/dev/null || true)
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    f="${f//\\//}"
    bad=$(awk '
      BEGIN { last_before_all = -1000 }
      /beforeAll[[:space:]]*\(/ { last_before_all = NR }
      /new PGLiteEngine[[:space:]]*\(/ {
        if (NR - last_before_all > 50) printf "%d:%s\n", NR, $0
      }
    ' "$f" 2>/dev/null)
    if [ -n "$bad" ]; then
      emit_violation "$f" "R3" "new PGLiteEngine(...) outside beforeAll() context (>50 lines); move into beforeAll" "$bad"
    fi
    if ! grep -qE 'afterAll[[:space:]]*\(' "$f" 2>/dev/null \
       || ! grep -qE '\.disconnect[[:space:]]*\(' "$f" 2>/dev/null; then
      emit_violation "$f" "R4" "creates PGLiteEngine but missing afterAll(() => engine.disconnect()); engine leaks across files in the shard process" ""
    fi
  done <<< "$PGLITE_FILES"
else
  # Portable fallback for minimal environments without ripgrep.
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    env_lines=$(grep -nE "$ENV_MUTATION_RE" "$f" 2>/dev/null || true)
    if [ -n "$env_lines" ]; then
      emit_violation "$f" "R1" "process.env mutation; use withEnv() or rename to *.serial.test.ts" "$env_lines"
    fi
    mock_lines=$(grep -nE "$MOCK_MODULE_RE" "$f" 2>/dev/null || true)
    if [ -n "$mock_lines" ]; then
      emit_violation "$f" "R2" "mock.module() leaks across files in the shard process; rename to *.serial.test.ts" "$mock_lines"
    fi
    if grep -qE "$PGLITE_RE" "$f" 2>/dev/null; then
      bad=$(awk '
        BEGIN { last_before_all = -1000 }
        /beforeAll[[:space:]]*\(/ { last_before_all = NR }
        /new PGLiteEngine[[:space:]]*\(/ { if (NR - last_before_all > 50) printf "%d:%s\n", NR, $0 }
      ' "$f" 2>/dev/null)
      if [ -n "$bad" ]; then
        emit_violation "$f" "R3" "new PGLiteEngine(...) outside beforeAll() context (>50 lines); move into beforeAll" "$bad"
      fi
      if ! grep -qE 'afterAll[[:space:]]*\(' "$f" 2>/dev/null \
         || ! grep -qE '\.disconnect[[:space:]]*\(' "$f" 2>/dev/null; then
        emit_violation "$f" "R4" "creates PGLiteEngine but missing afterAll(() => engine.disconnect()); engine leaks across files in the shard process" ""
      fi
    fi
  done <<< "$FILE_LIST"
fi

if [ $violations -gt 0 ]; then
  echo
  echo "check-test-isolation: FAIL ($violations violation(s))"
  echo
  echo "Fix:"
  echo "  - For env mutations, use withEnv() from test/helpers/with-env.ts"
  echo "  - For mock.module(), rename to *.serial.test.ts (quarantine)"
  echo "  - For PGLiteEngine, follow the canonical pattern in"
  echo "    test/helpers/reset-pglite.ts JSDoc and CLAUDE.md."
  echo
  echo "Or, if this is a baseline file from before the lint shipped,"
  echo "add it to scripts/check-test-isolation.allowlist (with a TODO"
  echo "comment naming the sweep PR that will remove it)."
  exit 1
fi

echo "check-test-isolation: OK ($file_count non-serial unit files scanned)"
