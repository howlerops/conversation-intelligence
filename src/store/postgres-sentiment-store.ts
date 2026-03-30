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

type QueryResultRow = Record<string, unknown>;

type PostgresQueryable = {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<{
    rows: T[];
    rowCount: number | null;
  }>;
};

type PostgresPoolLike = PostgresQueryable & {
  end?(): Promise<void>;
};

export interface PostgresSentimentStoreOptions {
  pool: PostgresPoolLike;
}

export class PostgresSentimentStore implements SentimentStore {
  private readonly pool: PostgresPoolLike;
  private tsvectorSupported = true;

  constructor(options: PostgresSentimentStoreOptions) {
    this.pool = options.pool;
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
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
    `);

    await this.pool.query(`
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
    `);

    try {
      await this.pool.query(`
        ALTER TABLE sentiment_segments
          ADD COLUMN IF NOT EXISTS tsv TSVECTOR
          GENERATED ALWAYS AS (to_tsvector('english', text)) STORED;
      `);
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_ss_tsv ON sentiment_segments USING GIN (tsv);
      `);
    } catch {
      this.tsvectorSupported = false;
    }

    await this.pool.query(`
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
        evidence_json JSONB NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_km_tenant_type ON key_moments(tenant_id, type);
      CREATE INDEX IF NOT EXISTS idx_km_tenant_impact ON key_moments(tenant_id, business_impact);
    `);

    await this.pool.query(`
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
        correction_applied BOOLEAN NOT NULL,
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
    await this.pool.query(
      `INSERT INTO sentiment_analyses (
        job_id, tenant_id, conversation_id, use_case, engagement_type,
        polarity, intensity, confidence, score100, score5,
        scoring_method, calibration_offset, aspect_count, event_count,
        key_moment_count, analyzed_at, pack_version
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (job_id) DO NOTHING`,
      [
        parsed.jobId, parsed.tenantId, parsed.conversationId ?? null,
        parsed.useCase, parsed.engagementType ?? null,
        parsed.polarity, parsed.intensity, parsed.confidence,
        parsed.score100, parsed.score5,
        parsed.scoringMethod ?? null, parsed.calibrationOffset ?? null,
        parsed.aspectCount, parsed.eventCount,
        parsed.keyMomentCount, parsed.analyzedAt, parsed.packVersion ?? null,
      ],
    );
    return parsed;
  }

  async getSentimentAnalysis(jobId: string): Promise<SentimentAnalysisRecord | null> {
    const result = await this.pool.query(
      'SELECT * FROM sentiment_analyses WHERE job_id = $1',
      [jobId],
    );
    return result.rows[0] ? this.fromAnalysisRow(result.rows[0]) : null;
  }

  async listSentimentAnalyses(filters: SentimentAnalysisFilters = {}): Promise<SentimentAnalysisRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (filters.tenantId) {
      conditions.push(`tenant_id = $${idx++}`);
      params.push(filters.tenantId);
    }
    if (filters.polarity) {
      conditions.push(`polarity = $${idx++}`);
      params.push(filters.polarity);
    }
    if (filters.minScore100 !== undefined) {
      conditions.push(`score100 >= $${idx++}`);
      params.push(filters.minScore100);
    }
    if (filters.maxScore100 !== undefined) {
      conditions.push(`score100 <= $${idx++}`);
      params.push(filters.maxScore100);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters.limit ?? 100, 500);
    const offset = filters.offset ?? 0;

    const result = await this.pool.query(
      `SELECT * FROM sentiment_analyses ${where} ORDER BY analyzed_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset],
    );
    return result.rows.map((row) => this.fromAnalysisRow(row));
  }

  // ---------------------------------------------------------------------------
  // Sentiment segments & phrase search
  // ---------------------------------------------------------------------------

  async saveSentimentSegments(segments: SentimentSegmentRecord[]): Promise<void> {
    if (segments.length === 0) return;

    for (const raw of segments) {
      const seg = sentimentSegmentRecordSchema.parse(raw);
      await this.pool.query(
        `INSERT INTO sentiment_segments (
          segment_id, job_id, tenant_id, turn_id, speaker_role,
          text, polarity, confidence, aspect_target, aspect_name
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (segment_id) DO NOTHING`,
        [
          seg.segmentId, seg.jobId, seg.tenantId, seg.turnId, seg.speakerRole,
          seg.text, seg.polarity ?? null, seg.confidence ?? null,
          seg.aspectTarget ?? null, seg.aspectName ?? null,
        ],
      );
    }
  }

  async searchSegmentsByPhrase(tenantId: string, query: string, limit = 50): Promise<PhraseSearchResult[]> {
    const maxLimit = Math.min(limit, 200);

    if (this.tsvectorSupported) {
      try {
        const result = await this.pool.query(
          `SELECT *,
            ts_rank(tsv, plainto_tsquery('english', $2)) AS rank,
            ts_headline('english', text, plainto_tsquery('english', $2),
              'StartSel=<mark>, StopSel=</mark>, MaxFragments=3, MaxWords=30') AS headline
          FROM sentiment_segments
          WHERE tenant_id = $1
            AND tsv @@ plainto_tsquery('english', $2)
          ORDER BY rank DESC
          LIMIT $3`,
          [tenantId, query, maxLimit],
        );
        return result.rows.map((row) => this.fromPhraseSearchRow(row));
      } catch {
        this.tsvectorSupported = false;
      }
    }

    const result = await this.pool.query(
      `SELECT *, 1.0 AS rank, text AS headline
      FROM sentiment_segments
      WHERE tenant_id = $1
        AND LOWER(text) LIKE LOWER($2)
      ORDER BY turn_id
      LIMIT $3`,
      [tenantId, `%${query}%`, maxLimit],
    );
    return result.rows.map((row) => this.fromPhraseSearchRow(row));
  }

  // ---------------------------------------------------------------------------
  // Key moments
  // ---------------------------------------------------------------------------

  async saveKeyMoments(moments: KeyMomentRecord[]): Promise<void> {
    if (moments.length === 0) return;

    for (const raw of moments) {
      const km = keyMomentRecordSchema.parse(raw);
      await this.pool.query(
        `INSERT INTO key_moments (
          moment_id, job_id, tenant_id, type, actor_role,
          start_turn_id, end_turn_id, confidence, business_impact,
          rationale, evidence_json
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
        ON CONFLICT (moment_id) DO NOTHING`,
        [
          km.momentId, km.jobId, km.tenantId, km.type, km.actorRole,
          km.startTurnId, km.endTurnId, km.confidence, km.businessImpact,
          km.rationale, km.evidenceJson,
        ],
      );
    }
  }

  async listKeyMoments(filters: KeyMomentFilters = {}): Promise<KeyMomentRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (filters.tenantId) {
      conditions.push(`tenant_id = $${idx++}`);
      params.push(filters.tenantId);
    }
    if (filters.type) {
      conditions.push(`type = $${idx++}`);
      params.push(filters.type);
    }
    if (filters.businessImpact) {
      conditions.push(`business_impact = $${idx++}`);
      params.push(filters.businessImpact);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters.limit ?? 100, 500);
    const offset = filters.offset ?? 0;

    const result = await this.pool.query(
      `SELECT * FROM key_moments ${where} ORDER BY confidence DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset],
    );
    return result.rows.map((row) => this.fromKeyMomentRow(row));
  }

  // ---------------------------------------------------------------------------
  // Calibration samples
  // ---------------------------------------------------------------------------

  async saveCalibrationSample(sample: CalibrationSampleRecord): Promise<CalibrationSampleRecord> {
    const parsed = calibrationSampleRecordSchema.parse(sample);
    await this.pool.query(
      `INSERT INTO calibration_samples (
        sample_id, job_id, tenant_id, use_case, engagement_type,
        model_polarity, model_intensity, model_confidence,
        model_score100, model_score5,
        analyst_score100, analyst_score5,
        delta_score100, delta_score5,
        correction_applied, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT (sample_id) DO NOTHING`,
      [
        parsed.sampleId, parsed.jobId, parsed.tenantId,
        parsed.useCase, parsed.engagementType ?? null,
        parsed.modelPolarity, parsed.modelIntensity, parsed.modelConfidence,
        parsed.modelScore100, parsed.modelScore5,
        parsed.analystScore100, parsed.analystScore5,
        parsed.deltaScore100, parsed.deltaScore5,
        parsed.correctionApplied, parsed.createdAt,
      ],
    );
    return parsed;
  }

  async listCalibrationSamples(filters: CalibrationSampleFilters = {}): Promise<CalibrationSampleRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (filters.tenantId) {
      conditions.push(`tenant_id = $${idx++}`);
      params.push(filters.tenantId);
    }
    if (filters.useCase) {
      conditions.push(`use_case = $${idx++}`);
      params.push(filters.useCase);
    }
    if (filters.engagementType) {
      conditions.push(`engagement_type = $${idx++}`);
      params.push(filters.engagementType);
    }
    if (filters.sinceDate) {
      conditions.push(`created_at >= $${idx++}`);
      params.push(filters.sinceDate);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters.limit ?? 500, 2000);

    const result = await this.pool.query(
      `SELECT * FROM calibration_samples ${where} ORDER BY created_at DESC LIMIT $${idx++}`,
      [...params, limit],
    );
    return result.rows.map((row) => this.fromCalibrationRow(row));
  }

  // ---------------------------------------------------------------------------
  // Trend aggregation
  // ---------------------------------------------------------------------------

  async getSentimentTrend(tenantId: string, bucket: TrendBucket, days: number): Promise<SentimentTrendPoint[]> {
    const bucketSql = bucket === 'day' ? 'day' : bucket === 'week' ? 'week' : 'month';

    try {
      const result = await this.pool.query(
        `SELECT
          date_trunc($3, analyzed_at::timestamp)::text AS bucket,
          AVG(score100)::real AS avg_score100,
          AVG(score5)::real AS avg_score5,
          COUNT(*)::integer AS count,
          AVG(confidence)::real AS avg_confidence
        FROM sentiment_analyses
        WHERE tenant_id = $1
          AND analyzed_at >= (NOW() - ($2 || ' days')::interval)::text
        GROUP BY bucket
        ORDER BY bucket ASC`,
        [tenantId, days, bucketSql],
      );
      return result.rows.map((row) => sentimentTrendPointSchema.parse({
        bucket: String(row.bucket),
        avgScore100: Number(row.avg_score100),
        avgScore5: Number(row.avg_score5),
        count: Number(row.count),
        avgConfidence: Number(row.avg_confidence),
      }));
    } catch {
      // pg-mem fallback: compute trend in-memory from raw records
      const cutoffDate = new Date(Date.now() - days * 86400_000).toISOString();
      const result = await this.pool.query(
        `SELECT analyzed_at, score100, score5, confidence
        FROM sentiment_analyses
        WHERE tenant_id = $1
          AND analyzed_at >= $2
        ORDER BY analyzed_at ASC`,
        [tenantId, cutoffDate],
      );

      const bucketMap = new Map<string, { scores100: number[]; scores5: number[]; confidences: number[] }>();
      for (const row of result.rows) {
        const date = String(row.analyzed_at);
        const key = bucketSql === 'month' ? date.slice(0, 7) : date.slice(0, 10);
        const entry = bucketMap.get(key) ?? { scores100: [], scores5: [], confidences: [] };
        entry.scores100.push(Number(row.score100));
        entry.scores5.push(Number(row.score5));
        entry.confidences.push(Number(row.confidence));
        bucketMap.set(key, entry);
      }

      return Array.from(bucketMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => sentimentTrendPointSchema.parse({
          bucket: key,
          avgScore100: entry.scores100.reduce((a, b) => a + b, 0) / entry.scores100.length,
          avgScore5: entry.scores5.reduce((a, b) => a + b, 0) / entry.scores5.length,
          count: entry.scores100.length,
          avgConfidence: entry.confidences.reduce((a, b) => a + b, 0) / entry.confidences.length,
        }));
    }
  }

  // ---------------------------------------------------------------------------
  // Row mapping helpers
  // ---------------------------------------------------------------------------

  private fromAnalysisRow(row: QueryResultRow): SentimentAnalysisRecord {
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

  private fromPhraseSearchRow(row: QueryResultRow): PhraseSearchResult {
    return phraseSearchResultSchema.parse({
      segment: this.fromSegmentRow(row),
      headline: String(row.headline),
      rank: Number(row.rank),
    });
  }

  private fromSegmentRow(row: QueryResultRow): SentimentSegmentRecord {
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

  private fromKeyMomentRow(row: QueryResultRow): KeyMomentRecord {
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
      evidenceJson: typeof row.evidence_json === 'string'
        ? row.evidence_json
        : JSON.stringify(row.evidence_json),
    });
  }

  private fromCalibrationRow(row: QueryResultRow): CalibrationSampleRecord {
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
      correctionApplied: Boolean(row.correction_applied),
      createdAt: row.created_at,
    });
  }
}
