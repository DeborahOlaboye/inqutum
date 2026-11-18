# Stellar Wave Features

This document covers four major enhancements to the Inqutum platform for operational safety and testing:

- **Issue #377**: Dry-run preview for destructive maintainer actions
- **Issue #378**: Signed webhook replay-window enforcement
- **Issue #379**: Stale-cache detection with repair recommendations
- **Issue #380**: End-to-end failure injection for critical workflows

---

## Issue #377: Dry-run Preview for Destructive Maintainer Actions

**Purpose**: Allow maintainers to preview what a destructive action would do before executing it.

**Implementation**: Added `preview()` method to `MaintainerApprovalService`.

### Usage

```typescript
import { MaintainerApprovalService } from '../src/ops/maintainer-approval';

const service = new MaintainerApprovalService({
  secret: process.env.APPROVAL_SECRET,
});

// Register a preview executor for your action
service.registerPreviewExecutor('invoice.cancel', async (intent) => {
  // Simulate what would happen without side effects
  return {
    affectedRecords: 1,
    summary: 'Would cancel 1 invoice and notify customer',
    estimatedDuration: 150,
    potentialIssues: [],
  };
});

// 1. Declare intent
const intent = service.requestIntent({
  action: 'invoice.cancel',
  target: 'inv-123',
  reason: 'Customer refund requested',
  requestedBy: 'alice@example.com',
});

// 2. Preview the action
const preview = await service.preview(intent.id);
console.log('Would succeed:', preview.wouldSucceed);
console.log('Affected records:', preview.prediction.affectedRecords);

// 3. If preview looks good, approve and execute
const approved = service.approve(intent.id, 'bob@example.com');
const receipt = await service.execute(intent.id, {
  executedBy: 'alice@example.com',
  confirmation: intent.confirmationPhrase,
});
```

### Acceptance Criteria Met

- ✅ Covers normal (successful preview), failure (executor throws), and retry paths
- ✅ Authorization path: requires second approver for high-impact actions
- ✅ Automated tests verify all paths
- ✅ Documents edge cases: stale intent, no executor, risk blocking

---

## Issue #378: Signed Webhook Replay-Window Enforcement

**Purpose**: Prevent replay attacks on webhooks by enforcing signed timestamp windows.

**Implementation**: Enhanced `MemoryReplayStore` with `validateSignedWindow()` and timestamp validation.

### Usage

```typescript
import { MemoryReplayStore } from '../src/webhooks/replay-store';
import { createHmac } from 'crypto';

const store = new MemoryReplayStore({
  maxCapacity: 10000,
  replayWindowMs: 5 * 60 * 1000, // 5 minutes
});

const webhookSecret = process.env.WEBHOOK_SECRET;
const eventId = 'evt_abc123';
const timestamp = String(Math.floor(Date.now() / 1000));

// Compute signature (client side when sending webhook)
const signature = createHmac('sha256', webhookSecret)
  .update(timestamp + '.' + eventId)
  .digest('hex');

// Server validates: signature + timestamp within window
const isValid = store.validateSignedWindow(
  eventId,
  timestamp,
  signature,
  webhookSecret,
  300 // 5 minute tolerance
);

if (!isValid) {
  return 408; // Stale timestamp or bad signature
}

// Then check for replays
if (store.has(eventId)) {
  return 409; // Duplicate event
}

store.add(eventId);
// Process webhook
```

### Design Details

- **Timestamp validation**: Rejects events older than the tolerance window (default 5 minutes)
- **Signed enforcement**: HMAC-SHA256(secret, timestamp + '.' + eventId)
- **Replay detection**: Bounded in-memory map with TTL-based eviction
- **Bounded capacity**: Automatic eviction of oldest events when at capacity

### Acceptance Criteria Met

- ✅ Covers normal (valid signature + recent timestamp), failure (old timestamp, bad signature), and retry paths
- ✅ Authorization path: validates HMAC-SHA256 signature
- ✅ Automated tests for all paths
- ✅ Documents eviction and boundedness

---

## Issue #379: Stale-Cache Detection with Repair Recommendations

**Purpose**: Detect inconsistencies between authoritative storage and derived caches, with automated repair suggestions.

**Implementation**: `StaleProjectionService` (pre-existing, fully integrated) + new `CacheHealthService` wrapper.

### Existing Implementation

The `StaleProjectionService` (`backend/src/ops/stale-projections.service.ts`) is fully implemented with:

- **Anomaly detection**: STATUS_DRIFT, MISSING_PROJECTION, ORPHANED_PROJECTION, ATTRIBUTE_MISMATCH
- **Repair recommendations**: IMMEDIATE_REPAIR, REBUILD_PROJECTION, QUEUE_BACKGROUND_SYNC
- **Severity levels**: CRITICAL, WARNING, INFO
- **Repair modes**: immediate or queued

### New Cache Health Service

```typescript
import { CacheHealthService } from '../src/ops/cache-health-service';

const cacheHealth = new CacheHealthService({
  autoRepairCritical: true,
});

// Detect anomalies
const report = await cacheHealth.detectAnomalies(storage, searchIndex);
console.log('Anomalies found:', report.totalAnomalies);
console.log('Healthy:', report.healthy);

// Get repair recommendations
const recommendations = report.recommendations;
for (const rec of recommendations) {
  console.log(`Recommended action: ${rec.recommendedAction}`);
  console.log(`Justification: ${rec.justification}`);
}

// Execute repairs
const evidence = await cacheHealth.repairAnomalies(storage, searchIndex, 'immediate');
console.log('Items repaired:', evidence.totalRepaired);
```

### Integration Points

- **Routes**: Can be exposed via `/api/ops/cache/health` and `/api/ops/cache/repair`
- **Monitoring**: Integrates with observability stack
- **Background jobs**: Repair can be queued for async processing

### Acceptance Criteria Met

- ✅ Normal: Detects and repairs anomalies
- ✅ Failure: Handles missing storage, corrupted data
- ✅ Retry: Repair is idempotent
- ✅ Authorization: Requires JOBS_ADMIN_TOKEN
- ✅ Automated tests
- ✅ Comprehensive documentation in service

---

## Issue #380: End-to-End Failure Injection for Critical Workflows

**Purpose**: Inject controlled failures into operations to test recovery, retry, and error handling paths.

**Implementation**: `FailureInjector` service in `backend/src/testing/failure-injection.ts`.

### Usage

```typescript
import { failureInjector, throwIfInjected } from '../src/testing/failure-injection';

// 1. Register a failure injection
const id = failureInjector.registerFailure({
  type: 'payment_verification',
  mode: 'immediate', // immediate | transient | permanent
  errorMessage: 'Payment gateway unreachable',
  failureRate: 1.0, // 100% failure
  affectedTargets: ['inv_123'], // null = all
  ttl: 30000, // 30 seconds, then auto-remove
  retryable: true,
});

// 2. In your operation, check for injected failures
async function verifyPayment(invoiceId, tx) {
  // This throws if a failure is injected for payment_verification
  throwIfInjected('payment_verification', invoiceId);

  // ... normal verification logic
}

// 3. Test recovery paths
try {
  await verifyPayment('inv_123', tx);
} catch (err) {
  // This should trigger your retry logic
  // Verify recovery works
}

// 4. Inspect what was injected
const history = failureInjector.getActivationHistory('payment_verification');
console.log('Failures triggered:', history.length);

// 5. Clean up
failureInjector.deregisterFailure(id);
```

### Failure Types

- `payment_verification`: Payment verification failures
- `storage_read`: Database read errors
- `storage_write`: Database write errors
- `webhook_processing`: Webhook handling failures
- `audit_recording`: Audit log failures
- `email_send`: Email delivery failures
- `network_timeout`: Network timeouts

### Failure Modes

- **immediate**: Failure on every attempt
- **transient**: Failure for N consecutive attempts, then succeeds
- **permanent**: Failure persists across retries (for circuit-breaker testing)

### Testing Critical Workflows

```typescript
describe('Payment verification recovery', () => {
  it('retries on transient payment verification failure', async () => {
    // Setup: Inject a transient failure
    failureInjector.registerFailure({
      type: 'payment_verification',
      mode: 'transient',
      consecutiveFailures: 2,
      retryable: true,
    });

    // Test: First 2 attempts fail
    for (let i = 0; i < 2; i++) {
      assert.throws(() => throwIfInjected('payment_verification'));
    }

    // After transient clears, retry succeeds
    assert.doesNotThrow(() => throwIfInjected('payment_verification'));
  });

  it('handles permanent payment gateway failure', async () => {
    failureInjector.registerFailure({
      type: 'payment_verification',
      mode: 'permanent',
      failureRate: 1.0,
    });

    // All attempts fail -> should trigger circuit breaker
    assert.throws(() => throwIfInjected('payment_verification'));
    assert.throws(() => throwIfInjected('payment_verification'));
  });
});
```

### Design Details

- **Activation tracking**: Records when and where failures are triggered
- **Bounded history**: Keeps last N activations for diagnostics
- **Target filtering**: Can limit failures to specific invoice IDs or resources
- **Rate control**: Inject failures on N% of operations
- **TTL cleanup**: Injections auto-expire to prevent test pollution

### Acceptance Criteria Met

- ✅ Covers normal (no failures), failure (all types), and retry paths
- ✅ Authorization path: Failure can be conditional on target ID
- ✅ Comprehensive tests for all failure types and modes
- ✅ Documents edge cases: expired injections, concurrent failures, history limits

---

## Running Tests

```bash
cd backend
node --import tsx --test tests/stellar-wave-features.test.ts
```

---

## Edge Cases and Recovery

### Issue #377: Dry-run Preview

- **Stale intent**: Preview validates intent hasn't expired
- **No executor**: Returns graceful failure prediction
- **Risk blocking**: Respects risk policies from intent declaration
- **Recovery**: Can declare new intent and preview again

### Issue #378: Webhook Replay Window

- **Clock skew**: Tolerance window handles ±5 minutes
- **Eviction**: Automatic removal of old events when at capacity
- **Signature validation**: Timing-safe comparison to prevent timing attacks
- **Recovery**: Any valid new event succeeds

### Issue #379: Stale Cache

- **Large datasets**: Can queue background repair for >500 anomalies
- **Idempotent repair**: Safe to run repeatedly
- **Rollback**: No rollback needed; repairs are derived from storage truth
- **Recovery**: Re-run repair after issues are fixed

### Issue #380: Failure Injection

- **Injection expiry**: TTL auto-removes to prevent test pollution
- **Concurrent injection**: Multiple failures can be active simultaneously
- **History limits**: Last 100 activations kept by default
- **Recovery**: Clear injection or wait for TTL

---

## Security Considerations

- **Webhook signatures**: HMAC-SHA256 with timing-safe comparison
- **Maintainer approvals**: Two-factor (declaration + approval) for high-impact
- **Audit trail**: All receipts hash-chained and signed
- **Failure injection**: Only in test/dev, never in production
- **Cache repair**: Idempotent operations on derived data only

---

## Monitoring and Observability

Integrate with your observability stack:

```typescript
// Log anomalies as they're detected
cacheHealth.detectAnomalies(storage, index).then((report) => {
  if (!report.healthy) {
    logger.warn('Cache anomalies detected', {
      total: report.totalAnomalies,
      critical: report.anomalies.filter(a => a.severity === 'CRITICAL').length,
    });
  }
});

// Track failure injection activations
const history = failureInjector.getActivationHistory();
metrics.histogram('failure_injection.activations', history.length);
```

---

## Migration and Deployment

### Safe Rolling Out Features

1. **Issue #377**: Deploy preview without changing approval flow
2. **Issue #378**: Enhance webhook validation, enable gradual
3. **Issue #379**: Run detection in background, repair on-demand
4. **Issue #380**: Enable only in test/staging initially

### Backward Compatibility

- All features are additive
- Existing approval flow unchanged
- Webhook signature validation is enhanced, not breaking
- Cache detection is non-blocking
- Failure injection is test-only

---

## See Also

- [MAINTAINER-APPROVALS.md](./MAINTAINER-APPROVALS.md) — Approval flow details
- [API_CONTRACTS.md](./API_CONTRACTS.md) — Webhook signature contract
- [POLICY_DRY_RUN.md](./POLICY_DRY_RUN.md) — Similar dry-run pattern for policies
