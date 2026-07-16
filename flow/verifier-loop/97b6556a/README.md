# Verifier-loop proof — pi-curator production-wiring (task a)

> Independent, tamper-evident completion proof for the jewilo verifier-loop that
> verified the D1-D8 production-wiring fixes (PR #3 + REQ-SG-08 routing).

## How to reproduce

The jewilo data store lives at `~/.verifier-loop/goals/`. The goal id is
`97b6556a-d959-4258-84b1-ab990699e533`. To independently audit:

```bash
jewilo STATUS 97b6556a-d959-4258-84b1-ab990699e533   # round 3, state consensus_pass
jewilo AUDIT  97b6556a-d959-4258-84b1-ab990699e533   # recomputes the hash, exits 0 if valid
```

## Result (round 3)

- **state:** `consensus_pass` (needs: done)
- **verdicts:** 2/2 APPROVE (v1, v2) — config `n=2, m=2`, backend `pi`
- **completion hash:** `071626-cd0bcbe0`
- **fullDigest:** `cd0bcbe0c7be909113670d3291346c9163284ee9b73845ef3b383ea22bde09be`
- **AUDIT:** `valid=true` — `hashRecomputed == hashStored`, 2 matching verdicts (required m=2)

## Artifacts committed here

| file | source | purpose |
|------|--------|---------|
| `completion.json` | `~/.verifier-loop/goals/97b6556a-.../completion.json` | the tamper-evident completion record (hash + matching verdicts) |
| `goal.json` | `~/.verifier-loop/goals/97b6556a-.../goal.json` | immutable goal text + creation-time config snapshot |
| `signature.json` | `~/.verifier-loop/goals/97b6556a-.../signature.json` | goal signature |
| `audit.json` | `jewilo AUDIT 97b6556a-...` output | recomputed-hash audit (valid=true) |

The verifiers ran blind (no round/peer-verdict/n-m/hash leak in the prompt),
2 independent pi-backend verifier sessions, fail-closed on timeout. Round 1
REJECTED with 4 BLOCKER + 4 MAJOR defects (D1-D8); round 2 split (1 APPROVE,
1 REJECT on REQ-SG-08); round 3 CONSENSUS_PASS after the REQ-SG-08 receiver-side
severity routing fix.
