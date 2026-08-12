# GAP-31/32 Integration TODO

## Completed
- ✅ Rate-limiter module implemented (src/curator-receiver/rate-limiter.ts)
- ✅ Severity-handler module implemented (src/curator-receiver/severity-handler.ts)
- ✅ Unit tests passing (24/24)
- ✅ Integration tests passing (7/7)
- ✅ Committed (commits 8147547, b7b91d0)

## Remaining Work (NOT in PR yet)

### Wire modules into receiver pipeline
Location: `src/curator-receiver/curator-receiver.ts` around line 324-333

**Before (current)**:
```typescript
const { msg, opts } = buildSendMessage(effectiveKind, cleanBody, undefined, {
  severity,
  curatorAlias,
  mainSessionId,
  spawnedAt,
});

// 5. Re-deliver into the main session.
pi.sendMessage(msg, opts);
```

**After (integrate GAP-31/32)**:
```typescript
// GAP-31/32: Check severity decision
const severityDecision = decideSeverityAction(message, severity);

// GAP-31/32: Add to rate limiter queue
state = addToQueue(state, message, computeHash(cleanBody));
state = deduplicateQueue(state);
state = expireOldSignals(state, 5); // expire >5 turns

// GAP-31/32: Only deliver if rate limit allows
if (!shouldDeliver(state)) {
  return true; // queued, will deliver next turn
}

// Batch queued signals
const batchedMessage = batchSignals(state.queue);

const { msg, opts } = buildSendMessage(
  severityDecision.deliverAs === "steer" ? "steer" : effectiveKind,
  batchedMessage.content,
  undefined,
  {
    severity,
    curatorAlias,
    mainSessionId,
    spawnedAt,
    shouldBlock: severityDecision.shouldBlock,
  }
);

// GAP-31/32: Auto-create file for critical + path
if (severityDecision.autoCreateFile) {
  const filePath = extractFilePath(cleanBody);
  if (filePath) {
    // Create file at filePath
    fs.writeFileSync(filePath, `# ${curatorAlias} findings\n\n${cleanBody}`);
  }
}

// 5. Re-deliver into the main session.
pi.sendMessage(msg, opts);

// GAP-31/32: Mark delivered, remove from queue
state = markDelivered(state);
state = removeFromQueue(state);
```

### Add state management
Need to maintain `RateLimiterState` across turns:
- Store in extension context or global
- Initialize on extension load
- Advance turn on turn_end hook

### Add turn_end hook
Wire `advanceTurn()` into turn_end hook to reset `deliveredThisTurn` flag.

### Integration test against full pipeline
Currently only unit/integration tests. Need end-to-end test with real pi.sendMessage mock.

## Estimated remaining work
2-3 hours to wire, test, and verify no regressions.
