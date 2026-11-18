/**
 * Failure injection for end-to-end testing of critical workflows.
 *
 * Allows controlled injection of failures into operations:
 * - Payment verification failures
 * - Storage errors
 * - Webhook processing failures
 * - Recovery and retry path testing
 *
 * Issue #380: Create end-to-end failure injection for critical workflows
 */

export type FailureType =
  | 'payment_verification'
  | 'storage_read'
  | 'storage_write'
  | 'webhook_processing'
  | 'audit_recording'
  | 'email_send'
  | 'network_timeout';

export type FailureMode = 'immediate' | 'transient' | 'permanent';

export interface FailureInjectionConfig {
  type: FailureType;
  mode: FailureMode;
  errorCode?: string;
  errorMessage?: string;
  failureRate?: number; // 0-1, what percentage of operations fail
  affectedTargets?: string[]; // null = all, or specific invoice IDs, etc.
  retryable?: boolean;
  ttl?: number; // ms, how long this injection lasts
  consecutiveFailures?: number; // number of consecutive failures before recovery
}

export interface InjectedFailure {
  id: string;
  config: FailureInjectionConfig;
  createdAt: number;
  activatedCount: number;
  lastActivatedAt?: number;
}

export class FailureInjector {
  private injections = new Map<string, InjectedFailure>();
  private activationHistory: Array<{ failureId: string; timestamp: number; targetId?: string }> = [];

  registerFailure(config: FailureInjectionConfig): string {
    const id = `inj_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const injection: InjectedFailure = {
      id,
      config,
      createdAt: Date.now(),
      activatedCount: 0,
    };
    this.injections.set(id, injection);
    return id;
  }

  shouldFail(type: FailureType, targetId?: string): boolean {
    const now = Date.now();
    const applicableInjections = [...this.injections.values()].filter((inj) => {
      if (inj.config.type !== type) return false;
      if (inj.config.ttl && inj.createdAt + inj.config.ttl < now) {
        this.injections.delete(inj.id);
        return false;
      }
      if (inj.config.affectedTargets && !inj.config.affectedTargets.includes(targetId ?? '')) {
        return false;
      }
      return true;
    });

    for (const inj of applicableInjections) {
      const failureRate = inj.config.failureRate ?? 1.0;
      if (Math.random() < failureRate) {
        inj.activatedCount++;
        inj.lastActivatedAt = now;
        this.activationHistory.push({ failureId: inj.id, timestamp: now, targetId });
        return true;
      }
    }

    return false;
  }

  getFailure(type: FailureType, targetId?: string): InjectedFailure | null {
    const now = Date.now();
    for (const inj of this.injections.values()) {
      if (inj.config.type !== type) continue;
      if (inj.config.ttl && inj.createdAt + inj.config.ttl < now) continue;
      if (inj.config.affectedTargets && !inj.config.affectedTargets.includes(targetId ?? '')) continue;
      return inj;
    }
    return null;
  }

  deregisterFailure(id: string): boolean {
    return this.injections.delete(id);
  }

  listActiveFailures(): InjectedFailure[] {
    const now = Date.now();
    const active = [...this.injections.values()].filter((inj) => {
      if (inj.config.ttl && inj.createdAt + inj.config.ttl < now) {
        this.injections.delete(inj.id);
        return false;
      }
      return true;
    });
    return active;
  }

  getActivationHistory(type?: FailureType, limit: number = 100): Array<{ failureId: string; timestamp: number; targetId?: string }> {
    let history = this.activationHistory.slice(-limit);
    if (type) {
      history = history.filter((h) => {
        const inj = this.injections.get(h.failureId);
        return inj?.config.type === type;
      });
    }
    return history;
  }

  clear(): void {
    this.injections.clear();
  }

  createError(type: FailureType, targetId?: string): Error {
    const inj = this.getFailure(type, targetId);
    const message = inj?.config.errorMessage ?? `Injected ${type} failure`;
    const code = inj?.config.errorCode ?? type.toUpperCase();
    const err = new Error(message);
    Object.defineProperty(err, 'code', { value: code });
    return err;
  }
}

export const failureInjector = new FailureInjector();

/**
 * Helper: throw an injected failure if one is active for this type.
 * Usage at operation boundaries:
 *
 *   async function verifyPayment(invoiceId, tx) {
 *     throwIfInjected('payment_verification', invoiceId);
 *     // ... normal verification logic
 *   }
 */
export function throwIfInjected(type: FailureType, targetId?: string): void {
  if (failureInjector.shouldFail(type, targetId)) {
    throw failureInjector.createError(type, targetId);
  }
}
