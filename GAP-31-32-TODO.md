# GAP-31/32 Integration TODO

## Status: DEFERRED

After 3+ hours and 2 worker sub-agents, pipeline integration broke 47 tests. 

**Modules implemented and tested** (31/31 passing):
- ✅ `src/curator-receiver/rate-limiter.ts` (3377 bytes, 13 tests)
- ✅ `src/curator-receiver/severity-handler.ts` (3425 bytes, 11 tests)
- ✅ `src/curator-receiver/gap31-32-integration.test.ts` (7 integration tests)

**Pipeline integration attempted but reverted** due to test failures.

## What Works

The rate-limiter and severity-handler modules are production-ready:
- Pure functions, fully unit-tested
- Integration tests verify cross-module behavior
- No external dependencies
- Ready to wire into pipeline when test strategy is resolved

## What's Needed

### 1. Test Strategy
Current tests assume synchronous, immediate dispatch. GAP-31/32 introduces:
- Queuing (signals may not dispatch immediately)
- Batching (multiple signals → single delivery)
- Turn-based state (deliveredThisTurn flag)

**Options**:
1. Refactor existing tests to expect queued behavior
2. Add feature flag to disable rate limiting in tests
3. Provide test doubles for rate-limiter state

### 2. Integration Points

**src/curator-receiver/curator-receiver.ts** around line 324-333:

```typescript
// Current (synchronous dispatch):
const { msg, opts } = buildSendMessage(effectiveKind, cleanBody, undefined, {
  severity, curatorAlias, mainSessionId, spawnedAt,
});
pi.sendMessage(msg, opts);

// Needed (with rate limiting):
import { rateLimiterState, addToQueue, shouldDeliver, batchSignals, ... } from "./rate-limiter.js";
import { decideSeverityAction } from "./severity-handler.js";

// 1. Check severity
const severityDecision = decideSeverityAction(message, severity);

// 2. Add to queue
rateLimiterState = addToQueue(rateLimiterState, message, hash);
rateLimiterState = deduplicateQueue(rateLimiterState);
rateLimiterState = expireOldSignals(rateLimiterState, 5);

// 3. Check rate limit
if (!shouldDeliver(rateLimiterState)) {
  // Queued for next turn
  return;
}

// 4. Batch and deliver
const batched = batchSignals(rateLimiterState.queue);
const { msg, opts } = buildSendMessage(
  severityDecision.deliverAs === "steer" ? "steer" : effectiveKind,
  batched.content,
  undefined,
  { ...batched.details, shouldBlock: severityDecision.shouldBlock }
);

// 5. Auto-create file for critical
if (severityDecision.autoCreateFile) {
  const filePath = extractFilePath(cleanBody);
  if (filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `# ${curatorAlias} findings\n\n${cleanBody}`);
  }
}

pi.sendMessage(msg, opts);
rateLimiterState = markDelivered(rateLimiterState);
rateLimiterState = removeFromQueue(rateLimiterState);
```

### 3. State Management

Need persistent `RateLimiterState` across turns:
```typescript
let rateLimiterState: RateLimiterState = {
  queue: [],
  currentTurn: 0,
  deliveredThisTurn: false,
};
```

### 4. Turn Hook

Wire `advanceTurn()` into existing turn_end hook in `src/curator-receiver/index.ts`:
```typescript
pi.on("turn_end", () => {
  rateLimiterState = advanceTurn(rateLimiterState);
});
```

## Estimated Work

- Test strategy decision: 1-2 hours
- Integration implementation: 2-3 hours
- Test fixes/refactoring: 3-4 hours
- Verification: 1 hour

**Total**: 7-10 hours

## Recommendation

Defer GAP-31/32 pipeline integration to dedicated ticket. Current modules provide foundation for future work. Priority: fix GAP-30/34, ship what works.
