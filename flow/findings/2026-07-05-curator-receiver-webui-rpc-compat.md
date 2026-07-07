# Finding: curator-receiver — webui / RPC-mode compatibility audit

Date: 2026-07-05
Scope: `profile/extensions/curator-receiver/` (pi-curator main-side receiver)
Source of truth for RPC surface: `@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js:78-220`
`hasUI()` truth: `dist/core/extensions/runner.js:245-246`

## TL;DR

curator-receiver is **already RPC-safe**. It uses ONE UI call (`ctx.ui.notify`) gated
behind optional-chaining (`ctx?.ui?.notify?.(...)`). No `custom()`, no widget factories,
no shortcuts, no footer/header. Delivery path is decided by `ctx.mode` (not `hasUI`) — the
correct pattern per [LL1] in the audit prompt.

## Touchpoints

| file:line | API | RPC tier | note |
|---|---|---|---|
| `index.ts:53` | `ctx?.ui?.notify?.(msg, "error")` | T0 ✅ | fire-and-forget, inside try/catch |
| `curator-receiver.ts:218` | `ctx?.ui?.notify?.(message, "error")` | T0 ✅ | safeNotifyError, best-effort, swallowed |
| `curator-receiver.ts:329` | `ctx.mode === "rpc"` branch | ✅ correct gate | resolveDeliveryPath → fallback-file |
| `curator-receiver.ts:353` | `ctx.mode === "rpc"` | ✅ correct gate | REQ-SG-07 fallback doc |

## Why it works in webui

1. `notify` is T0 fire-and-forget in rpc (`rpc-mode.js:86-95`) — always emits.
2. `safeNotifyError` swallows failures → never blocks main turn (REQ-SG-09 honored).
3. Delivery-path logic explicitly branches on `ctx.mode`, NOT `hasUI`. RPC mode → fallback
   JSONL file at `~/.pi-curator/findings/<mainSessionId>/...`. This is the PRIMARY path in
   webui, NOT a degraded path — by design (REQ-SG-07, T0-Q3 confirmed).
4. No `custom()`, `onTerminalInput`, `setWidget`, `setFooter/Header`, `registerShortcut`,
   `getEditorText`, `setWorking*`, `addAutocompleteProvider`, `setEditorComponent`.

## Migration needed

**NONE.** No code changes required for webui/RPC compatibility.

The only delta vs the canonical audit prompt rules: optional-chaining on `ctx?.ui` is
defensive-but-correct. `ctx.ui` is always bound in rpc mode (real UI context, not noOp —
`runner.js:238-246`), so the `?.` is belt-and-suspenders, not wrong.

## Functionality loss in webui

**NONE.** All features available:
- Incoming curator signal delivery → fallback file path (designed primary path in rpc).
- Error notification → `notify` works.
- REQ-SG-09 exception safety → honored.

## Callsout

- [CA1] `safeNotifyError` only fires on the *interactive* intercom path's catch block
  (`curator-receiver.ts:218`). The rpc fallback-file path (line ~353) is the primary path
  in webui — its error handling is NOT in `curator-receiver.ts` (owned by
  `add-curator-lifecycle` task 9.2 `/curator status` reader). Verify that reader handles
  malformed JSONL records gracefully before claiming end-to-end webui safety.
- [CA2] This audit only covers the **receiver** (main-side). The **curator sender** (lifecycle
  side, `add-curator-lifecycle`) was NOT audited here. If curators themselves run in rpc/webui,
  their emit path needs a separate audit.

## References

- Receiver source: `profile/extensions/curator-receiver/index.ts`, `curator-receiver.ts`
- RPC UI context (authoritative): `@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js:78-220`
- `hasUI` truth: `dist/core/extensions/runner.js:245-246`
- Related spec: `pi-curator/openspec/specs/curator-signal/spec.md` (REQ-SG-07, REQ-SG-09)
