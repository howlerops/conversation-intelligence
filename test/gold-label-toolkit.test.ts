import { describe, expect, it } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import {
  saveGoldLabelDataset,
  loadGoldLabelDataset,
  summarizeGoldLabelDataset,
  measureInterAnnotatorAgreement,
  flagLowConfidenceAnnotations,
  GoldLabelRecord,
} from '../src/validation/gold-label-toolkit';

function makeRecord(overrides: Partial<GoldLabelRecord> = {}): GoldLabelRecord {
  return {
    recordId: `rec-${randomUUID().slice(0, 8)}`,
    tenantId: 'acme',
    useCase: 'support',
    engagementType: 'CALL',
    reviewedBy: 'analyst-1',
    reviewedAt: new Date().toISOString(),
    status: 'ACCEPTED',
    sentiment: {
      score100: 45,
      score5: 3,
      polarity: 'NEUTRAL',
      correctionApplied: false,
    },
    expectedKeyMoments: [],
    ...overrides,
  };
}

describe('gold-label toolkit', () => {
  it('saves and loads a gold-label dataset in JSONL format', async () => {
    const records = [
      makeRecord({ engagementType: 'CALL' }),
      makeRecord({ engagementType: 'EMAIL' }),
      makeRecord({ engagementType: 'TICKET' }),
    ];

    const path = join(tmpdir(), `gold-label-${randomUUID()}.jsonl`);
    await saveGoldLabelDataset(records, path);
    const loaded = await loadGoldLabelDataset(path);

    expect(loaded.length).toBe(3);
    expect(loaded[0].tenantId).toBe('acme');
    expect(loaded[2].engagementType).toBe('TICKET');
  });

  it('returns empty array for non-existent dataset', async () => {
    const loaded = await loadGoldLabelDataset('/tmp/nonexistent-gold-label.jsonl');
    expect(loaded).toEqual([]);
  });

  it('summarizes dataset with coverage gap analysis', () => {
    const records = [
      ...Array.from({ length: 25 }, () => makeRecord({ engagementType: 'CALL' })),
      ...Array.from({ length: 25 }, () => makeRecord({ engagementType: 'EMAIL' })),
      ...Array.from({ length: 25 }, () => makeRecord({ engagementType: 'TICKET' })),
      ...Array.from({ length: 25 }, () => makeRecord({ engagementType: 'CHAT' })),
    ];

    const summary = summarizeGoldLabelDataset(records);
    expect(summary.totalRecords).toBe(100);
    expect(summary.statisticallySignificant).toBe(true);
    expect(summary.coverageGaps.length).toBe(0);
    expect(summary.byEngagementType['CALL']).toBe(25);
  });

  it('identifies coverage gaps when engagement types are underrepresented', () => {
    const records = [
      ...Array.from({ length: 5 }, () => makeRecord({ engagementType: 'CALL' })),
      ...Array.from({ length: 3 }, () => makeRecord({ engagementType: 'EMAIL' })),
    ];

    const summary = summarizeGoldLabelDataset(records);
    expect(summary.statisticallySignificant).toBe(false);
    expect(summary.coverageGaps.length).toBeGreaterThan(0);
    expect(summary.coverageGaps.some((g) => g.includes('CALL'))).toBe(true);
    expect(summary.coverageGaps.some((g) => g.includes('TICKET'))).toBe(true);
    expect(summary.coverageGaps.some((g) => g.includes('CHAT'))).toBe(true);
  });

  it('tracks corrected vs accepted vs rejected records', () => {
    const records = [
      makeRecord({ status: 'ACCEPTED' }),
      makeRecord({ status: 'ACCEPTED' }),
      makeRecord({ status: 'CORRECTED' }),
      makeRecord({ status: 'REJECTED' }),
    ];

    const summary = summarizeGoldLabelDataset(records);
    expect(summary.accepted).toBe(2);
    expect(summary.corrected).toBe(1);
    expect(summary.rejected).toBe(1);
  });

  it('computes inter-annotator agreement with Cohen\'s kappa', () => {
    const annotationsA = [
      { recordId: 'r1', score5: 1 },
      { recordId: 'r2', score5: 3 },
      { recordId: 'r3', score5: 5 },
      { recordId: 'r4', score5: 2 },
      { recordId: 'r5', score5: 4 },
    ];

    const annotationsB = [
      { recordId: 'r1', score5: 1 },
      { recordId: 'r2', score5: 3 },
      { recordId: 'r3', score5: 5 },
      { recordId: 'r4', score5: 2 },
      { recordId: 'r5', score5: 4 },
    ];

    const agreement = measureInterAnnotatorAgreement(annotationsA, annotationsB);
    expect(agreement.rawAgreement).toBe(1);
    expect(agreement.cohensKappa).toBe(1);
    expect(agreement.interpretation).toBe('almost_perfect');
  });

  it('measures lower agreement when annotators disagree', () => {
    const annotationsA = [
      { recordId: 'r1', score5: 1 },
      { recordId: 'r2', score5: 3 },
      { recordId: 'r3', score5: 5 },
      { recordId: 'r4', score5: 2 },
    ];

    const annotationsB = [
      { recordId: 'r1', score5: 2 },
      { recordId: 'r2', score5: 4 },
      { recordId: 'r3', score5: 5 },
      { recordId: 'r4', score5: 1 },
    ];

    const agreement = measureInterAnnotatorAgreement(annotationsA, annotationsB);
    expect(agreement.rawAgreement).toBeLessThan(1);
    expect(agreement.cohensKappa).toBeLessThan(1);
    expect(agreement.recordCount).toBe(4);
  });

  it('flags low-confidence annotations based on multi-trial variance', () => {
    const annotations = [
      { recordId: 'r1', trials: [{ score100: 20 }, { score100: 80 }, { score100: 50 }] },
      { recordId: 'r2', trials: [{ score100: 50 }, { score100: 52 }, { score100: 48 }] },
      { recordId: 'r3', trials: [{ score100: 10 }, { score100: 90 }] },
    ];

    const flagged = flagLowConfidenceAnnotations(annotations, 100);
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged[0].recordId).toBe('r3');
    expect(flagged[0].variance).toBeGreaterThan(100);

    const r2 = flagged.find((f) => f.recordId === 'r2');
    expect(r2).toBeUndefined();
  });
});
