import { describe, expect, it } from 'vitest';
import {
  generateSyntheticGoldLabelDataset,
  validateGoldLabelCoverage,
} from '../src/validation/synthetic-gold-label-generator';
import {
  goldLabelRecordSchema,
  summarizeGoldLabelDataset,
  loadGoldLabelDataset,
} from '../src/validation/gold-label-toolkit';
import { resolve } from 'path';

describe('synthetic gold-label generator', () => {
  it('generates 120+ records that all parse through goldLabelRecordSchema', () => {
    const records = generateSyntheticGoldLabelDataset({ count: 120, seed: 42 });
    expect(records.length).toBeGreaterThanOrEqual(120);

    for (const record of records) {
      expect(() => goldLabelRecordSchema.parse(record)).not.toThrow();
    }
  });

  it('distributes records evenly across engagement types (25+ each)', () => {
    const records = generateSyntheticGoldLabelDataset({ count: 120, seed: 42 });
    const byType: Record<string, number> = {};
    for (const r of records) {
      byType[r.engagementType] = (byType[r.engagementType] ?? 0) + 1;
    }

    expect(byType['CALL']).toBeGreaterThanOrEqual(25);
    expect(byType['EMAIL']).toBeGreaterThanOrEqual(25);
    expect(byType['TICKET']).toBeGreaterThanOrEqual(25);
    expect(byType['CHAT']).toBeGreaterThanOrEqual(25);
  });

  it('includes edge cases: sarcasm, mixed sentiment, multi-speaker', () => {
    const records = generateSyntheticGoldLabelDataset({ count: 120, seed: 42 });

    const sarcasm = records.filter((r) => r.recordId.includes('sarcasm'));
    expect(sarcasm.length).toBeGreaterThanOrEqual(1);

    const mixed = records.filter((r) => r.recordId.includes('mixed'));
    expect(mixed.length).toBeGreaterThanOrEqual(1);

    const multispeaker = records.filter((r) => r.recordId.includes('multispeaker'));
    expect(multispeaker.length).toBeGreaterThanOrEqual(1);
  });

  it('includes key moments for at least 20 records', () => {
    const records = generateSyntheticGoldLabelDataset({ count: 120, seed: 42 });
    const withMoments = records.filter((r) => r.expectedKeyMoments.length > 0);
    expect(withMoments.length).toBeGreaterThanOrEqual(20);
  });

  it('is deterministic — same seed produces identical output', () => {
    const a = generateSyntheticGoldLabelDataset({ count: 50, seed: 123 });
    const b = generateSyntheticGoldLabelDataset({ count: 50, seed: 123 });

    expect(a.map((r) => r.recordId)).toEqual(b.map((r) => r.recordId));
    expect(a.map((r) => r.sentiment.score100)).toEqual(b.map((r) => r.sentiment.score100));
  });

  it('different seeds produce different output', () => {
    const a = generateSyntheticGoldLabelDataset({ count: 50, seed: 1 });
    const b = generateSyntheticGoldLabelDataset({ count: 50, seed: 2 });

    expect(a.map((r) => r.sentiment.score100)).not.toEqual(b.map((r) => r.sentiment.score100));
  });

  it('passes coverage validation with default options', () => {
    const records = generateSyntheticGoldLabelDataset({ count: 120, seed: 42 });
    const coverage = validateGoldLabelCoverage(records);
    expect(coverage.valid).toBe(true);
    expect(coverage.issues).toEqual([]);
  });

  it('loads the committed fixture file and verifies statistical significance', async () => {
    const fixturePath = resolve(__dirname, '..', 'fixtures', 'benchmarks', 'gold-label-reviewed-100.jsonl');
    const records = await loadGoldLabelDataset(fixturePath);
    expect(records.length).toBeGreaterThanOrEqual(100);

    const summary = summarizeGoldLabelDataset(records);
    expect(summary.statisticallySignificant).toBe(true);
    expect(summary.coverageGaps.length).toBe(0);
  });
});
