import { describe, expect, it, beforeEach } from 'vitest';
import { SqliteSentimentStore } from '../src/store/sqlite-sentiment-store';

function makeStore() {
  // Use in-memory SQLite via `:memory:` path workaround:
  // better-sqlite3 doesn't support `:memory:` via our path constructor, so use a temp file
  const store = new SqliteSentimentStore(':memory:');
  return store;
}

describe('SqliteSentimentStore', () => {
  let store: SqliteSentimentStore;

  beforeEach(async () => {
    store = makeStore();
    await store.initialize();
  });

  it('saves and retrieves a sentiment analysis', async () => {
    const record = await store.saveSentimentAnalysis({
      jobId: 'job-1',
      tenantId: 'acme',
      useCase: 'support',
      polarity: 'NEGATIVE',
      intensity: 0.7,
      confidence: 0.85,
      score100: 30,
      score5: 2,
      aspectCount: 0,
      eventCount: 1,
      keyMomentCount: 1,
      analyzedAt: new Date().toISOString(),
    });

    const fetched = await store.getSentimentAnalysis('job-1');
    expect(fetched).not.toBeNull();
    expect(fetched!.jobId).toBe('job-1');
    expect(fetched!.polarity).toBe('NEGATIVE');
    expect(fetched!.score100).toBe(30);
  });

  it('lists sentiment analyses with filters', async () => {
    await store.saveSentimentAnalysis({ jobId: 'j1', tenantId: 'acme', useCase: 'support', polarity: 'NEGATIVE', intensity: 0.7, confidence: 0.9, score100: 25, score5: 2, aspectCount: 0, eventCount: 0, keyMomentCount: 0, analyzedAt: new Date().toISOString() });
    await store.saveSentimentAnalysis({ jobId: 'j2', tenantId: 'acme', useCase: 'support', polarity: 'POSITIVE', intensity: 0.6, confidence: 0.8, score100: 70, score5: 4, aspectCount: 0, eventCount: 0, keyMomentCount: 0, analyzedAt: new Date().toISOString() });
    await store.saveSentimentAnalysis({ jobId: 'j3', tenantId: 'other', useCase: 'support', polarity: 'NEGATIVE', intensity: 0.5, confidence: 0.7, score100: 30, score5: 2, aspectCount: 0, eventCount: 0, keyMomentCount: 0, analyzedAt: new Date().toISOString() });

    const acmeResults = await store.listSentimentAnalyses({ tenantId: 'acme' });
    expect(acmeResults.length).toBe(2);

    const negativeResults = await store.listSentimentAnalyses({ tenantId: 'acme', polarity: 'NEGATIVE' });
    expect(negativeResults.length).toBe(1);
    expect(negativeResults[0].jobId).toBe('j1');
  });

  it('saves and searches sentiment segments by phrase', async () => {
    await store.saveSentimentSegments([
      { segmentId: 'seg-1', jobId: 'j1', tenantId: 'acme', turnId: 't1', speakerRole: 'END_USER', text: 'I am very frustrated with this issue' },
      { segmentId: 'seg-2', jobId: 'j1', tenantId: 'acme', turnId: 't2', speakerRole: 'AGENT', text: 'Let me help you with that right away' },
    ]);

    const results = await store.searchSegmentsByPhrase('acme', 'frustrated');
    expect(results.length).toBe(1);
    expect(results[0].segment.turnId).toBe('t1');
  });

  it('saves and lists key moments', async () => {
    await store.saveKeyMoments([
      {
        momentId: 'km-1',
        jobId: 'j1',
        tenantId: 'acme',
        type: 'FRUSTRATION_ONSET',
        actorRole: 'END_USER',
        startTurnId: 't1',
        endTurnId: 't1',
        confidence: 0.8,
        businessImpact: 'HIGH',
        rationale: 'User expressed frustration.',
        evidenceJson: JSON.stringify([{ turnId: 't1', speakerRole: 'END_USER', quote: 'frustrated' }]),
      },
    ]);

    const moments = await store.listKeyMoments({ tenantId: 'acme' });
    expect(moments.length).toBe(1);
    expect(moments[0].type).toBe('FRUSTRATION_ONSET');
    expect(moments[0].businessImpact).toBe('HIGH');
  });

  it('saves and lists calibration samples', async () => {
    await store.saveCalibrationSample({
      sampleId: 'cs-1',
      jobId: 'j1',
      tenantId: 'acme',
      useCase: 'support',
      modelPolarity: 'NEGATIVE',
      modelIntensity: 0.7,
      modelConfidence: 0.85,
      modelScore100: 30,
      modelScore5: 2,
      analystScore100: 25,
      analystScore5: 2,
      deltaScore100: 5,
      deltaScore5: 0,
      correctionApplied: false,
      createdAt: new Date().toISOString(),
    });

    const samples = await store.listCalibrationSamples({ tenantId: 'acme' });
    expect(samples.length).toBe(1);
    expect(samples[0].deltaScore100).toBe(5);
    expect(samples[0].correctionApplied).toBe(false);
  });

  it('computes sentiment trend by day', async () => {
    const now = new Date();
    for (let i = 0; i < 3; i++) {
      const d = new Date(now.getTime() - i * 86400_000);
      await store.saveSentimentAnalysis({
        jobId: `trend-${i}`,
        tenantId: 'acme',
        useCase: 'support',
        polarity: 'NEGATIVE',
        intensity: 0.5,
        confidence: 0.8,
        score100: 30 + i * 5,
        score5: 2,
        aspectCount: 0,
        eventCount: 0,
        keyMomentCount: 0,
        analyzedAt: d.toISOString(),
      });
    }

    const trend = await store.getSentimentTrend('acme', 'day', 7);
    expect(trend.length).toBeGreaterThan(0);
    expect(trend[0].count).toBeGreaterThan(0);
    expect(typeof trend[0].avgScore100).toBe('number');
  });
});
