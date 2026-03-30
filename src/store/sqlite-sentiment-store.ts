import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import {
  CalibrationSampleRecord,
  KeyMomentRecord,
  PhraseSearchResult,
  SentimentAnalysisRecord,
  SentimentSegmentRecord,
  SentimentTrendPoint,
  calibrationSampleRecordSchema,
  keyMomentRecordSchema,
  phraseSearchResultSchema,
  sentimentAnalysisRecordSchema,
  sentimentSegmentRecordSchema,
  sentimentTrendPointSchema,
} from '../contracts/sentiment-persistence';
import {
  CalibrationSampleFilters,
  KeyMomentFilters,
  SentimentAnalysisFilters,
  SentimentStore,
  TrendBucket,
} from './sentiment-store';

type Row = Record<string, unknown>;

export class SqliteSentimentStore implements SentimentStore {
  private db!: Database.Database;

  constructor(private readonly dbPath: string) {}

  async initialize(): Promise<void> {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sentiment_analyses (
        job_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        conversation_id TEXT,
        use_case TEXT NOT NULL,
        engagement_type TEXT,
        polarity TEXT NOT NULL,
        intensity REAL NOT NULL,
        confidence REAL NOT NULL,
        score100 INTEGER NOT NULL,
        score5 INTEGER NOT NULL,
        scoring_method TEXT,
        calibration_offset INTEGER,
        aspect_count INTEGER NOT NULL DEFAULT 0,
        event_count INTEGER NOT NULL DEFAULT 0,
        key_moment_count INTEGER NOT NULL DEFAULT 0,
        analyzed_at TEXT NOT NULL,
        pack_version TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_sa_tenant_analyzed ON sentiment_analyses(tenant_id, analyzed_at);
      CREATE INDEX IF NOT EXISTS idx_sa_tenant_polarity ON sentiment_analyses(tenant_id, polarity);
      CREATE INDEX IF NOT EXISTS idx_sa_tenant_score ON sentiment_analyses(tenant_id, score100);

      CREATE TABLE IF NOT EXISTS sentiment_segments (
        segment_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        speaker_role TEXT NOT NULL,
        text TEXT NOT NULL,
        polarity TEXT,
        confidence REAL,
        aspect_target TEXT,
        aspect_name TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_ss_tenant ON sentiment_segments(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_ss_job ON sentiment_segments(job_id);

      CREATE TABLE IF NOT EXISTS key_moments (
        moment_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        type TEXT NOT NULL,
        actor_role TEXT NOT NULL,
        start_turn_id TEXT NOT NULL,
        end_turn_id TEXT NOT NULL,
        confidence REAL NOT NULL,
        business_impact TEXT NOT NULL,
        rationale TEXT NOT NULL,
        evidence_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_km_tenant_type ON key_moments(tenant_id, type);
      CREATE INDEX IF NOT EXISTS idx_km_tenant_impact ON key_moments(tenant_id, business_impact);

      CREATE TABLE IF NOT EXISTS calibration_samples (
        sample_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        use_case TEXT NOT NULL,
        engagement_type TEXT,
        model_polarity TEXT NOT NULL,
        model_intensity REAL NOT NULL,
        model_confidence REAL NOT NULL,
        model_score100 INTEGER NOT NULL,
        model_score5 INTEGER NOT NULL,
        analyst_score100 INTEGER NOT NULL,
        analyst_score5 INTEGER NOT NULL,
        delta_score100 INTEGER NOT NULL,
        delta_score5 INTEGER NOT NULL,
        correction_applied INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cs_tenant_created ON calibration_samples(tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_cs_tenant_usecase ON calibration_samples(tenant_id, use_case);
    `);
  }

  // ---------------------------------------------------------------------------
  // Sentiment analyses
  // ---------------------------------------------------------------------------

  async saveSentimentAnalysis(record: SentimentAnalysisRecord): Promise<SentimentAnalysisRecord> {
    const parsed = sentimentAnalysisRecordSchema.parse(record);
    this.db.prepare(`
      INSERT OR IGNORE INTO sentiment_analyses (
        job_id, tenant_id, conversation_id, use_case, engagement_type,
        polarity, intensity, confidence, score100, score5,
        scoring_method, calibration_offset, aspect_count, event_count,
        key_moment_count, analyzed_at, pack_version
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      parsed.jobId, parsed.tenantId, parsed.conversationId ?? null,
      parsed.useCase, parsed.engagementType ?? null,
      parsed.polarity, parsed.intensity, parsed.confidence,
      parsed.score100, parsed.score5,
      parsed.scoringMethod ?? null, parsed.calibrationOffset ?? null,
      parsed.aspectCount, parsed.eventCount,
      parsed.keyMomentCount, parsed.analyzedAt, parsed.packVersion ?? null,
    );
    return parsed;
  }

  async getSentimentAnalysis(jobId: string): Promise<SentimentAnalysisRecord | null> {
    const row = this.db.prepare('SELECT * FROM sentiment_analyses WHERE job_id = ?').get(jobId) as Row | undefined;
    return row ? this.fromAnalysisRow(row) : null;
  }

  async listSentimentAnalyses(filters: SentimentAnalysisFilters = {}): Promise<SentimentAnalysisRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.tenantId) {
      conditions.push('tenant_id = ?');
      params.push(filters.tenantId);
    }
    if (filters.polarity) {
      conditions.push('polarity = ?');
      params.push(filters.polarity);
    }
    if (filters.minScore100 !== undefined) {
      conditions.push('score100 >= ?');
      params.push(filters.minScore100);
    }
    if (filters.maxScore100 !== undefined) {
      conditions.push('score100 <= ?');
      params.push(filters.maxScore100);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters.limit ?? 100, 500);
    const offset = filters.offset ?? 0;

    const rows = this.db.prepare(
      `SELECT * FROM sentiment_analyses ${where} ORDER BY analyzed_at DESC LIMIT ? OFFSET ?`,
    ).all([...params, limit, offset]) as Row[];
    return rows.map((row) => this.fromAnalysisRow(row));
  }

  // ---------------------------------------------------------------------------
  // Sentiment segments & phrase search
  // ---------------------------------------------------------------------------

  async saveSentimentSegments(segments: SentimentSegmentRecord[]): Promise<void> {
    if (segments.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO sentiment_segments (
        segment_id, job_id, tenant_id, turn_id, speaker_role,
        text, polarity, confidence, aspect_target, aspect_name
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
    `);

    const insertMany = this.db.transaction((segs: SentimentSegmentRecord[]) => {
      for (const raw of segs) {
        const seg = sentimentSegmentRecordSchema.parse(raw);
        stmt.run(
          seg.segmentId, seg.jobId, seg.tenantId, seg.turnId, seg.speakerRole,
          seg.text, seg.polarity ?? null, seg.confidence ?? null,
          seg.aspectTarget ?? null, seg.aspectName ?? null,
        );
      }
    });

    insertMany(segments);
  }

  async searchSegmentsByPhrase(tenantId: string, query: string, limit = 50): Promise<PhraseSearchResult[]> {
    const maxLimit = Math.min(limit, 200);
    const rows = this.db.prepare(
      `SELECT *, 1.0 AS rank, text AS headline
      FROM sentiment_segments
      WHERE tenant_id = ?
        AND LOWER(text) LIKE LOWER(?)
      ORDER BY turn_id
      LIMIT ?`,
    ).all(tenantId, `%${query}%`, maxLimit) as Row[];
    return rows.map((row) => this.fromPhraseSearchRow(row));
  }

  // ---------------------------------------------------------------------------
  // Key moments
  // ---------------------------------------------------------------------------

  async saveKeyMoments(moments: KeyMomentRecord[]): Promise<void> {
    if (moments.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO key_moments (
        moment_id, job_id, tenant_id, type, actor_role,
        start_turn_id, end_turn_id, confidence, business_impact,
        rationale, evidence_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `);

    const insertMany = this.db.transaction((kms: KeyMomentRecord[]) => {
      for (const raw of kms) {
        const km = keyMomentRecordSchema.parse(raw);
        stmt.run(
          km.momentId, km.jobId, km.tenantId, km.type, km.actorRole,
          km.startTurnId, km.endTurnId, km.confidence, km.businessImpact,
          km.rationale, km.evidenceJson,
        );
      }
    });

    insertMany(moments);
  }

  async listKeyMoments(filters: KeyMomentFilters = {}): Promise<KeyMomentRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.tenantId) {
      conditions.push('tenant_id = ?');
      params.push(filters.tenantId);
    }
    if (filters.type) {
      conditions.push('type = ?');
      params.push(filters.type);
    }
    if (filters.businessImpact) {
      conditions.push('business_impact = ?');
      params.push(filters.businessImpact);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters.limit ?? 100, 500);
    const offset = filters.offset ?? 0;

    const rows = this.db.prepare(
      `SELECT * FROM key_moments ${where} ORDER BY confidence DESC LIMIT ? OFFSET ?`,
    ).all([...params, limit, offset]) as Row[];
    return rows.map((row) => this.fromKeyMomentRow(row));
  }

  // ---------------------------------------------------------------------------
  // Calibration samples
  // ---------------------------------------------------------------------------

  async saveCalibrationSample(sample: CalibrationSampleRecord): Promise<CalibrationSampleRecord> {
    const parsed = calibrationSampleRecordSchema.parse(sample);
    this.db.prepare(`
      INSERT OR IGNORE INTO calibration_samples (
        sample_id, job_id, tenant_id, use_case, engagement_type,
        model_polarity, model_intensity, model_confidence,
        model_score100, model_score5,
        analyst_score100, analyst_score5,
        delta_score100, delta_score5,
        correction_applied, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      parsed.sampleId, parsed.jobId, parsed.tenantId,
      parsed.useCase, parsed.engagementType ?? null,
      parsed.modelPolarity, parsed.modelIntensity, parsed.modelConfidence,
      parsed.modelScore100, parsed.modelScore5,
      parsed.analystScore100, parsed.analystScore5,
      parsed.deltaScore100, parsed.deltaScore5,
      parsed.correctionApplied ? 1 : 0, parsed.createdAt,
    );
    return parsed;
  }

  async listCalibrationSamples(filters: CalibrationSampleFilters = {}): Promise<CalibrationSampleRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.tenantId) {
      conditions.push('tenant_id = ?');
      params.push(filters.tenantId);
    }
    if (filters.useCase) {
      conditions.push('use_case = ?');
      params.push(filters.useCase);
    }
    if (filters.engagementType) {
      conditions.push('engagement_type = ?');
      params.push(filters.engagementType);
    }
    if (filters.sinceDate) {
      conditions.push('created_at >= ?');
      params.push(filters.sinceDate);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters.limit ?? 500, 2000);

    const rows = this.db.prepare(
      `SELECT * FROM calibration_samples ${where} ORDER BY created_at DESC LIMIT ?`,
    ).all([...params, limit]) as Row[];
    return rows.map((row) => this.fromCalibrationRow(row));
  }

  // ---------------------------------------------------------------------------
  // Trend aggregation
  // ---------------------------------------------------------------------------

  async getSentimentTrend(tenantId: string, bucket: TrendBucket, days: number): Promise<SentimentTrendPoint[]> {
    const cutoffDate = new Date(Date.now() - days * 86400_000).toISOString();

    // SQLite strftime format for each bucket level
    const fmt = bucket === 'month' ? '%Y-%m' : bucket === 'week' ? '%Y-%W' : '%Y-%m-%d';

    const rows = this.db.prepare(
      `SELECT
        strftime(?, analyzed_at) AS bucket,
        AVG(score100) AS avg_score100,
        AVG(score5) AS avg_score5,
        COUNT(*) AS count,
        AVG(confidence) AS avg_confidence
      FROM sentiment_analyses
      WHERE tenant_id = ?
        AND analyzed_at >= ?
      GROUP BY bucket
      ORDER BY bucket ASC`,
    ).all(fmt, tenantId, cutoffDate) as Row[];

    return rows.map((row) => sentimentTrendPointSchema.parse({
      bucket: String(row.bucket),
      avgScore100: Number(row.avg_score100),
      avgScore5: Number(row.avg_score5),
      count: Number(row.count),
      avgConfidence: Number(row.avg_confidence),
    }));
  }

  close(): void {
    this.db?.close();
  }

  // ---------------------------------------------------------------------------
  // Row mapping helpers
  // ---------------------------------------------------------------------------

  private fromAnalysisRow(row: Row): SentimentAnalysisRecord {
    return sentimentAnalysisRecordSchema.parse({
      jobId: row.job_id,
      tenantId: row.tenant_id,
      conversationId: row.conversation_id ?? undefined,
      useCase: row.use_case,
      engagementType: row.engagement_type ?? undefined,
      polarity: row.polarity,
      intensity: Number(row.intensity),
      confidence: Number(row.confidence),
      score100: Number(row.score100),
      score5: Number(row.score5),
      scoringMethod: row.scoring_method ?? undefined,
      calibrationOffset: row.calibration_offset != null ? Number(row.calibration_offset) : undefined,
      aspectCount: Number(row.aspect_count),
      eventCount: Number(row.event_count),
      keyMomentCount: Number(row.key_moment_count),
      analyzedAt: row.analyzed_at,
      packVersion: row.pack_version ?? undefined,
    });
  }

  private fromPhraseSearchRow(row: Row): PhraseSearchResult {
    return phraseSearchResultSchema.parse({
      segment: this.fromSegmentRow(row),
      headline: String(row.headline),
      rank: Number(row.rank),
    });
  }

  private fromSegmentRow(row: Row): SentimentSegmentRecord {
    return sentimentSegmentRecordSchema.parse({
      segmentId: row.segment_id,
      jobId: row.job_id,
      tenantId: row.tenant_id,
      turnId: row.turn_id,
      speakerRole: row.speaker_role,
      text: row.text,
      polarity: row.polarity ?? undefined,
      confidence: row.confidence != null ? Number(row.confidence) : undefined,
      aspectTarget: row.aspect_target ?? undefined,
      aspectName: row.aspect_name ?? undefined,
    });
  }

  private fromKeyMomentRow(row: Row): KeyMomentRecord {
    return keyMomentRecordSchema.parse({
      momentId: row.moment_id,
      jobId: row.job_id,
      tenantId: row.tenant_id,
      type: row.type,
      actorRole: row.actor_role,
      startTurnId: row.start_turn_id,
      endTurnId: row.end_turn_id,
      confidence: Number(row.confidence),
      businessImpact: row.business_impact,
      rationale: row.rationale,
      evidenceJson: String(row.evidence_json),
    });
  }

  private fromCalibrationRow(row: Row): CalibrationSampleRecord {
    return calibrationSampleRecordSchema.parse({
      sampleId: row.sample_id,
      jobId: row.job_id,
      tenantId: row.tenant_id,
      useCase: row.use_case,
      engagementType: row.engagement_type ?? undefined,
      modelPolarity: row.model_polarity,
      modelIntensity: Number(row.model_intensity),
      modelConfidence: Number(row.model_confidence),
      modelScore100: Number(row.model_score100),
      modelScore5: Number(row.model_score5),
      analystScore100: Number(row.analyst_score100),
      analystScore5: Number(row.analyst_score5),
      deltaScore100: Number(row.delta_score100),
      deltaScore5: Number(row.delta_score5),
      correctionApplied: row.correction_applied === 1 || row.correction_applied === true,
      createdAt: row.created_at,
    });
  }
}
