import {
  TenantAdminConfigRegistry,
} from '../admin/file-tenant-admin-config-registry';
import {
  AnalysisJobRecord,
  TenantAdminConfig,
  TenantPackAutoEvaluateCanaryRequest,
  tenantPackAutoEvaluateCanaryResponseSchema,
  TenantPackAutoEvaluateCanaryResponse,
  TenantPackEvaluateCanaryResponse,
  tenantPackReleaseCanarySchema,
} from '../contracts';
import { TenantPackRegistry } from '../packs/file-tenant-pack-registry';
import { ConversationIntelligenceService } from './conversation-intelligence-service';

export interface CanaryAutomationBatchResult {
  attempted: TenantPackAutoEvaluateCanaryResponse[];
  skipped: TenantPackAutoEvaluateCanaryResponse[];
}

export interface CanaryAutomationServiceOptions {
  service: ConversationIntelligenceService;
  tenantPacks: TenantPackRegistry;
  tenantAdminConfigs: TenantAdminConfigRegistry;
  clock?: () => Date;
}

export class CanaryAutomationService {
  private readonly service: ConversationIntelligenceService;
  private readonly tenantPacks: TenantPackRegistry;
  private readonly tenantAdminConfigs: TenantAdminConfigRegistry;
  private readonly clock: () => Date;

  constructor(options: CanaryAutomationServiceOptions) {
    this.service = options.service;
    this.tenantPacks = options.tenantPacks;
    this.tenantAdminConfigs = options.tenantAdminConfigs;
    this.clock = options.clock ?? (() => new Date());
  }

  async evaluateConfiguredCanaries(): Promise<CanaryAutomationBatchResult> {
    const configs = await this.tenantAdminConfigs.list();
    const attempted: TenantPackAutoEvaluateCanaryResponse[] = [];
    const skipped: TenantPackAutoEvaluateCanaryResponse[] = [];

    for (const config of configs) {
      if (!config.canaryAutomation.enabled) {
        continue;
      }

      const response = await this.evaluateScope({
        tenantId: config.tenantId,
        useCase: config.useCase,
      });

      if (response.attempted) {
        attempted.push(response);
      } else {
        skipped.push(response);
      }
    }

    return {
      attempted,
      skipped,
    };
  }

  async evaluateScope(input: TenantPackAutoEvaluateCanaryRequest): Promise<TenantPackAutoEvaluateCanaryResponse> {
    const now = this.clock().toISOString();
    const config = await this.tenantAdminConfigs.get(input.tenantId, input.useCase ?? 'support');
    const releaseState = await this.tenantPacks.describe(input.tenantId, input.useCase ?? 'support');
    const targetRelease = input.targetPackVersion
      ? releaseState.releases.find((release) => release.packVersion === input.targetPackVersion)
      : releaseState.releases.find((release) => release.status === 'CANARY');

    if (!config.canaryAutomation.enabled) {
      return tenantPackAutoEvaluateCanaryResponseSchema.parse({
        attempted: false,
        skippedReason: 'Canary automation is disabled for this tenant scope.',
        configApplied: this.configSummary(config),
      });
    }

    if (!targetRelease) {
      return tenantPackAutoEvaluateCanaryResponseSchema.parse({
        attempted: false,
        skippedReason: 'No canary release is active for this tenant scope.',
        configApplied: this.configSummary(config),
      });
    }

    const canary = tenantPackReleaseCanarySchema.parse(targetRelease.canary ?? {
      percentage: 100,
      evaluations: [],
    });
    const lastEvaluationAt = canary.evaluations.length > 0
      ? canary.evaluations[canary.evaluations.length - 1].decidedAt
      : canary.startedAt;

    if (!input.force && lastEvaluationAt && this.minutesSince(lastEvaluationAt) < config.canaryAutomation.minimumIntervalMinutes) {
      return tenantPackAutoEvaluateCanaryResponseSchema.parse({
        attempted: false,
        skippedReason: `Canary was evaluated too recently; wait at least ${config.canaryAutomation.minimumIntervalMinutes} minutes between automated checks.`,
        configApplied: this.configSummary(config),
      });
    }

    const metrics = await this.computeLiveMetrics({
      tenantId: input.tenantId,
      useCase: input.useCase ?? 'support',
      packVersion: targetRelease.packVersion,
      canaryStartedAt: canary.startedAt ?? targetRelease.updatedAt,
      evaluationWindowHours: config.canaryAutomation.evaluationWindowHours,
      now,
    });

    const note = input.note
      ?? config.canaryAutomation.noteTemplate
      ?? `Automated canary evaluation from live run metrics at ${now}.`;

    const result = await this.tenantPacks.evaluateCanary({
      tenantId: input.tenantId,
      useCase: input.useCase ?? 'support',
      targetPackVersion: targetRelease.packVersion,
      metrics,
      applyResult: input.applyResult ?? config.canaryAutomation.applyResult,
      note,
    }, {
      actorId: 'canary_automation',
      actorType: 'SYSTEM',
    });

    return tenantPackAutoEvaluateCanaryResponseSchema.parse({
      attempted: true,
      configApplied: this.configSummary(config),
      result,
    });
  }

  private async computeLiveMetrics(input: {
    tenantId: string;
    useCase: string;
    packVersion: string;
    canaryStartedAt: string;
    evaluationWindowHours: number;
    now: string;
  }): Promise<TenantPackEvaluateCanaryResponse['evaluation']['metrics']> {
    const jobs = await this.service.listJobs(input.tenantId);
    const windowStartedAt = this.windowStart(input.canaryStartedAt, input.evaluationWindowHours, input.now);
    const matchingJobs = jobs.filter((job) => {
      if (job.useCase !== input.useCase) {
        return false;
      }
      if (job.createdAt < windowStartedAt || job.createdAt > input.now) {
        return false;
      }
      return this.packVersionForJob(job) === input.packVersion;
    });

    const sampleSize = matchingJobs.length;
    const completedRuns = matchingJobs.filter((job) => job.status === 'COMPLETED');
    const failedRuns = matchingJobs.filter((job) => job.status === 'FAILED');
    const reviewCount = completedRuns.filter((job) => job.result?.review.state === 'NEEDS_REVIEW').length;
    const uncertainCount = completedRuns.filter((job) => job.result?.review.state === 'UNCERTAIN').length;
    const scoredRuns = completedRuns.filter((job) => typeof job.result?.overallEndUserSentiment?.score?.score100 === 'number');
    const averageScore100 = scoredRuns.length > 0
      ? Number((scoredRuns.reduce((sum, job) => sum + (job.result?.overallEndUserSentiment?.score?.score100 ?? 0), 0) / scoredRuns.length).toFixed(2))
      : undefined;

    return {
      sampleSize,
      completedRuns: completedRuns.length,
      failedRuns: failedRuns.length,
      failureRate: sampleSize > 0 ? failedRuns.length / sampleSize : 0,
      reviewCount,
      reviewRate: completedRuns.length > 0 ? reviewCount / completedRuns.length : 0,
      uncertainCount,
      uncertainRate: completedRuns.length > 0 ? uncertainCount / completedRuns.length : 0,
      scoredRuns: scoredRuns.length,
      averageScore100,
      windowStartedAt,
      windowEndedAt: input.now,
    };
  }

  private packVersionForJob(job: AnalysisJobRecord): string | undefined {
    return job.result?.trace.packVersion ?? job.request?.tenantPack.packVersion;
  }

  private windowStart(canaryStartedAt: string, evaluationWindowHours: number, now: string): string {
    const canaryMillis = Date.parse(canaryStartedAt);
    const nowMillis = Date.parse(now);
    const windowMillis = nowMillis - (evaluationWindowHours * 60 * 60 * 1000);

    if (!Number.isFinite(canaryMillis)) {
      return new Date(windowMillis).toISOString();
    }

    return new Date(Math.max(canaryMillis, windowMillis)).toISOString();
  }

  private minutesSince(timestamp: string): number {
    const millis = Date.parse(timestamp);
    if (!Number.isFinite(millis)) {
      return Number.POSITIVE_INFINITY;
    }
    return Math.max(0, Math.floor((this.clock().getTime() - millis) / 60000));
  }

  private configSummary(config: TenantAdminConfig) {
    return {
      minimumIntervalMinutes: config.canaryAutomation.minimumIntervalMinutes,
      evaluationWindowHours: config.canaryAutomation.evaluationWindowHours,
      applyResult: config.canaryAutomation.applyResult,
    };
  }
}
