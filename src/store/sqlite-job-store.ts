import Database from 'better-sqlite3';
import { dirname } from 'path';
import { mkdirSync } from 'fs';
import {
  AnalysisJobRecord,
  ReviewQueueSnapshot,
  analysisJobRecordSchema,
  reviewQueueSnapshotSchema,
} from '../contracts/jobs';
import { reviewQueueItemSchema } from '../contracts/analysis';
import { JobStore } from './job-store';

type JobRow = {
  job_id: string;
  status: string;
  tenant_id: string;
  conversation_id: string | null;
  use_case: string;
  created_at: string;
  updated_at: string;
  worker_id: string | null;
  request_json: string | null;
  pii_redaction_summary_json: string | null;
  result_json: string | null;
  error_json: string | null;
};

export class SqliteJobStore implements JobStore {
  private readonly database: Database.Database;

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.database = new Database(filePath);
    this.database.pragma('journal_mode = WAL');
  }

  async initialize(): Promise<void> {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        conversation_id TEXT,
        use_case TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        worker_id TEXT,
        request_json TEXT,
        pii_redaction_summary_json TEXT,
        result_json TEXT,
        error_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status_created_at
      ON jobs(status, created_at);
    `);

    const columns = this.database
      .prepare("SELECT name FROM pragma_table_info('jobs')")
      .all() as Array<{ name: string }>;

    if (!columns.some((column) => column.name === 'pii_redaction_summary_json')) {
      this.database.exec('ALTER TABLE jobs ADD COLUMN pii_redaction_summary_json TEXT');
    }
  }

  close(): void {
    this.database.close();
  }

  async createJob(job: AnalysisJobRecord): Promise<AnalysisJobRecord> {
    const parsed = analysisJobRecordSchema.parse(job);

    this.database
      .prepare(`
        INSERT INTO jobs (
        job_id, status, tenant_id, conversation_id, use_case,
        created_at, updated_at, worker_id, request_json, pii_redaction_summary_json, result_json, error_json
        ) VALUES (
          @job_id, @status, @tenant_id, @conversation_id, @use_case,
          @created_at, @updated_at, @worker_id, @request_json, @pii_redaction_summary_json, @result_json, @error_json
        )
      `)
      .run(this.toRow(parsed));

    return parsed;
  }

  async getJob(jobId: string): Promise<AnalysisJobRecord | null> {
    const row = this.database
      .prepare('SELECT * FROM jobs WHERE job_id = ?')
      .get(jobId) as JobRow | undefined;

    return row ? this.fromRow(row) : null;
  }

  async updateJob(job: AnalysisJobRecord): Promise<AnalysisJobRecord> {
    const parsed = analysisJobRecordSchema.parse(job);

    this.database
      .prepare(`
        UPDATE jobs
        SET
          status = @status,
          tenant_id = @tenant_id,
          conversation_id = @conversation_id,
          use_case = @use_case,
          created_at = @created_at,
          updated_at = @updated_at,
          worker_id = @worker_id,
          request_json = @request_json,
          pii_redaction_summary_json = @pii_redaction_summary_json,
          result_json = @result_json,
          error_json = @error_json
        WHERE job_id = @job_id
      `)
      .run(this.toRow(parsed));

    return parsed;
  }

  async listJobs(): Promise<AnalysisJobRecord[]> {
    const rows = this.database
      .prepare('SELECT * FROM jobs ORDER BY created_at ASC')
      .all() as JobRow[];

    return rows.map((row) => this.fromRow(row));
  }

  async listReviewQueue(): Promise<ReviewQueueSnapshot> {
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

    return reviewQueueSnapshotSchema.parse({
      generatedAt: new Date().toISOString(),
      items,
    });
  }

  async claimNextQueuedJob(workerId: string, claimedAt: string): Promise<AnalysisJobRecord | null> {
    const transaction = this.database.transaction((id: string, updatedAt: string) => {
      const row = this.database
        .prepare(`
          SELECT * FROM jobs
          WHERE status = 'QUEUED'
          ORDER BY created_at ASC
          LIMIT 1
        `)
        .get() as JobRow | undefined;

      if (!row) {
        return null;
      }

      this.database
        .prepare(`
          UPDATE jobs
          SET status = 'RUNNING', updated_at = ?, worker_id = ?
          WHERE job_id = ?
        `)
        .run(updatedAt, id, row.job_id);

      const claimedRow = this.database
        .prepare('SELECT * FROM jobs WHERE job_id = ?')
        .get(row.job_id) as JobRow;

      return this.fromRow(claimedRow);
    });

    return transaction(workerId, claimedAt);
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

  private toRow(job: AnalysisJobRecord): JobRow {
    return {
      job_id: job.jobId,
      status: job.status,
      tenant_id: job.tenantId,
      conversation_id: job.conversationId ?? null,
      use_case: job.useCase,
      created_at: job.createdAt,
      updated_at: job.updatedAt,
      worker_id: null,
      request_json: job.request ? JSON.stringify(job.request) : null,
      pii_redaction_summary_json: job.piiRedactionSummary ? JSON.stringify(job.piiRedactionSummary) : null,
      result_json: job.result ? JSON.stringify(job.result) : null,
      error_json: job.error ? JSON.stringify(job.error) : null,
    };
  }

  private fromRow(row: JobRow): AnalysisJobRecord {
    return analysisJobRecordSchema.parse({
      jobId: row.job_id,
      status: row.status,
      tenantId: row.tenant_id,
      conversationId: row.conversation_id ?? undefined,
      useCase: row.use_case,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      request: row.request_json ? JSON.parse(row.request_json) : undefined,
      piiRedactionSummary: row.pii_redaction_summary_json ? JSON.parse(row.pii_redaction_summary_json) : undefined,
      result: row.result_json ? JSON.parse(row.result_json) : undefined,
      error: row.error_json ? JSON.parse(row.error_json) : undefined,
    });
  }
}
