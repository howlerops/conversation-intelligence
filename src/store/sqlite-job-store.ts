import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
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

type RunEventRow = {
  event_id: string;
  run_id: string;
  tenant_id: string;
  type: string;
  created_at: string;
  summary: string;
  actor_json: string | null;
  metadata_json: string | null;
};

type AuditEventRow = {
  audit_id: string;
  tenant_id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  occurred_at: string;
  actor_json: string;
  metadata_json: string | null;
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

      CREATE TABLE IF NOT EXISTS run_events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        summary TEXT NOT NULL,
        actor_json TEXT,
        metadata_json TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        audit_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT,
        occurred_at TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status_created_at
      ON jobs(status, created_at);

      CREATE INDEX IF NOT EXISTS idx_jobs_tenant_created_at
      ON jobs(tenant_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_run_events_run_created_at
      ON run_events(run_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_occurred_at
      ON audit_events(tenant_id, occurred_at);
    `);

    this.ensureColumn('jobs', 'pii_redaction_summary_json', 'TEXT');
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
          created_at, updated_at, worker_id, request_json,
          pii_redaction_summary_json, result_json, error_json
        ) VALUES (
          @job_id, @status, @tenant_id, @conversation_id, @use_case,
          @created_at, @updated_at, @worker_id, @request_json,
          @pii_redaction_summary_json, @result_json, @error_json
        )
      `)
      .run(this.toJobRow(parsed));

    return parsed;
  }

  async getJob(jobId: string): Promise<AnalysisJobRecord | null> {
    const row = this.database
      .prepare('SELECT * FROM jobs WHERE job_id = ?')
      .get(jobId) as JobRow | undefined;

    return row ? this.fromJobRow(row) : null;
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
      .run(this.toJobRow(parsed));

    return parsed;
  }

  async listJobs(filters: JobListFilters = {}): Promise<AnalysisJobRecord[]> {
    const rows = filters.tenantId
      ? this.database
        .prepare('SELECT * FROM jobs WHERE tenant_id = ? ORDER BY created_at ASC')
        .all(filters.tenantId)
      : this.database
        .prepare('SELECT * FROM jobs ORDER BY created_at ASC')
        .all();

    return (rows as JobRow[]).map((row) => this.fromJobRow(row));
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
    const transaction = this.database.transaction((id: string, updatedAt: string) => {
      const queuedRow = this.database
        .prepare(`
          SELECT * FROM jobs
          WHERE status = 'QUEUED'
          ORDER BY created_at ASC
          LIMIT 1
        `)
        .get() as JobRow | undefined;

      if (!queuedRow) {
        return null;
      }

      const result = this.database
        .prepare(`
          UPDATE jobs
          SET status = 'RUNNING', updated_at = ?, worker_id = ?
          WHERE job_id = ? AND status = 'QUEUED'
        `)
        .run(updatedAt, id, queuedRow.job_id);

      if (result.changes === 0) {
        return null;
      }

      const claimedRow = this.database
        .prepare('SELECT * FROM jobs WHERE job_id = ?')
        .get(queuedRow.job_id) as JobRow;

      return this.fromJobRow(claimedRow);
    });

    return transaction(workerId, claimedAt);
  }

  async appendRunEvent(event: RunEvent): Promise<RunEvent> {
    const parsed = runEventSchema.parse(event);

    this.database
      .prepare(`
        INSERT INTO run_events (
          event_id, run_id, tenant_id, type, created_at, summary, actor_json, metadata_json
        ) VALUES (
          @event_id, @run_id, @tenant_id, @type, @created_at, @summary, @actor_json, @metadata_json
        )
      `)
      .run(this.toRunEventRow(parsed));

    return parsed;
  }

  async listRunEvents(runId: string): Promise<RunEventsSnapshot> {
    const rows = this.database
      .prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY created_at ASC')
      .all(runId) as RunEventRow[];

    return runEventsSnapshotSchema.parse({
      runId,
      events: rows.map((row) => this.fromRunEventRow(row)),
    });
  }

  async appendAuditEvent(event: AuditEvent): Promise<AuditEvent> {
    const parsed = auditEventSchema.parse(event);

    this.database
      .prepare(`
        INSERT INTO audit_events (
          audit_id, tenant_id, action, resource_type, resource_id,
          occurred_at, actor_json, metadata_json
        ) VALUES (
          @audit_id, @tenant_id, @action, @resource_type, @resource_id,
          @occurred_at, @actor_json, @metadata_json
        )
      `)
      .run(this.toAuditEventRow(parsed));

    return parsed;
  }

  async listAuditEvents(filters: AuditEventFilters = {}): Promise<AuditEventsSnapshot> {
    let query = 'SELECT * FROM audit_events';
    const params: string[] = [];
    const clauses: string[] = [];

    if (filters.tenantId) {
      clauses.push('tenant_id = ?');
      params.push(filters.tenantId);
    }

    if (filters.resourceId) {
      clauses.push('resource_id = ?');
      params.push(filters.resourceId);
    }

    if (clauses.length > 0) {
      query += ` WHERE ${clauses.join(' AND ')}`;
    }

    query += ' ORDER BY occurred_at ASC';

    const rows = this.database.prepare(query).all(...params) as AuditEventRow[];

    return auditEventsSnapshotSchema.parse({
      items: rows.map((row) => this.fromAuditEventRow(row)),
    });
  }

  private ensureColumn(tableName: string, columnName: string, columnDefinition: string): void {
    const columns = this.database
      .prepare(`SELECT name FROM pragma_table_info('${tableName}')`)
      .all() as Array<{ name: string }>;

    if (!columns.some((column) => column.name === columnName)) {
      this.database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
    }
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

  private toJobRow(job: AnalysisJobRecord): JobRow {
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

  private fromJobRow(row: JobRow): AnalysisJobRecord {
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

  private toRunEventRow(event: RunEvent): RunEventRow {
    return {
      event_id: event.eventId,
      run_id: event.runId,
      tenant_id: event.tenantId,
      type: event.type,
      created_at: event.createdAt,
      summary: event.summary,
      actor_json: event.actor ? JSON.stringify(event.actor) : null,
      metadata_json: JSON.stringify(event.metadata),
    };
  }

  private fromRunEventRow(row: RunEventRow): RunEvent {
    return runEventSchema.parse({
      eventId: row.event_id,
      runId: row.run_id,
      tenantId: row.tenant_id,
      type: row.type,
      createdAt: row.created_at,
      summary: row.summary,
      actor: row.actor_json ? JSON.parse(row.actor_json) : undefined,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
    });
  }

  private toAuditEventRow(event: AuditEvent): AuditEventRow {
    return {
      audit_id: event.auditId,
      tenant_id: event.tenantId,
      action: event.action,
      resource_type: event.resourceType,
      resource_id: event.resourceId ?? null,
      occurred_at: event.occurredAt,
      actor_json: JSON.stringify(event.actor),
      metadata_json: JSON.stringify(event.metadata),
    };
  }

  private fromAuditEventRow(row: AuditEventRow): AuditEvent {
    return auditEventSchema.parse({
      auditId: row.audit_id,
      tenantId: row.tenant_id,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id ?? undefined,
      occurredAt: row.occurred_at,
      actor: JSON.parse(row.actor_json),
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
    });
  }
}
