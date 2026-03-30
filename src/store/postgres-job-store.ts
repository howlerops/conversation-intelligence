import { Pool, PoolClient } from 'pg';
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

type QueryResultRow = Record<string, unknown>;

type PostgresQueryable = {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<{
    rows: T[];
    rowCount: number | null;
  }>;
};

type PostgresPoolLike = PostgresQueryable & {
  connect(): Promise<PoolClient>;
  end?(): Promise<void>;
};

export interface PostgresJobStoreOptions {
  connectionString?: string;
  pool?: PostgresPoolLike;
}

export class PostgresJobStore implements JobStore {
  private readonly pool: PostgresPoolLike;
  private readonly ownsPool: boolean;

  constructor(options: PostgresJobStoreOptions = {}) {
    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
      return;
    }

    if (!options.connectionString) {
      throw new Error('PostgresJobStore requires either a connectionString or an existing pool.');
    }

    this.pool = new Pool({
      connectionString: options.connectionString,
    });
    this.ownsPool = true;
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        conversation_id TEXT,
        use_case TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        worker_id TEXT,
        request_json JSONB,
        pii_redaction_summary_json JSONB,
        result_json JSONB,
        error_json JSONB
      );

      CREATE TABLE IF NOT EXISTS run_events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        summary TEXT NOT NULL,
        actor_json JSONB,
        metadata_json JSONB
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        audit_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT,
        occurred_at TEXT NOT NULL,
        actor_json JSONB NOT NULL,
        metadata_json JSONB
      );

      CREATE INDEX IF NOT EXISTS idx_pg_jobs_status_created_at ON jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_pg_jobs_tenant_created_at ON jobs(tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_pg_run_events_run_created_at ON run_events(run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_pg_audit_events_tenant_occurred_at ON audit_events(tenant_id, occurred_at);
    `);
  }

  async close(): Promise<void> {
    if (this.ownsPool && this.pool.end) {
      await this.pool.end();
    }
  }

  async createJob(job: AnalysisJobRecord): Promise<AnalysisJobRecord> {
    const parsed = analysisJobRecordSchema.parse(job);
    await this.pool.query(
      `
        INSERT INTO jobs (
          job_id, status, tenant_id, conversation_id, use_case,
          created_at, updated_at, worker_id, request_json,
          pii_redaction_summary_json, result_json, error_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb)
      `,
      this.jobParams(parsed),
    );
    return parsed;
  }

  async getJob(jobId: string): Promise<AnalysisJobRecord | null> {
    const result = await this.pool.query('SELECT * FROM jobs WHERE job_id = $1', [jobId]);
    return result.rows[0] ? this.fromJobRow(result.rows[0]) : null;
  }

  async updateJob(job: AnalysisJobRecord): Promise<AnalysisJobRecord> {
    const parsed = analysisJobRecordSchema.parse(job);
    await this.pool.query(
      `
        UPDATE jobs
        SET
          status = $2,
          tenant_id = $3,
          conversation_id = $4,
          use_case = $5,
          created_at = $6,
          updated_at = $7,
          worker_id = $8,
          request_json = $9::jsonb,
          pii_redaction_summary_json = $10::jsonb,
          result_json = $11::jsonb,
          error_json = $12::jsonb
        WHERE job_id = $1
      `,
      this.jobParams(parsed),
    );
    return parsed;
  }

  async listJobs(filters: JobListFilters = {}): Promise<AnalysisJobRecord[]> {
    const result = filters.tenantId
      ? await this.pool.query('SELECT * FROM jobs WHERE tenant_id = $1 ORDER BY created_at ASC', [filters.tenantId])
      : await this.pool.query('SELECT * FROM jobs ORDER BY created_at ASC');

    return result.rows.map((row) => this.fromJobRow(row));
  }

  async listReviewQueue(tenantId?: string): Promise<ReviewQueueSnapshot> {
    const jobs = await this.listJobs(tenantId ? { tenantId } : {});

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
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      let updateResult;

      try {
        updateResult = await client.query(
          `
            WITH next_job AS (
              SELECT job_id
              FROM jobs
              WHERE status = 'QUEUED'
              ORDER BY created_at ASC
              FOR UPDATE SKIP LOCKED
              LIMIT 1
            )
            UPDATE jobs
            SET status = 'RUNNING', updated_at = $1, worker_id = $2
            WHERE job_id = (SELECT job_id FROM next_job)
            RETURNING *
          `,
          [claimedAt, workerId],
        );
      } catch (error) {
        if (!this.isLockingSyntaxUnsupported(error)) {
          throw error;
        }

        // pg-mem does not implement FOR UPDATE SKIP LOCKED, so tests fall back
        // to a simpler select-then-update flow while production Postgres keeps
        // the row-locking query above.
        const nextResult = await client.query(
          `
            SELECT job_id
            FROM jobs
            WHERE status = 'QUEUED'
            ORDER BY created_at ASC
            LIMIT 1
          `,
        );

        if (!nextResult.rows[0]) {
          await client.query('COMMIT');
          return null;
        }

        updateResult = await client.query(
          `
            UPDATE jobs
            SET status = 'RUNNING', updated_at = $1, worker_id = $2
            WHERE job_id = $3 AND status = 'QUEUED'
            RETURNING *
          `,
          [claimedAt, workerId, String(nextResult.rows[0].job_id)],
        );
      }

      await client.query('COMMIT');
      return updateResult.rows[0] ? this.fromJobRow(updateResult.rows[0]) : null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async appendRunEvent(event: RunEvent): Promise<RunEvent> {
    const parsed = runEventSchema.parse(event);
    await this.pool.query(
      `
        INSERT INTO run_events (
          event_id, run_id, tenant_id, type, created_at, summary, actor_json, metadata_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
      `,
      [
        parsed.eventId,
        parsed.runId,
        parsed.tenantId,
        parsed.type,
        parsed.createdAt,
        parsed.summary,
        parsed.actor ? JSON.stringify(parsed.actor) : null,
        JSON.stringify(parsed.metadata),
      ],
    );
    return parsed;
  }

  async listRunEvents(runId: string): Promise<RunEventsSnapshot> {
    const result = await this.pool.query(
      'SELECT * FROM run_events WHERE run_id = $1 ORDER BY created_at ASC',
      [runId],
    );

    return runEventsSnapshotSchema.parse({
      runId,
      events: result.rows.map((row) => this.fromRunEventRow(row)),
    });
  }

  async appendAuditEvent(event: AuditEvent): Promise<AuditEvent> {
    const parsed = auditEventSchema.parse(event);
    await this.pool.query(
      `
        INSERT INTO audit_events (
          audit_id, tenant_id, action, resource_type, resource_id,
          occurred_at, actor_json, metadata_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
      `,
      [
        parsed.auditId,
        parsed.tenantId,
        parsed.action,
        parsed.resourceType,
        parsed.resourceId ?? null,
        parsed.occurredAt,
        JSON.stringify(parsed.actor),
        JSON.stringify(parsed.metadata),
      ],
    );
    return parsed;
  }

  async listAuditEvents(filters: AuditEventFilters = {}): Promise<AuditEventsSnapshot> {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters.tenantId) {
      params.push(filters.tenantId);
      clauses.push(`tenant_id = $${params.length}`);
    }

    if (filters.resourceId) {
      params.push(filters.resourceId);
      clauses.push(`resource_id = $${params.length}`);
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT * FROM audit_events ${whereClause} ORDER BY occurred_at ASC`,
      params,
    );

    return auditEventsSnapshotSchema.parse({
      items: result.rows.map((row) => this.fromAuditEventRow(row)),
    });
  }

  private jobParams(job: AnalysisJobRecord): unknown[] {
    return [
      job.jobId,
      job.status,
      job.tenantId,
      job.conversationId ?? null,
      job.useCase,
      job.createdAt,
      job.updatedAt,
      null,
      job.request ? JSON.stringify(job.request) : null,
      job.piiRedactionSummary ? JSON.stringify(job.piiRedactionSummary) : null,
      job.result ? JSON.stringify(job.result) : null,
      job.error ? JSON.stringify(job.error) : null,
    ];
  }

  private fromJobRow(row: QueryResultRow): AnalysisJobRecord {
    return analysisJobRecordSchema.parse({
      jobId: String(row.job_id),
      status: String(row.status),
      tenantId: String(row.tenant_id),
      conversationId: row.conversation_id ? String(row.conversation_id) : undefined,
      useCase: String(row.use_case),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      request: this.parseJsonValue(row.request_json),
      piiRedactionSummary: this.parseJsonValue(row.pii_redaction_summary_json),
      result: this.parseJsonValue(row.result_json),
      error: this.parseJsonValue(row.error_json),
    });
  }

  private fromRunEventRow(row: QueryResultRow): RunEvent {
    return runEventSchema.parse({
      eventId: String(row.event_id),
      runId: String(row.run_id),
      tenantId: String(row.tenant_id),
      type: String(row.type),
      createdAt: String(row.created_at),
      summary: String(row.summary),
      actor: this.parseJsonValue(row.actor_json),
      metadata: this.parseJsonValue(row.metadata_json) ?? {},
    });
  }

  private fromAuditEventRow(row: QueryResultRow): AuditEvent {
    return auditEventSchema.parse({
      auditId: String(row.audit_id),
      tenantId: String(row.tenant_id),
      action: String(row.action),
      resourceType: String(row.resource_type),
      resourceId: row.resource_id ? String(row.resource_id) : undefined,
      occurredAt: String(row.occurred_at),
      actor: this.parseJsonValue(row.actor_json),
      metadata: this.parseJsonValue(row.metadata_json) ?? {},
    });
  }

  private parseJsonValue(value: unknown): unknown {
    if (value === null || value === undefined) {
      return undefined;
    }

    if (typeof value === 'string') {
      return JSON.parse(value);
    }

    return value;
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

  private isLockingSyntaxUnsupported(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('FOR UPDATE SKIP LOCKED')
      || message.includes('Unexpected kw_limit token')
      || message.includes('Unexpected kw_skip token');
  }
}
