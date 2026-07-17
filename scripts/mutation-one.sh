#!/usr/bin/env bash
# mutation-one.sh <source-file> — run stryker scoped to ONE source file (fast).
# Prints the file's mutation score. Uses coverageAnalysis:off + concurrency:4.
# Bypasses the .mutator-sha gate (we invoke stryker directly with a temp config).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:?usage: mutation-one.sh <src/path/file.ts>}"
MUTATOR_GUARD_ROOT="${MUTATOR_GUARD_ROOT:-/home/bhd/Documents/Projects/bhd/guard-orches/components/mutator-guard}"

cd "$REPO_ROOT"

# Resolve target relative to repo root.
REL="${TARGET#$REPO_ROOT/}"
[ -f "$REL" ] || { echo "ERROR: $REL not found" >&2; exit 2; }

# Scoped temp config.
TMP="$(mktemp /tmp/stryker-one-XXXXXX.json)"
cat > "$TMP" <<JSON
{
  "ignorePatterns": ["/node_modules","/dist","/.tmp","/logs","/.pi","/.gitnexus","/.stryker-tmp"],
  "mutate": ["$REL"],
  "mutator": { "excludedMutations": ["StringLiteral","Regex"] },
  "coverageAnalysis": "off",
  "timeoutMS": 60000,
  "timeoutFactor": 2,
  "disableBail": false,
  "cleanTempDir": true,
  "incremental": false,
  "reporters": ["json","progress"],
  "thresholds": { "high": 95, "low": 95, "break": 0 },
  "testRunner": "vitest",
  "vitest": { "configFile": ".mutator-rules/stryker/vitest.mutation.config.ts", "dir": "." },
  "concurrency": 4
}
JSON

RAW="$REPO_ROOT/reports/mutation/mutation.json"
rm -f "$RAW"

echo "==> stryker scoped to: $REL" >&2
node "$MUTATOR_GUARD_ROOT/node_modules/@stryker-mutator/core/bin/stryker.js" run "$TMP" 2>&1 | tail -20 || true
rm -f "$TMP"

# Parse + print the per-file score from the raw report.
python3 - "$RAW" "$REL" <<'PY' || true
import json, sys
out, rel = sys.argv[1], sys.argv[2]
try:
    d = json.load(open(out))
except Exception as e:
    print(f"PARSE ERROR: {e}", file=sys.stderr); sys.exit(0)
files = d.get("files", {})
info = files.get(rel) or files.get("./" + rel)
if not info:
    # find by basename match
    for k,v in files.items():
        if k.endswith(rel) or k.endswith("/" + rel.split("/")[-1]):
            info = v; break
if not info:
    print("NO RESULT for", rel, file=sys.stderr); sys.exit(0)
muts = info.get("mutants", [])
from collections import Counter
c = Counter(m.get("status") for m in muts)
det = sum(c.get(s,0) for s in ("Killed","Survived","Timeout","RuntimeError"))
killed = c.get("Killed",0)
score = 100.0*killed/det if det else 0.0
surv = c.get("Survived",0)
print(f"SCORE {rel}: {score:.1f}%  killed={killed} survived={surv} timeout={c.get('Timeout',0)} nocov={c.get('NoCoverage',0)} (detectable={det})")
PY
