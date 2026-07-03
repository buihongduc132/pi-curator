# T0 probe results — add-curator-signal

Generated: 2026-06-22T11:20:54.936Z
Probe: `~/.pi-curator/probes/t0-probe.ts` (executed end-to-end)
Broker socket: `/home/bhd/.pi/agent/intercom/broker.sock`

## Interactive probe (task 1.1 + 1.2) — real broker send + capture

Sender session: `t0-probe-sender` (broker id `<unknown>`)
Receiver session: `t0-probe-receiver` (broker id `<unknown>`)

### Sender emit (stock intercom `send` action shape)
```json
{
  "to": "t0-probe-receiver",
  "text": "[STEER] probe payload",
  "attemptedDetails": {
    "kind": "steer",
    "mainSessionId": "probe"
  }
}
```

Send result: `delivered=true`, messageId `a9a5b4ab-79bb-4923-bf52-30210bedc47c`

### Captured broker-delivered message (what the receiver's IntercomClient saw)
```json
{
  "from": {
    "name": "t0-probe-sender",
    "cwd": "/home/bhd/.pi-curator/probes",
    "model": "t0-probe",
    "pid": 3351838,
    "startedAt": 1782127254931,
    "lastActivity": 1782127254931,
    "status": "probe-t0-probe-sender",
    "id": "d77de915-258d-4777-a2d1-c993078fc6f3"
  },
  "message": {
    "id": "a9a5b4ab-79bb-4923-bf52-30210bedc47c",
    "timestamp": 1782127254933,
    "content": {
      "text": "[STEER] probe payload"
    }
  }
}
```

### Reconstructed pi-intercom re-emit (what a receiver `message_end` hook sees)
Reconstructed verbatim from pi-intercom `index.ts` sendIncomingMessage (lines ~580-594):
```json
{
  "customType": "intercom_message",
  "content": "**📨 From t0-probe-sender** (/home/bhd/.pi-curator/probes)\n\n[STEER] probe payload",
  "display": true,
  "details": {
    "from": {
      "name": "t0-probe-sender",
      "cwd": "/home/bhd/.pi-curator/probes",
      "model": "t0-probe",
      "pid": 3351838,
      "startedAt": 1782127254931,
      "lastActivity": 1782127254931,
      "status": "probe-t0-probe-sender",
      "id": "d77de915-258d-4777-a2d1-c993078fc6f3"
    },
    "message": {
      "id": "a9a5b4ab-79bb-4923-bf52-30210bedc47c",
      "timestamp": 1782127254933,
      "content": {
        "text": "[STEER] probe payload"
      }
    },
    "bodyText": "[STEER] probe payload"
  }
}
```

### T0-Q1 — does `details.kind` survive the intercom round-trip?

**Answer: NO.** The broker `Message` type (pi-intercom `types.ts`) carries only
`{ id, timestamp, replyTo?, expectsReply?, content: { text, attachments? } }`.
The stock intercom `send` tool action (`index.ts` ~line 1392-1430) calls
`client.send(sendTo, { text: message, attachments, replyTo })` — there is NO
`details` parameter. A curator-supplied `details.kind` is NOT transported.
On re-emit, `details` is the reconstructed `entry = { from, message, 
replyCommand, bodyText }` (`index.ts:591`), which has NO `kind` field.

```json
{
  "observedKindFieldInDetails": false,
  "kindRecoveredFromBodyPrefix": true,
  "observedDetailsKeys": [
    "from",
    "message",
    "replyCommand",
    "bodyText"
  ]
}
```

### T0-Q2 — what `customType` does the receiver's hook see?

**Answer: `"intercom_message"` (HARDCODED).** pi-intercom `index.ts:587`
re-emits with `customType: "intercom_message"` regardless of sender intent.
Filtering on `customType === "curator_signal"` matches NOTHING (verifier C4).

```json
{
  "observedCustomType": "intercom_message"
}
```

### T0-Q4 — does the `[STEER]` prefix survive body reformatting?

**Answer: YES.** The sender body text `[STEER] probe payload` round-trips through
`message.content.text` → `entry.bodyText` → re-emit `content` intact. The
`[STEER]` prefix is present in the reconstructed content. Kind recovery via
body-text prefix (design D-C2/C4 stage i) is VIABLE as the primary path.

```json
{
  "prefixSurvived": true,
  "contentSnapshot": "**📨 From t0-probe-sender** (/home/bhd/.pi-curator/probes)\n\n[STEER] probe payload"
}
```
## T0-Q3 — SECOND variant (task 1.3): non-interactive busy auto-reply ordering

Generated: 2026-06-22T11:20:56.949Z

### Real `pi -p` receiver spawn (non-interactive path evidence)
```json
{
  "pid": 3351872,
  "argv": [
    "pi",
    "-p",
    "--provider",
    "google",
    "--model",
    "gemini-2.5-flash",
    "T0 probe non-interactive busy variant — exit immediately"
  ],
  "exited": false,
  "exitSignal": null,
  "receiverMode": "rpc"
}
```

### Source-grounded analysis (installed pi-intercom)
Citation: pi-intercom/index.ts (installed /home/bhd/.pi/agent/npm/node_modules/pi-intercom/index.ts), handleIncomingMessage ~lines 663-682

```ts
    const entry = { from, message, replyCommand, bodyText };
    void (async () => {
      const activeContext = getLiveContext(liveContext, messageGeneration);
      if (!activeContext) {
        return;
      }
      if (!activeContext.isIdle()) {
        if (!activeContext.hasUI) {
          const activeClient = client;
          if (!message.replyTo && activeClient?.isConnected()) {
            try {
              const result = await activeClient.send(from.id, {
                text: "This agent is running in non-interactive mode and cannot respond to intercom messages while it is working. It will continue its current task and exit when done.",
                replyTo: message.id,
              });
              if (result.delivered && getLiveContext(liveContext, messageGeneration)) {
                replyTracker.markReplied(message.id);
              }
            } catch {
              // Best-effort reply; keep the busy non-interactive session running either way.
```

### T0-Q3 answer: does the auto-reply fire BEFORE any extension hook?

**Answer: YES (`autoReplyFiredBeforeHook=true`).**
In `handleIncomingMessage`, when the receiver is BOTH non-interactive
(`!activeContext.hasUI`, i.e. `pi -p` / `ctx.mode === "rpc"`) AND busy
(`!activeContext.isIdle()`), pi-intercom sends the auto-reply string
`"This agent is running in non-interactive mode and cannot respond..."`
and `return`s BEFORE calling `sendIncomingMessage` / `pi.sendMessage`.
NO extension hook can intercept. This confirms design D-C3 path (b):
RPC-mode main uses the fallback findings file as PRIMARY (REQ-SG-07).

```json
{
  "autoReplyFiredBeforeHook": true,
  "receiverMode": "rpc",
  "receiverBusy": true,
  "empiricalNote": "A fully empirical busy-non-interactive capture requires a reachable LLM provider to drive the receiver mid-turn; the spawn evidences the non-interactive path and the source-grounded analysis answers T0-Q3 definitively from the installed pi-intercom code."
}
```
