/**
 * Cache health monitoring and repair service.
 *
 * Integrates stale projection detection with operational workflows.
 * Provides endpoints for detecting and repairing cache inconsistencies.
 */

import type { InvoiceStorage } from '../storage/invoice-storage';
import { staleProjectionService, type StaleDetectionReport, type RepairExecutionEvidence } from './stale-projections.service';
import { PermissionAwareSearchIndex, defaultSearchIndex } from '../services/search-index.service';

export interface CacheHealthOptions {
  checkInterval?: number; // ms between automatic health checks
  autoRepairCritical?: boolean; // auto-repair CRITICAL anomalies
}

export class CacheHealthService {
  private lastCheckAt: number = 0;
  private lastReport: StaleDetectionReport | null = null;

  constructor(private readonly options: CacheHealthOptions = {}) {}

  async detectAnomalies(storage: InvoiceStorage, index: PermissionAwareSearchIndex = defaultSearchIndex): Promise<StaleDetectionReport> {
    const report = await staleProjectionService.detect(storage, index);
    this.lastReport = report;
    this.lastCheckAt = Date.now();
    return report;
  }

  async repairAnomalies(
    storage: InvoiceStorage,
    index: PermissionAwareSearchIndex = defaultSearchIndex,
    mode: 'immediate' | 'queued' = 'immediate'
  ): Promise<RepairExecutionEvidence> {
    return staleProjectionService.repair(storage, index, { mode });
  }

  getLastReport(): StaleDetectionReport | null {
    return this.lastReport;
  }

  async checkAndRepairCritical(storage: InvoiceStorage, index: PermissionAwareSearchIndex = defaultSearchIndex): Promise<{
    report: StaleDetectionReport;
    repairResult?: RepairExecutionEvidence;
  }> {
    const report = await this.detectAnomalies(storage, index);

    if (this.options.autoRepairCritical && report.anomalies.some((a) => a.severity === 'CRITICAL')) {
      const repairResult = await this.repairAnomalies(storage, index, 'immediate');
      return { report, repairResult };
    }

    return { report };
  }
}

export const cacheHealthService = new CacheHealthService();
