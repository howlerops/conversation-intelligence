import { describe, expect, it } from 'vitest';
import { resolve } from 'path';
import {
  runGoldLabelValidation,
  formatValidationReport,
} from '../src/validation/run-gold-label-validation';
import { StubCanonicalAnalysisEngine } from '../src/rlm/engine';
import { canonicalExtractionSchema } from '../src/contracts/analysis';
import tenantPackFixture from '../fixtures/tenant-pack.support.acme.json';
import { TenantPackDraft } from '../src/contracts';

const cwd = resolve(__dirname, '..');

function makeStubEngine() {
  return new StubCanonicalAnalysisEngine(canonicalExtractionSchema.parse({
    overallEndUserSentiment: {
      polarity: 'NEGATIVE',
      intensity: 0.7,
      confidence: 0.85,
      rationale: 'Stub: moderate negative sentiment.',
    },
    aspectSentiments: [],
    canonicalEvents: [{
      type: 'FRUSTRATION_ONSET',
      actorRole: 'END_USER',
      confidence: 0.8,
      rationale: 'Stub frustration.',
      businessImpact: 'HIGH',
      evidence: [{ turnId: 't1', speakerRole: 'END_USER', quote: 'stub' }],
    }],
    canonicalKeyMoments: [{
      type: 'FRUSTRATION_ONSET',
      actorRole: 'END_USER',
      startTurnId: 't1',
      endTurnId: 't1',
      confidence: 0.8,
      rationale: 'Stub key moment.',
      businessImpact: 'HIGH',
      evidence: [{ turnId: 't1', speakerRole: 'END_USER', quote: 'stub' }],
    }],
    summary: 'Stub analysis.',
    review: { state: 'VERIFIED', reasons: [], comments: [], history: [] },
  }));
}

describe('gold-label validation runner', () => {
  it('runs full validation pipeline against public data records', async () => {
    const { summary } = await runGoldLabelValidation({
      engine: makeStubEngine(),
      tenantPack: tenantPackFixture as TenantPackDraft,
      cwd,
      hybridOptions: { syntheticCount: 10 },
    });

    expect(summary.totalRecords).toBeGreaterThan(0);
    expect(summary.completed).toBeGreaterThan(0);
    expect(summary.publicRecords).toBeGreaterThanOrEqual(10);
    expect(summary.generatedAt).toBeTruthy();
  });

  it('computes sentiment accuracy metrics for completed records', async () => {
    const { summary } = await runGoldLabelValidation({
      engine: makeStubEngine(),
      tenantPack: tenantPackFixture as TenantPackDraft,
      cwd,
      hybridOptions: { syntheticCount: 5 },
    });

    expect(summary.averageDeltaScore100).toBeDefined();
    expect(typeof summary.averageDeltaScore100).toBe('number');
    expect(summary.withinFivePointsRate).toBeDefined();
    expect(summary.polarityMatchRate).toBeDefined();
  });

  it('evaluates key moment detection for records with expected moments', async () => {
    const { summary } = await runGoldLabelValidation({
      engine: makeStubEngine(),
      tenantPack: tenantPackFixture as TenantPackDraft,
      cwd,
      hybridOptions: { syntheticCount: 5 },
    });

    // Some public records have canonical events → expectedKeyMoments
    // The stub engine always returns FRUSTRATION_ONSET
    expect(summary.keyMomentMacroPrecision).toBeDefined();
    expect(summary.keyMomentMacroRecall).toBeDefined();
  });

  it('produces per-engagement-type breakdown', async () => {
    const { summary } = await runGoldLabelValidation({
      engine: makeStubEngine(),
      tenantPack: tenantPackFixture as TenantPackDraft,
      cwd,
      hybridOptions: { syntheticCount: 5 },
    });

    expect(Object.keys(summary.byEngagementType).length).toBeGreaterThan(0);
    for (const [type, data] of Object.entries(summary.byEngagementType)) {
      expect(data.total).toBeGreaterThan(0);
    }
  });

  it('identifies worst-performing records', async () => {
    const { summary } = await runGoldLabelValidation({
      engine: makeStubEngine(),
      tenantPack: tenantPackFixture as TenantPackDraft,
      cwd,
      hybridOptions: { syntheticCount: 5 },
    });

    expect(summary.worstRecords.length).toBeGreaterThan(0);
    expect(summary.worstRecords[0].recordId).toBeTruthy();
    expect(summary.worstRecords[0].reason).toBeTruthy();
  });

  it('produces diagnostics identifying systemic issues', async () => {
    const { summary } = await runGoldLabelValidation({
      engine: makeStubEngine(),
      tenantPack: tenantPackFixture as TenantPackDraft,
      cwd,
      hybridOptions: { syntheticCount: 5 },
    });

    // With a stub engine always returning NEGATIVE, diagnostics should flag issues
    expect(Array.isArray(summary.diagnostics)).toBe(true);
    for (const d of summary.diagnostics) {
      expect(d.severity).toMatch(/^(HIGH|MEDIUM|LOW)$/);
      expect(d.category).toBeTruthy();
      expect(d.description).toBeTruthy();
    }
  });

  it('formats a human-readable validation report', async () => {
    const { summary } = await runGoldLabelValidation({
      engine: makeStubEngine(),
      tenantPack: tenantPackFixture as TenantPackDraft,
      cwd,
      hybridOptions: { syntheticCount: 5 },
    });

    const report = formatValidationReport(summary);
    expect(report).toContain('GOLD-LABEL VALIDATION REPORT');
    expect(report).toContain('SENTIMENT ACCURACY');
    expect(report).toContain('KEY MOMENT DETECTION');
    expect(report).toContain('BY ENGAGEMENT TYPE');
  });
});
