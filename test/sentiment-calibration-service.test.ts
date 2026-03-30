import { afterEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { PostgresSentimentStore } from '../src/store/postgres-sentiment-store';
import { SentimentCalibrationService } from '../src/service/sentiment-calibration-service';
import {
  CalibrationSampleRecord,
  SentimentAnalysisRecord,
} from '../src/contracts/sentiment-persistence';

type ClosablePool = {
  end(): Promise<void>;
};

describe('SentimentCalibrationService', () => {
  const pools: ClosablePool[] = [];

  afterEach(async () => {
    await Promise.allSettled(pools.map(async (pool) => pool.end()));
    pools.length = 0;
  });

  async function createServiceWithStore() {
    const db = newDb();
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);
    const store = new PostgresSentimentStore({ pool });
    await store.initialize();
    const service = new SentimentCalibrationService(store);
    return { store, service };
  }

  function makeSample(overrides: Partial<CalibrationSampleRecord> & { sampleId: string }): CalibrationSampleRecord {
    return {
      jobId: 'job-1',
      tenantId: 'acme',
      useCase: 'support',
      modelPolarity: 'NEUTRAL',
      modelIntensity: 0.5,
      modelConfidence: 0.8,
      modelScore100: 50,
      modelScore5: 3,
      analystScore100: 55,
      analystScore5: 3,
      deltaScore100: 5,
      deltaScore5: 0,
      correctionApplied: true,
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('returns empty analysis for tenants with no calibration data', async () => {
    const { service } = await createServiceWithStore();

    const result = await service.analyzeCalibration('acme');
    expect(result.sampleSize).toBe(0);
    expect(result.confusionPairs).toEqual([]);
    expect(result.rootCauses).toEqual([]);
    expect(result.avgSignedDelta).toBe(0);
  });

  it('builds confusion pairs from misclassified samples', async () => {
    const { store, service } = await createServiceWithStore();

    await store.saveCalibrationSample(makeSample({
      sampleId: 'cal-1',
      modelPolarity: 'NEGATIVE',
      modelScore100: 25,
      analystScore100: 50,
      deltaScore100: 25,
    }));
    await store.saveCalibrationSample(makeSample({
      sampleId: 'cal-2',
      modelPolarity: 'NEGATIVE',
      modelScore100: 30,
      analystScore100: 55,
      deltaScore100: 25,
    }));
    await store.saveCalibrationSample(makeSample({
      sampleId: 'cal-3',
      modelPolarity: 'NEUTRAL',
      modelScore100: 50,
      analystScore100: 50,
      deltaScore100: 0,
    }));

    const result = await service.analyzeCalibration('acme');
    expect(result.sampleSize).toBe(3);

    const negToNeutral = result.confusionPairs.find(
      (p) => p.predicted === 'NEGATIVE' && p.actual === 'NEUTRAL',
    );
    expect(negToNeutral).toBeDefined();
    expect(negToNeutral!.count).toBe(2);
    expect(negToNeutral!.percentage).toBe(100);
  });

  it('infers sarcasm gap root cause when NEGATIVE→NEUTRAL dominates', async () => {
    const { store, service } = await createServiceWithStore();

    for (let i = 0; i < 10; i++) {
      await store.saveCalibrationSample(makeSample({
        sampleId: `cal-neg-${i}`,
        modelPolarity: 'NEGATIVE',
        modelScore100: 25,
        analystScore100: 50,
        deltaScore100: 25,
      }));
    }
    for (let i = 0; i < 3; i++) {
      await store.saveCalibrationSample(makeSample({
        sampleId: `cal-ok-${i}`,
        modelPolarity: 'NEUTRAL',
        modelScore100: 50,
        analystScore100: 50,
        deltaScore100: 0,
      }));
    }

    const result = await service.analyzeCalibration('acme');
    expect(result.rootCauses.some((c) => c.includes('Sarcasm detection gap'))).toBe(true);
  });

  it('detects systematic positive bias', async () => {
    const { store, service } = await createServiceWithStore();

    for (let i = 0; i < 10; i++) {
      await store.saveCalibrationSample(makeSample({
        sampleId: `cal-${i}`,
        modelScore100: 60,
        analystScore100: 70,
        deltaScore100: 10,
      }));
    }

    const result = await service.analyzeCalibration('acme');
    expect(result.avgSignedDelta).toBeGreaterThan(5);
    expect(result.rootCauses.some((c) => c.includes('Systematic positive bias'))).toBe(true);
  });

  it('recommends calibration offset from sample deltas', async () => {
    const { store, service } = await createServiceWithStore();

    for (let i = 0; i < 25; i++) {
      await store.saveCalibrationSample(makeSample({
        sampleId: `cal-${i}`,
        modelScore100: 45,
        analystScore100: 52,
        deltaScore100: 7,
      }));
    }

    const recommendation = await service.recommendCalibrationOffset('acme');
    expect(recommendation.recommendedScore100Offset).toBe(7);
    expect(recommendation.sampleSize).toBe(25);
    expect(recommendation.confidence).toBe('medium');
  });

  it('returns low confidence for small sample sizes', async () => {
    const { store, service } = await createServiceWithStore();

    await store.saveCalibrationSample(makeSample({
      sampleId: 'cal-1',
      deltaScore100: 5,
    }));

    const recommendation = await service.recommendCalibrationOffset('acme');
    expect(recommendation.confidence).toBe('low');
    expect(recommendation.sampleSize).toBe(1);
  });

  it('detects drift between baseline and recent analyses', async () => {
    const { store, service } = await createServiceWithStore();

    const baselineDate = new Date(Date.now() - 60 * 86400_000);
    for (let i = 0; i < 15; i++) {
      const date = new Date(baselineDate.getTime() + i * 86400_000);
      await store.saveSentimentAnalysis({
        jobId: `base-${i}`,
        tenantId: 'acme',
        useCase: 'support',
        polarity: 'NEUTRAL',
        intensity: 0.5,
        confidence: 0.8,
        score100: 50,
        score5: 3,
        aspectCount: 0,
        eventCount: 0,
        keyMomentCount: 0,
        analyzedAt: date.toISOString(),
      });
    }

    for (let i = 0; i < 10; i++) {
      const date = new Date(Date.now() - (10 - i) * 86400_000);
      await store.saveSentimentAnalysis({
        jobId: `recent-${i}`,
        tenantId: 'acme',
        useCase: 'support',
        polarity: 'NEGATIVE',
        intensity: 0.7,
        confidence: 0.85,
        score100: 30,
        score5: 2,
        aspectCount: 0,
        eventCount: 0,
        keyMomentCount: 0,
        analyzedAt: date.toISOString(),
      });
    }

    const drift = await service.detectDrift('acme');
    expect(drift.tenantId).toBe('acme');
    expect(drift.drift).toBeLessThan(-5);
    expect(drift.trendDirection).toBe('declining');
    expect(drift.driftSignificant).toBe(true);
    expect(drift.baselineSampleSize).toBeGreaterThan(0);
    expect(drift.recentSampleSize).toBeGreaterThan(0);
  });

  it('returns stable trend when no significant change', async () => {
    const { store, service } = await createServiceWithStore();

    for (let i = 0; i < 20; i++) {
      const date = new Date(Date.now() - (60 - i * 3) * 86400_000);
      await store.saveSentimentAnalysis({
        jobId: `stable-${i}`,
        tenantId: 'acme',
        useCase: 'support',
        polarity: 'NEUTRAL',
        intensity: 0.5,
        confidence: 0.8,
        score100: 50 + (i % 3),
        score5: 3,
        aspectCount: 0,
        eventCount: 0,
        keyMomentCount: 0,
        analyzedAt: date.toISOString(),
      });
    }

    const drift = await service.detectDrift('acme');
    expect(drift.trendDirection).toBe('stable');
  });

  it('groups calibration analysis by engagement type', async () => {
    const { store, service } = await createServiceWithStore();

    for (let i = 0; i < 5; i++) {
      await store.saveCalibrationSample(makeSample({
        sampleId: `cal-call-${i}`,
        engagementType: 'CALL',
        deltaScore100: 10,
      }));
    }
    for (let i = 0; i < 5; i++) {
      await store.saveCalibrationSample(makeSample({
        sampleId: `cal-email-${i}`,
        engagementType: 'EMAIL',
        deltaScore100: -5,
      }));
    }

    const result = await service.analyzeCalibration('acme');
    expect(result.byEngagementType).toBeDefined();
    expect(result.byEngagementType!['CALL']).toBeDefined();
    expect(result.byEngagementType!['EMAIL']).toBeDefined();
    expect(result.byEngagementType!['CALL'].avgSignedDelta).toBe(10);
    expect(result.byEngagementType!['EMAIL'].avgSignedDelta).toBe(-5);
  });
});
