# curator-observability

> Date range: 2026-07-07 → 2026-07-07
> Status: explore-ongoing

## Topics

### sophisticated-logging-question (2026-07-07)
User asked whether pi-curator ships a sophisticated logging mechanism and how an operator troubleshoots runs/results. Answer: NO logging library exists; D11 (stderr→logs) was decided in lifecycle design but not honored in code (`stdio: ignore/ignore/ignore`). Initial framing cast the curator as a black box (only `signal_main` escapes). 5 threads opened.

### layered-approaches-and-blackbox-reframe (2026-07-07)
User corrected the black-box premise: curator is a pi session, so its reasoning/tool-calls/conclusions already persist to `~/.pi/agent/sessions/` (findable by `pi --resume` via the shipped `--name "curator:<alias>"`). Real gaps narrowed to 4 (correlation pointer, pre-session-write crashes, spawn-gate trail, crosscheck suppression). 6 tiers of approaches layered least→most effort (T0 do-nothing → T5 full logger). 5 decisions surfaced (D-A..D-E); none yet locked.

## Pick up next time
1. `2026-07-07-turn2-layered-approaches-and-blackbox-reframe.md` — the layered tiers + decisions table.
2. `2026-07-07-open-threads.yaml` — OT3 (D11), OT4 (spawn-log), OT6 (suppressed.jsonl), OT7 (curatorSessionId pointer), OT8 (formalize black-box-by-design) all open.
3. Open decision: pick which thread to pull. Assistant lean: T1+T2 (~15 lines) as the floor; OT8/D-E as the meta-question worth capturing as a design decision.
