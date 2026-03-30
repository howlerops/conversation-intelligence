import { mkdir, readFile, readdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import {
  AnalysisJobRecord,
  AuditEventsSnapshot,
  ReviewQueueSnapshot,
  RunEventsSnapshot,
  analysisJobRecordSchema,
  auditEventsSnapshotSchema,
  reviewQueueSnapshotSchema,
  runEventsSnapshotSchema,
} from '../contracts/jobs';
import { reviewQueueItemSchema } from '../contracts/analysis';
import { AuditEvent, auditEventSchema, RunEvent, runEventSchema } from '../contracts/runtime';
import { AuditEventFilters, JobListFilters, JobStore } from './job-store';

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await ensureDirectory(dirname(path));
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
}

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as T;
}

export class FileJobStore implements JobStore {
  private readonly jobsDir: string;
  private readonly runEventsDir: string;
  private readonly auditEventsDir: string;
  private readonly reviewQueuePath: string;

  constructor(private readonly rootDir: string) {
    this.jobsDir = join(rootDir, 'jobs');
    this.runEventsDir = join(rootDir, 'run-events');
    this.auditEventsDir = join(rootDir, 'audit-events');
    this.reviewQueuePath = join(rootDir, 'review-queue.json');
  }

  async initialize(): Promise<void> {
    await Promise.all([
      ensureDirectory(this.jobsDir),
      ensureDirectory(this.runEventsDir),
      ensureDirectory(this.auditEventsDir),
    ]);
  }

  async createJob(job: AnalysisJobRecord): Promise<AnalysisJobRecord> {
    await this.initialize();
    const parsed = analysisJobRecordSchema.parse(job);
    await writeJson(this.jobPath(parsed.jobId), parsed);
    return parsed;
  }

  async getJob(jobId: string): Promise<AnalysisJobRecord | null> {
    try {
      const job = await readJson<AnalysisJobRecord>(this.jobPath(jobId));
      return analysisJobRecordSchema.parse(job);
    } catch {
      return null;
    }
  }

  async updateJob(job: AnalysisJobRecord): Promise<AnalysisJobRecord> {
    const parsed = analysisJobRecordSchema.parse(job);
    await writeJson(this.jobPath(parsed.jobId), parsed);
    await this.refreshReviewQueue();
    return parsed;
  }

  async listJobs(filters: JobListFilters = {}): Promise<AnalysisJobRecord[]> {
    await this.initialize();
    const entries = await readdir(this.jobsDir);
    const jobs = await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => this.getJob(entry.replace(/\.json$/, ''))),
    );

    return jobs
      .filter((job): job is AnalysisJobRecord => job !== null)
      .filter((job) => !filters.tenantId || job.tenantId === filters.tenantId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async listReviewQueue(tenantId?: string): Promise<ReviewQueueSnapshot> {
    try {
      const snapshot = await readJson<ReviewQueueSnapshot>(this.reviewQueuePath);
      const parsed = reviewQueueSnapshotSchema.parse(snapshot);

      if (!tenantId) {
        return parsed;
      }

      return reviewQueueSnapshotSchema.parse({
        ...parsed,
        items: parsed.items.filter((item) => item.tenantId === tenantId),
      });
    } catch {
      await this.refreshReviewQueue();
      return this.listReviewQueue(tenantId);
    }
  }

  async appendRunEvent(event: RunEvent): Promise<RunEvent> {
    const parsed = runEventSchema.parse(event);
    const snapshot = await this.listRunEvents(parsed.runId);

    snapshot.events.push(parsed);
    snapshot.events.sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    await writeJson(this.runEventsPath(parsed.runId), snapshot);
    return parsed;
  }

  async listRunEvents(runId: string): Promise<RunEventsSnapshot> {
    try {
      const snapshot = await readJson<RunEventsSnapshot>(this.runEventsPath(runId));
      return runEventsSnapshotSchema.parse(snapshot);
    } catch {
      return runEventsSnapshotSchema.parse({
        runId,
        events: [],
      });
    }
  }

  async appendAuditEvent(event: AuditEvent): Promise<AuditEvent> {
    const parsed = auditEventSchema.parse(event);
    await writeJson(this.auditEventPath(parsed.auditId), parsed);
    return parsed;
  }

  async listAuditEvents(filters: AuditEventFilters = {}): Promise<AuditEventsSnapshot> {
    await this.initialize();
    const entries = await readdir(this.auditEventsDir);
    const events = await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json'))
        .map(async (entry) => {
          const event = await readJson<AuditEvent>(join(this.auditEventsDir, entry));
          return auditEventSchema.parse(event);
        }),
    );

    const filtered = events
      .filter((event) => !filters.tenantId || event.tenantId === filters.tenantId)
      .filter((event) => !filters.resourceId || event.resourceId === filters.resourceId)
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));

    return auditEventsSnapshotSchema.parse({
      items: filtered,
    });
  }

  async claimNextQueuedJob(_workerId: string, claimedAt: string): Promise<AnalysisJobRecord | null> {
    const jobs = await this.listJobs();
    const nextJob = jobs.find((job) => job.status === 'QUEUED');

    if (!nextJob) {
      return null;
    }

    return this.updateJob({
      ...nextJob,
      status: 'RUNNING',
      updatedAt: claimedAt,
    });
  }

  private async refreshReviewQueue(): Promise<void> {
    const jobs = await this.listJobs();
    const items = jobs
      .filter((job) => job.status === 'COMPLETED' && job.result?.review.state === 'NEEDS_REVIEW')
      .map((job) => reviewQueueItemSchema.parse({
        jobId: job.jobId,
        tenantId: job.tenantId,
        conversationId: job.conversationId,
        review: job.result!.review,
        severity: this.deriveSeverity(job.result!.tenantMappedEvents),
        createdAt: job.updatedAt,
      }));

    await writeJson(this.reviewQueuePath, {
      generatedAt: new Date().toISOString(),
      items,
    });
  }

  private deriveSeverity(
    tenantMappedEvents: Array<{ severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' }>,
  ): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
    if (tenantMappedEvents.some((event) => event.severity === 'CRITICAL')) {
      return 'CRITICAL';
    }

    if (tenantMappedEvents.some((event) => event.severity === 'HIGH')) {
      return 'HIGH';
    }

    if (tenantMappedEvents.some((event) => event.severity === 'MEDIUM')) {
      return 'MEDIUM';
    }

    return 'LOW';
  }

  private jobPath(jobId: string): string {
    return join(this.jobsDir, `${jobId}.json`);
  }

  private runEventsPath(runId: string): string {
    return join(this.runEventsDir, `${runId}.json`);
  }

  private auditEventPath(auditId: string): string {
    return join(this.auditEventsDir, `${auditId}.json`);
  }
}
