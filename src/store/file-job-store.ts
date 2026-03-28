import { mkdir, readFile, readdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import {
  AnalysisJobRecord,
  AnalysisRequest,
  ReviewQueueSnapshot,
  analysisJobRecordSchema,
  reviewQueueSnapshotSchema,
} from '../contracts/jobs';
import { reviewQueueItemSchema } from '../contracts/analysis';
import { JobStore } from './job-store';

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
  private readonly reviewQueuePath: string;

  constructor(private readonly rootDir: string) {
    this.jobsDir = join(rootDir, 'jobs');
    this.reviewQueuePath = join(rootDir, 'review-queue.json');
  }

  async initialize(): Promise<void> {
    await ensureDirectory(this.jobsDir);
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

  async listJobs(): Promise<AnalysisJobRecord[]> {
    await this.initialize();
    const entries = await readdir(this.jobsDir);
    const jobs = await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => this.getJob(entry.replace(/\.json$/, ''))),
    );

    return jobs
      .filter((job): job is AnalysisJobRecord => job !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getRequest(jobId: string): Promise<AnalysisRequest | null> {
    const job = await this.getJob(jobId);
    return job?.request ?? null;
  }

  async listReviewQueue(): Promise<ReviewQueueSnapshot> {
    try {
      const snapshot = await readJson<ReviewQueueSnapshot>(this.reviewQueuePath);
      return reviewQueueSnapshotSchema.parse(snapshot);
    } catch {
      await this.refreshReviewQueue();
      const snapshot = await readJson<ReviewQueueSnapshot>(this.reviewQueuePath);
      return reviewQueueSnapshotSchema.parse(snapshot);
    }
  }

  async refreshReviewQueue(): Promise<void> {
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
}
