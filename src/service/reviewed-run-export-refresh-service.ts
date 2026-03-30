import { createHash } from 'crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { gzipSync } from 'zlib';
import {
  ReviewedRunExportManifest,
  ReviewedRunExportRefreshRequest,
  ReviewedRunExportRefreshResponse,
  reviewedDatasetCoverageRequirementsSchema,
  reviewedRunExportManifestSchema,
  reviewedRunExportRefreshRequestSchema,
  reviewedRunExportRefreshResponseSchema,
} from '../contracts';
import { TenantAdminConfigRegistry } from '../admin/file-tenant-admin-config-registry';
import {
  RuntimeObservability,
  noopRuntimeObservability,
} from '../observability/runtime-observability';
import { ModelValidationService } from './model-validation-service';

export interface ReviewedRunExportRefreshServiceOptions {
  validation: ModelValidationService;
  tenantAdminConfigs: TenantAdminConfigRegistry;
  outputDir: string;
  gzipSnapshots?: boolean;
  writeManifest?: boolean;
  policyOverrides?: Partial<{
    includeTranscript: boolean;
    requireAnalystSentiment: boolean;
    classification: 'INTERNAL' | 'RESTRICTED';
    retentionDays: number;
    maximumSnapshots: number;
  }>;
  readinessOverrides?: Partial<{
    minimumRecordCount: number;
    minimumAnalystSentimentCount: number;
    maximumDatasetAgeHours?: number;
  }>;
  clock?: () => Date;
  observability?: RuntimeObservability;
}

export class ReviewedRunExportRefreshService {
  private readonly validation: ModelValidationService;
  private readonly tenantAdminConfigs: TenantAdminConfigRegistry;
  private readonly outputDir: string;
  private readonly gzipSnapshots: boolean;
  private readonly writeManifest: boolean;
  private readonly policyOverrides?: Partial<{
    includeTranscript: boolean;
    requireAnalystSentiment: boolean;
    classification: 'INTERNAL' | 'RESTRICTED';
    retentionDays: number;
    maximumSnapshots: number;
  }>;
  private readonly readinessOverrides?: Partial<{
    minimumRecordCount: number;
    minimumAnalystSentimentCount: number;
    maximumDatasetAgeHours?: number;
  }>;
  private readonly clock: () => Date;
  private readonly observability: RuntimeObservability;

  constructor(options: ReviewedRunExportRefreshServiceOptions) {
    this.validation = options.validation;
    this.tenantAdminConfigs = options.tenantAdminConfigs;
    this.outputDir = options.outputDir;
    this.gzipSnapshots = options.gzipSnapshots ?? false;
    this.writeManifest = options.writeManifest ?? true;
    this.policyOverrides = options.policyOverrides;
    this.readinessOverrides = options.readinessOverrides;
    this.clock = options.clock ?? (() => new Date());
    this.observability = options.observability ?? noopRuntimeObservability;
  }

  async refreshConfiguredExports(input: ReviewedRunExportRefreshRequest = {}): Promise<ReviewedRunExportRefreshResponse> {
    const parsed = reviewedRunExportRefreshRequestSchema.parse(input);
    const generatedAt = this.clock().toISOString();
    const configs = (await this.tenantAdminConfigs.list()).filter((config) => {
      if (parsed.tenantId && config.tenantId !== parsed.tenantId) {
        return false;
      }
      if (parsed.useCase && config.useCase !== parsed.useCase) {
        return false;
      }
      return true;
    });

    const results: ReviewedRunExportRefreshResponse['results'] = [];
    const skipped: ReviewedRunExportRefreshResponse['skipped'] = [];

    for (const config of configs) {
      if (!config.validationMonitoring.enabled && !parsed.force) {
        skipped.push({
          tenantId: config.tenantId,
          useCase: config.useCase,
          reason: 'Validation monitoring is disabled for this tenant scope.',
        });
        continue;
      }

      const exportPolicy = {
        ...config.validationMonitoring.reviewedExports,
        ...this.policyOverrides,
      };
      const coverageRequirements = reviewedDatasetCoverageRequirementsSchema.parse({
        ...config.validationMonitoring.reviewedDatasetReadiness,
        ...this.readinessOverrides,
      });
      const includeTranscript = parsed.includeTranscript ?? exportPolicy.includeTranscript;
      const requireAnalystSentiment = parsed.requireAnalystSentiment ?? exportPolicy.requireAnalystSentiment;

      const exported = await this.validation.exportReviewedRuns({
        tenantId: config.tenantId,
        useCase: config.useCase,
        includeTranscript,
        requireReviewResolution: true,
        requireAnalystSentiment,
      });

      const latestPath = join(this.outputDir, config.tenantId, `${config.useCase}.jsonl`);
      const snapshotPath = join(
        this.outputDir,
        'snapshots',
        config.tenantId,
        config.useCase,
        `${timestampKey(generatedAt)}${this.gzipSnapshots ? '.jsonl.gz' : '.jsonl'}`,
      );
      const latestPayload = Buffer.from(exported.ndjson, 'utf8');
      const snapshotPayload = this.gzipSnapshots ? gzipSync(latestPayload) : latestPayload;
      const manifestPath = join(this.outputDir, config.tenantId, `${config.useCase}.manifest.json`);

      await writeAtomicBuffer(latestPath, latestPayload);
      await writeAtomicBuffer(snapshotPath, snapshotPayload);

      const manifest = reviewedRunExportManifestSchema.parse(this.buildManifest({
        tenantId: config.tenantId,
        useCase: config.useCase,
        generatedAt,
        latestPath,
        latestPayload,
        snapshotPath,
        snapshotPayload,
        records: exported.records,
        includeTranscript,
        requireAnalystSentiment,
        classification: exportPolicy.classification,
        retentionDays: exportPolicy.retentionDays,
        maximumSnapshots: exportPolicy.maximumSnapshots,
        coverageRequirements,
      }));
      if (this.writeManifest) {
        await writeAtomicText(manifestPath, JSON.stringify(manifest, null, 2));
      }
      const prunedSnapshots = await this.pruneSnapshots(
        join(this.outputDir, 'snapshots', config.tenantId, config.useCase),
        exportPolicy.retentionDays,
        exportPolicy.maximumSnapshots,
      );

      results.push({
        tenantId: config.tenantId,
        useCase: config.useCase,
        generatedAt,
        exportedCount: exported.response.exportedCount,
        skippedCount: exported.response.skippedCount,
        analystSentimentCount: manifest.analystSentimentCount,
        latestPath,
        snapshotPath,
        manifestPath: this.writeManifest ? manifestPath : undefined,
      });

      this.observability.incrementCounter('conversation_intelligence.reviewed_exports.refreshed', 1, {
        tenant_id: config.tenantId,
        use_case: config.useCase,
      });
      this.observability.recordHistogram('conversation_intelligence.reviewed_exports.bytes', latestPayload.byteLength, {
        tenant_id: config.tenantId,
        use_case: config.useCase,
        artifact: 'latest',
      });
      this.observability.recordHistogram('conversation_intelligence.reviewed_exports.bytes', snapshotPayload.byteLength, {
        tenant_id: config.tenantId,
        use_case: config.useCase,
        artifact: 'snapshot',
      });
      this.observability.recordGauge('conversation_intelligence.reviewed_exports.records', exported.response.exportedCount, {
        tenant_id: config.tenantId,
        use_case: config.useCase,
      });
      this.observability.recordGauge('conversation_intelligence.reviewed_exports.analyst_sentiment_records', manifest.analystSentimentCount, {
        tenant_id: config.tenantId,
        use_case: config.useCase,
      });
      this.observability.recordGauge('conversation_intelligence.reviewed_exports.dataset_ready', manifest.coverageFailures.length === 0 ? 1 : 0, {
        tenant_id: config.tenantId,
        use_case: config.useCase,
      });
      this.observability.recordGauge('conversation_intelligence.reviewed_exports.coverage_failures', manifest.coverageFailures.length, {
        tenant_id: config.tenantId,
        use_case: config.useCase,
      });
      this.observability.recordGauge('conversation_intelligence.reviewed_exports.retention_days', exportPolicy.retentionDays, {
        tenant_id: config.tenantId,
        use_case: config.useCase,
      });
      this.observability.recordGauge('conversation_intelligence.reviewed_exports.maximum_snapshots', exportPolicy.maximumSnapshots, {
        tenant_id: config.tenantId,
        use_case: config.useCase,
      });
      if (prunedSnapshots > 0) {
        this.observability.incrementCounter('conversation_intelligence.reviewed_exports.snapshots_pruned', prunedSnapshots, {
          tenant_id: config.tenantId,
          use_case: config.useCase,
        });
      }
    }

    return reviewedRunExportRefreshResponseSchema.parse({
      generatedAt,
      results,
      skipped,
    });
  }

  private buildManifest(input: {
    tenantId: string;
    useCase: string;
    generatedAt: string;
    latestPath: string;
    latestPayload: Buffer;
    snapshotPath: string;
    snapshotPayload: Buffer;
    records: Awaited<ReturnType<ModelValidationService['exportReviewedRuns']>>['records'];
    includeTranscript: boolean;
    requireAnalystSentiment: boolean;
    classification: 'INTERNAL' | 'RESTRICTED';
    retentionDays: number;
    maximumSnapshots: number;
    coverageRequirements: ReturnType<typeof reviewedDatasetCoverageRequirementsSchema.parse>;
  }): ReviewedRunExportManifest {
    const byEngagementType: Record<string, number> = {};
    const byQueue: Record<string, number> = {};
    const byTranscriptLengthBucket: Record<string, number> = {};
    let analystSentimentCount = 0;
    let latestReviewedAt: string | undefined;
    let latestUpdatedAt: string | undefined;

    for (const record of input.records) {
      if (record.engagementType) {
        byEngagementType[record.engagementType] = (byEngagementType[record.engagementType] ?? 0) + 1;
      }
      if (record.queue) {
        byQueue[record.queue] = (byQueue[record.queue] ?? 0) + 1;
      }
      if (record.transcriptLengthBucket) {
        byTranscriptLengthBucket[record.transcriptLengthBucket] = (byTranscriptLengthBucket[record.transcriptLengthBucket] ?? 0) + 1;
      }
      if (record.review.analystSentiment) {
        analystSentimentCount += 1;
      }
      if (!latestUpdatedAt || record.updatedAt > latestUpdatedAt) {
        latestUpdatedAt = record.updatedAt;
      }
      const candidateReviewedAt = record.review.analystSentiment?.reviewedAt ?? record.review.reviewedAt;
      if (candidateReviewedAt && (!latestReviewedAt || candidateReviewedAt > latestReviewedAt)) {
        latestReviewedAt = candidateReviewedAt;
      }
    }

    const coverageFailures = this.coverageFailures({
      recordCount: input.records.length,
      analystSentimentCount,
      latestUpdatedAt,
      byEngagementType,
      byQueue,
      byTranscriptLengthBucket,
      requirements: input.coverageRequirements,
    });

    return {
      tenantId: input.tenantId,
      useCase: input.useCase,
      generatedAt: input.generatedAt,
      exportedCount: input.records.length,
      analystSentimentCount,
      latestPath: input.latestPath,
      latestSha256: sha256(input.latestPayload),
      snapshotPath: input.snapshotPath,
      snapshotSha256: sha256(input.snapshotPayload),
      byEngagementType,
      byQueue,
      byTranscriptLengthBucket,
      latestReviewedAt,
      latestUpdatedAt,
      includeTranscript: input.includeTranscript,
      requireAnalystSentiment: input.requireAnalystSentiment,
      classification: input.classification,
      retentionDays: input.retentionDays,
      maximumSnapshots: input.maximumSnapshots,
      coverageRequirements: input.coverageRequirements,
      coverageFailures,
    };
  }

  private coverageFailures(input: {
    recordCount: number;
    analystSentimentCount: number;
    latestUpdatedAt?: string;
    byEngagementType: Record<string, number>;
    byQueue: Record<string, number>;
    byTranscriptLengthBucket: Record<string, number>;
    requirements: ReturnType<typeof reviewedDatasetCoverageRequirementsSchema.parse>;
  }): string[] {
    const failures: string[] = [];
    if (input.recordCount < input.requirements.minimumRecordCount) {
      failures.push(`Reviewed record count ${input.recordCount} is below minimum ${input.requirements.minimumRecordCount}.`);
    }
    if (input.analystSentimentCount < input.requirements.minimumAnalystSentimentCount) {
      failures.push(`Analyst sentiment count ${input.analystSentimentCount} is below minimum ${input.requirements.minimumAnalystSentimentCount}.`);
    }
    if (typeof input.requirements.maximumDatasetAgeHours === 'number' && input.latestUpdatedAt) {
      const latestUpdatedAtMillis = Date.parse(input.latestUpdatedAt);
      if (Number.isFinite(latestUpdatedAtMillis)) {
        const ageHours = (this.clock().getTime() - latestUpdatedAtMillis) / (60 * 60 * 1000);
        if (ageHours > input.requirements.maximumDatasetAgeHours) {
          failures.push(`Reviewed dataset age ${ageHours.toFixed(2)}h exceeds maximum ${input.requirements.maximumDatasetAgeHours}h.`);
        }
      }
    }

    this.appendCoverageFailures('engagement type', input.byEngagementType, input.requirements.byEngagementType, failures);
    this.appendCoverageFailures('queue', input.byQueue, input.requirements.byQueue, failures);
    this.appendCoverageFailures(
      'transcript length bucket',
      input.byTranscriptLengthBucket,
      input.requirements.byTranscriptLengthBucket,
      failures,
    );
    return failures;
  }

  private appendCoverageFailures(
    scopeLabel: string,
    actual: Record<string, number>,
    required: Record<string, number>,
    failures: string[],
  ): void {
    for (const [scope, minimumCount] of Object.entries(required)) {
      const actualCount = actual[scope] ?? 0;
      if (actualCount < minimumCount) {
        failures.push(`${scopeLabel} ${scope} has ${actualCount} reviewed records; need at least ${minimumCount}.`);
      }
    }
  }

  private async pruneSnapshots(
    snapshotDir: string,
    retentionDays: number,
    maximumSnapshots: number,
  ): Promise<number> {
    const entries = await readdir(snapshotDir, { withFileTypes: true }).catch(() => []);
    const snapshotFiles = entries
      .filter((entry) => entry.isFile() && this.isSnapshotDatasetFile(entry.name))
      .map((entry) => ({
        name: entry.name,
        path: join(snapshotDir, entry.name),
        timestamp: this.snapshotTimestamp(entry.name),
      }))
      .sort((left, right) => right.timestamp - left.timestamp);
    if (snapshotFiles.length === 0) {
      return 0;
    }

    const minAllowedTimestamp = this.clock().getTime() - (retentionDays * 24 * 60 * 60 * 1000);
    const removable = new Set<string>();

    for (const snapshot of snapshotFiles) {
      if (snapshot.timestamp < minAllowedTimestamp) {
        removable.add(snapshot.path);
      }
    }

    for (const snapshot of snapshotFiles.slice(Math.max(0, maximumSnapshots))) {
      removable.add(snapshot.path);
    }

    await Promise.all(Array.from(removable).map(async (path) => rm(path, { force: true })));
    return removable.size;
  }

  private isSnapshotDatasetFile(name: string): boolean {
    return name.endsWith('.jsonl')
      || name.endsWith('.jsonl.gz')
      || name.endsWith('.ndjson')
      || name.endsWith('.ndjson.gz')
      || name.endsWith('.json')
      || name.endsWith('.json.gz');
  }

  private snapshotTimestamp(name: string): number {
    const stem = basename(name)
      .replace(/(\.jsonl|\.ndjson|\.json)(\.gz)?$/, '');
    const expanded = stem.replace(
      /^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/,
      '$1$2:$3:$4.$5',
    );
    const normalized = expanded.replace(
      /^(\d{4}-\d{2}-\d{2}T)(\d{2})(\d{2})(\d{2}Z)$/,
      '$1$2:$3:$4',
    );
    const parsed = Date.parse(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }
}

async function writeAtomicText(path: string, value: string): Promise<void> {
  await writeAtomicBuffer(path, Buffer.from(value, 'utf8'));
}

async function writeAtomicBuffer(path: string, value: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, value);
  await rename(tmpPath, path);
}

function timestampKey(value: string): string {
  return value.replace(/[:.]/g, '-');
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
