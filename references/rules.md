# Pre-commit rules registry

| id | severity | name | check | implemented in |
|---|---|---|---|---|
| R-01 | fail | hook-executable | pre-commit hook must be executable | `scripts/pre-commit-guard` |
| R-02 | fail | no-env-files | `.env` files are hard-blocked from being committed | `scripts/pre-commit-guard` |
| R-03 | warn | no-binary-files | binary files are flagged for review | `scripts/pre-commit-guard` |
| R-04 | fail | ast-syntax-check | `npm run typecheck` (tsc --noEmit) must pass on all staged TS source files | `scripts/pre-commit-guard` |
| R-05 | fail | ast-grep-parseable | `ast-grep scan` must parse all staged TS files if `sgconfig.yml` exists | `scripts/pre-commit-guard` |

## Rule R-04 — ast / syntax check

For a TypeScript project, the authoritative AST/syntax check is the TypeScript compiler.
`npm run typecheck` runs `tsc --noEmit`, which parses every source file and reports
syntax errors, parse errors, and type errors. The pre-commit hook runs this against
the staged TS files (non-test files). This captures 100% of syntax-related problems
that the TypeScript parser can detect.

## Rule R-05 — ast-grep parseability

If `sgconfig.yml` is present, the hook also runs `ast-grep scan` on staged TS files.
ast-grep constructs its own AST; failures here indicate files that the community AST
grammar cannot parse. This is a secondary guard, not a replacement for R-04.
