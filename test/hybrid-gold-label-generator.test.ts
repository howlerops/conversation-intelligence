import { describe, expect, it } from 'vitest';
import { resolve } from 'path';
import {
  generateHybridGoldLabelDataset,
  validateGoldLabelCoverage,
} from '../src/validation/synthetic-gold-label-generator';
import { goldLabelRecordSchema, summarizeGoldLabelDataset } from '../src/validation/gold-label-toolkit';

const cwd = resolve(__dirname, '..');

describe('hybrid gold-label generator', () => {
  it('includes public data records from pipeline fixtures', () => {
    const hybrid = generateHybridGoldLabelDataset({}, cwd);

    expect(hybrid.publicRecords.length).toBeGreaterThanOrEqual(10);
    expect(hybrid.publicRecords.every((r) => r.recordId.startsWith('public-'))).toBe(true);
  });

  it('provides transcripts for all public records', () => {
    const hybrid = generateHybridGoldLabelDataset({}, cwd);

    for (const record of hybrid.publicRecords) {
      const transcript = hybrid.transcriptsByRecordId.get(record.recordId);
      expect(transcript, `Missing transcript for ${record.recordId}`).toBeDefined();
      expect(transcript!.turns.length).toBeGreaterThan(0);
    }
  });

  it('converts canonical event labels to expectedKeyMoments', () => {
    const hybrid = generateHybridGoldLabelDataset({}, cwd);

    const withMoments = hybrid.publicRecords.filter((r) => r.expectedKeyMoments.length > 0);
    expect(withMoments.length).toBeGreaterThan(0);

    for (const record of withMoments) {
      for (const km of record.expectedKeyMoments) {
        expect(km.type).toBeTruthy();
      }
    }
  });

  it('fills coverage gaps with synthetic records', () => {
    const hybrid = generateHybridGoldLabelDataset({ syntheticCount: 100 }, cwd);

    expect(hybrid.syntheticRecords.length).toBeGreaterThan(0);
    expect(hybrid.records.length).toBe(hybrid.publicRecords.length + hybrid.syntheticRecords.length);
  });

  it('all records parse through goldLabelRecordSchema', () => {
    const hybrid = generateHybridGoldLabelDataset({}, cwd);

    for (const record of hybrid.records) {
      expect(() => goldLabelRecordSchema.parse(record)).not.toThrow();
    }
  });

  it('produces a statistically significant dataset', () => {
    const hybrid = generateHybridGoldLabelDataset({ syntheticCount: 100 }, cwd);
    const summary = summarizeGoldLabelDataset(hybrid.records);

    expect(summary.statisticallySignificant).toBe(true);
  });

  it('passes coverage validation', () => {
    const hybrid = generateHybridGoldLabelDataset({ syntheticCount: 100 }, cwd);
    const coverage = validateGoldLabelCoverage(hybrid.records);

    expect(coverage.valid).toBe(true);
  });

  it('public records have analyst sentiment scores', () => {
    const hybrid = generateHybridGoldLabelDataset({}, cwd);

    for (const record of hybrid.publicRecords) {
      expect(record.sentiment.score100).toBeGreaterThanOrEqual(0);
      expect(record.sentiment.score100).toBeLessThanOrEqual(100);
      expect(record.sentiment.score5).toBeGreaterThanOrEqual(1);
      expect(record.sentiment.score5).toBeLessThanOrEqual(5);
    }
  });
});
