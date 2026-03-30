import { afterEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { PostgresSentimentStore } from '../src/store/postgres-sentiment-store';
import {
  SentimentAnalysisRecord,
  SentimentSegmentRecord,
  KeyMomentRecord,
  CalibrationSampleRecord,
} from '../src/contracts/sentiment-persistence';

type ClosablePool = {
  end(): Promise<void>;
};

describe('PostgresSentimentStore', () => {
  const pools: ClosablePool[] = [];

  afterEach(async () => {
    await Promise.allSettled(pools.map(async (pool) => pool.end()));
    pools.length = 0;
  });

  async function createStore() {
    const db = newDb();
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);
    const store = new PostgresSentimentStore({ pool });
    await store.initialize();
    return store;
  }

  it('saves and retrieves sentiment analysis records with filtering', async () => {
    const store = await createStore();

    const record: SentimentAnalysisRecord = {
      jobId: 'job-1',
      tenantId: 'acme',
      conversationId: 'conv-1',
      useCase: 'support',
      engagementType: 'CALL',
      polarity: 'NEGATIVE',
      intensity: 0.8,
      confidence: 0.92,
      score100: 28,
      score5: 2,
      scoringMethod: 'derived_v1',
      calibrationOffset: -3,
      aspectCount: 2,
      eventCount: 1,
      keyMomentCount: 1,
      analyzedAt: '2026-03-28T10:00:00.000Z',
      packVersion: 'v1.0.0',
    };

    const saved = await store.saveSentimentAnalysis(record);
    expect(saved.jobId).toBe('job-1');
    expect(saved.polarity).toBe('NEGATIVE');

    const retrieved = await store.getSentimentAnalysis('job-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.tenantId).toBe('acme');
    expect(retrieved!.score100).toBe(28);
    expect(retrieved!.engagementType).toBe('CALL');

    const nullResult = await store.getSentimentAnalysis('nonexistent');
    expect(nullResult).toBeNull();

    const record2: SentimentAnalysisRecord = {
      jobId: 'job-2',
      tenantId: 'acme',
      useCase: 'support',
      polarity: 'POSITIVE',
      intensity: 0.6,
      confidence: 0.85,
      score100: 78,
      score5: 4,
      aspectCount: 0,
      eventCount: 0,
      keyMomentCount: 0,
      analyzedAt: '2026-03-28T11:00:00.000Z',
    };
    await store.saveSentimentAnalysis(record2);

    const all = await store.listSentimentAnalyses({ tenantId: 'acme' });
    expect(all.length).toBe(2);

    const negative = await store.listSentimentAnalyses({ tenantId: 'acme', polarity: 'NEGATIVE' });
    expect(negative.length).toBe(1);
    expect(negative[0].jobId).toBe('job-1');

    const highScore = await store.listSentimentAnalyses({ tenantId: 'acme', minScore100: 50 });
    expect(highScore.length).toBe(1);
    expect(highScore[0].jobId).toBe('job-2');

    const otherTenant = await store.listSentimentAnalyses({ tenantId: 'other-corp' });
    expect(otherTenant.length).toBe(0);
  });

  it('saves segments and searches by phrase with ILIKE fallback', async () => {
    const store = await createStore();

    const segments: SentimentSegmentRecord[] = [
      {
        segmentId: 'seg-1',
        jobId: 'job-1',
        tenantId: 'acme',
        turnId: 't1',
        speakerRole: 'END_USER',
        text: 'The connector is broken and I cannot upload files',
        polarity: 'NEGATIVE',
        confidence: 0.9,
      },
      {
        segmentId: 'seg-2',
        jobId: 'job-1',
        tenantId: 'acme',
        turnId: 't2',
        speakerRole: 'AGENT',
        text: 'I understand the issue with the connector, let me help',
      },
      {
        segmentId: 'seg-3',
        jobId: 'job-1',
        tenantId: 'other-corp',
        turnId: 't1',
        speakerRole: 'END_USER',
        text: 'The connector is also broken here',
      },
    ];

    await store.saveSentimentSegments(segments);

    const results = await store.searchSegmentsByPhrase('acme', 'connector');
    expect(results.length).toBe(2);
    expect(results.every((r) => r.segment.tenantId === 'acme')).toBe(true);

    const noResults = await store.searchSegmentsByPhrase('acme', 'nonexistent-phrase');
    expect(noResults.length).toBe(0);

    const otherTenantResults = await store.searchSegmentsByPhrase('other-corp', 'connector');
    expect(otherTenantResults.length).toBe(1);
    expect(otherTenantResults[0].segment.tenantId).toBe('other-corp');

    const limitedResults = await store.searchSegmentsByPhrase('acme', 'connector', 1);
    expect(limitedResults.length).toBe(1);
  });

  it('saves and lists key moments with filters', async () => {
    const store = await createStore();

    const moments: KeyMomentRecord[] = [
      {
        momentId: 'km-1',
        jobId: 'job-1',
        tenantId: 'acme',
        type: 'FRUSTRATION_ONSET',
        actorRole: 'END_USER',
        startTurnId: 't1',
        endTurnId: 't3',
        confidence: 0.9,
        businessImpact: 'HIGH',
        rationale: 'Customer expressed explicit frustration',
        evidenceJson: JSON.stringify([{ turnId: 't1', speakerRole: 'END_USER', quote: 'This is broken' }]),
      },
      {
        momentId: 'km-2',
        jobId: 'job-1',
        tenantId: 'acme',
        type: 'ESCALATION_REQUEST',
        actorRole: 'END_USER',
        startTurnId: 't4',
        endTurnId: 't5',
        confidence: 0.85,
        businessImpact: 'CRITICAL',
        rationale: 'Customer demanded supervisor',
        evidenceJson: JSON.stringify([{ turnId: 't4', speakerRole: 'END_USER', quote: 'I want a supervisor' }]),
      },
    ];

    await store.saveKeyMoments(moments);

    const all = await store.listKeyMoments({ tenantId: 'acme' });
    expect(all.length).toBe(2);

    const frustration = await store.listKeyMoments({ tenantId: 'acme', type: 'FRUSTRATION_ONSET' });
    expect(frustration.length).toBe(1);
    expect(frustration[0].momentId).toBe('km-1');

    const critical = await store.listKeyMoments({ tenantId: 'acme', businessImpact: 'CRITICAL' });
    expect(critical.length).toBe(1);
    expect(critical[0].type).toBe('ESCALATION_REQUEST');
  });

  it('saves and lists calibration samples with filters', async () => {
    const store = await createStore();

    const sample: CalibrationSampleRecord = {
      sampleId: 'cal-1',
      jobId: 'job-1',
      tenantId: 'acme',
      useCase: 'support',
      engagementType: 'CALL',
      modelPolarity: 'NEGATIVE',
      modelIntensity: 0.8,
      modelConfidence: 0.9,
      modelScore100: 25,
      modelScore5: 2,
      analystScore100: 35,
      analystScore5: 2,
      deltaScore100: 10,
      deltaScore5: 0,
      correctionApplied: true,
      createdAt: '2026-03-28T10:00:00.000Z',
    };

    const saved = await store.saveCalibrationSample(sample);
    expect(saved.sampleId).toBe('cal-1');

    const samples = await store.listCalibrationSamples({ tenantId: 'acme' });
    expect(samples.length).toBe(1);
    expect(samples[0].deltaScore100).toBe(10);

    const bySupportCase = await store.listCalibrationSamples({ tenantId: 'acme', useCase: 'support' });
    expect(bySupportCase.length).toBe(1);

    const byOtherCase = await store.listCalibrationSamples({ tenantId: 'acme', useCase: 'sales' });
    expect(byOtherCase.length).toBe(0);
  });

  it('handles duplicate inserts with ON CONFLICT DO NOTHING', async () => {
    const store = await createStore();

    const record: SentimentAnalysisRecord = {
      jobId: 'dup-job',
      tenantId: 'acme',
      useCase: 'support',
      polarity: 'NEUTRAL',
      intensity: 0.5,
      confidence: 0.7,
      score100: 50,
      score5: 3,
      aspectCount: 0,
      eventCount: 0,
      keyMomentCount: 0,
      analyzedAt: '2026-03-28T10:00:00.000Z',
    };

    await store.saveSentimentAnalysis(record);
    await store.saveSentimentAnalysis(record);

    const all = await store.listSentimentAnalyses({ tenantId: 'acme' });
    expect(all.length).toBe(1);
  });
});
