import { afterEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { PostgresSentimentStore } from '../src/store/postgres-sentiment-store';
import { SentimentCalibrationService } from '../src/service/sentiment-calibration-service';
import { CalibrationSampleRecord } from '../src/contracts/sentiment-persistence';

type ClosablePool = { end(): Promise<void> };

describe('calibration convergence tracking', () => {
  const pools: ClosablePool[] = [];

  afterEach(async () => {
    await Promise.allSettled(pools.map(async (p) => p.end()));
    pools.length = 0;
  });

  async function setup() {
    const db = newDb();
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);
    const store = new PostgresSentimentStore({ pool });
    await store.initialize();
    return { store, service: new SentimentCalibrationService(store) };
  }

  function makeSample(id: string, createdAt: string, deltaScore100: number): CalibrationSampleRecord {
    return {
      sampleId: id,
      jobId: `job-${id}`,
      tenantId: 'acme',
      useCase: 'support',
      modelPolarity: 'NEUTRAL',
      modelIntensity: 0.5,
      modelConfidence: 0.8,
      modelScore100: 50,
      modelScore5: 3,
      analystScore100: 50 + deltaScore100,
      analystScore5: 3,
      deltaScore100,
      deltaScore5: 0,
      correctionApplied: true,
      createdAt,
    };
  }

  it('returns insufficient_data when no samples exist', async () => {
    const { service } = await setup();
    const result = await service.trackCalibrationConvergence('acme');
    expect(result.trend).toBe('insufficient_data');
    expect(result.windows).toEqual([]);
    expect(result.windowCount).toBe(0);
  });

  it('returns insufficient_data when only one window qualifies', async () => {
    const { store, service } = await setup();
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      await store.saveCalibrationSample(
        makeSample(`s-${i}`, new Date(now - i * 3600_000).toISOString(), 10),
      );
    }
    const result = await service.trackCalibrationConvergence('acme', { windowDays: 14 });
    expect(result.trend).toBe('insufficient_data');
  });

  it('detects converging trend when MAE decreases over windows', async () => {
    const { store, service } = await setup();
    const now = Date.now();

    for (let window = 0; window < 4; window++) {
      const baseDelta = 20 - window * 5;
      for (let i = 0; i < 8; i++) {
        const createdAt = new Date(now - (3 - window) * 14 * 86400_000 + i * 86400_000).toISOString();
        await store.saveCalibrationSample(
          makeSample(`w${window}-s${i}`, createdAt, baseDelta + (i % 3)),
        );
      }
    }

    const result = await service.trackCalibrationConvergence('acme', {
      windowDays: 14,
      totalDays: 90,
      minimumSamplesPerWindow: 5,
    });
    expect(result.trend).toBe('converging');
    expect(result.maeChangeRate).toBeLessThan(0);
    expect(result.windowCount).toBeGreaterThanOrEqual(2);
  });

  it('detects oscillating trend when MAE fluctuates', async () => {
    const { store, service } = await setup();
    const now = Date.now();
    const maePattern = [15, 5, 18, 4, 16];

    for (let window = 0; window < maePattern.length; window++) {
      for (let i = 0; i < 8; i++) {
        const createdAt = new Date(now - (maePattern.length - 1 - window) * 14 * 86400_000 + i * 86400_000).toISOString();
        await store.saveCalibrationSample(
          makeSample(`w${window}-s${i}`, createdAt, maePattern[window]),
        );
      }
    }

    const result = await service.trackCalibrationConvergence('acme', {
      windowDays: 14,
      totalDays: 120,
      minimumSamplesPerWindow: 5,
    });
    expect(result.trend).toBe('oscillating');
  });

  it('detects stable trend when MAE stays consistent', async () => {
    const { store, service } = await setup();
    const now = Date.now();

    for (let window = 0; window < 4; window++) {
      for (let i = 0; i < 8; i++) {
        const createdAt = new Date(now - (3 - window) * 14 * 86400_000 + i * 86400_000).toISOString();
        await store.saveCalibrationSample(
          makeSample(`w${window}-s${i}`, createdAt, 7),
        );
      }
    }

    const result = await service.trackCalibrationConvergence('acme', {
      windowDays: 14,
      totalDays: 90,
      minimumSamplesPerWindow: 5,
    });
    expect(result.trend).toBe('stable');
    expect(Math.abs(result.maeChangeRate)).toBeLessThan(1);
  });
});
