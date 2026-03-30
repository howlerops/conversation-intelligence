import { describe, expect, it } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { runTenantDataValidation } from '../src/validation/tenant-data-validation';
import { StubCanonicalAnalysisEngine } from '../src/rlm/engine';
import { canonicalExtractionSchema } from '../src/contracts/analysis';
import { GoldLabelRecord } from '../src/validation/gold-label-toolkit';
import tenantPackFixture from '../fixtures/tenant-pack.support.acme.json';
import { TenantPackDraft } from '../src/contracts';

function makeRecord(overrides: Partial<GoldLabelRecord> = {}): GoldLabelRecord {
  return {
    recordId: `rec-${randomUUID().slice(0, 8)}`,
    tenantId: 'tenant_acme',
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

function writeFixture(records: GoldLabelRecord[]): string {
  const dir = join(tmpdir(), `tenant-val-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'records.jsonl');
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return path;
}

function makeStubEngine(score100 = 50) {
  return new StubCanonicalAnalysisEngine(canonicalExtractionSchema.parse({
    overallEndUserSentiment: {
      polarity: 'NEUTRAL',
      intensity: 0.5,
      confidence: 0.8,
      rationale: 'Stub analysis.',
    },
    aspectSentiments: [],
    canonicalEvents: [],
    canonicalKeyMoments: [],
    summary: 'Stub.',
    review: { state: 'VERIFIED', reasons: [], comments: [], history: [] },
  }));
}

describe('tenant data validation', () => {
  it('runs end-to-end with synthetic records and produces valid summary', async () => {
    const records = [
      makeRecord({ engagementType: 'CALL' }),
      makeRecord({ engagementType: 'EMAIL' }),
      makeRecord({ engagementType: 'TICKET' }),
    ];
    const path = writeFixture(records);

    const summary = await runTenantDataValidation(
      { inputPath: path, tenantId: 'tenant_acme' },
      { engine: makeStubEngine(), tenantPack: tenantPackFixture as TenantPackDraft },
    );

    expect(summary.tenantId).toBe('tenant_acme');
    expect(summary.totalRecords).toBe(3);
    expect(summary.matched + summary.diverged + summary.skipped + summary.errors).toBe(3);
    expect(summary.validatedAt).toBeTruthy();
  });

  it('classifies records as MATCHED when delta is within 5 points', async () => {
    const records = [
      makeRecord({ sentiment: { score100: 50, score5: 3, polarity: 'NEUTRAL', correctionApplied: false } }),
    ];
    const path = writeFixture(records);

    const summary = await runTenantDataValidation(
      { inputPath: path, tenantId: 'tenant_acme' },
      { engine: makeStubEngine(), tenantPack: tenantPackFixture as TenantPackDraft },
    );

    const compared = summary.records.filter((r) => r.deltaScore100 !== undefined);
    expect(compared.length).toBeGreaterThan(0);
  });

  it('skips rejected records', async () => {
    const records = [
      makeRecord({ status: 'REJECTED' }),
      makeRecord({ status: 'ACCEPTED' }),
    ];
    const path = writeFixture(records);

    const summary = await runTenantDataValidation(
      { inputPath: path, tenantId: 'tenant_acme' },
      { engine: makeStubEngine(), tenantPack: tenantPackFixture as TenantPackDraft },
    );

    expect(summary.totalRecords).toBe(1);
  });

  it('returns zero totals for empty input', async () => {
    const path = writeFixture([]);

    const summary = await runTenantDataValidation(
      { inputPath: path, tenantId: 'tenant_acme' },
      { engine: makeStubEngine(), tenantPack: tenantPackFixture as TenantPackDraft },
    );

    expect(summary.totalRecords).toBe(0);
    expect(summary.matched).toBe(0);
  });

  it('respects maxRecords limit', async () => {
    const records = Array.from({ length: 10 }, () => makeRecord());
    const path = writeFixture(records);

    const summary = await runTenantDataValidation(
      { inputPath: path, tenantId: 'tenant_acme', maxRecords: 3 },
      { engine: makeStubEngine(), tenantPack: tenantPackFixture as TenantPackDraft },
    );

    expect(summary.totalRecords).toBe(3);
  });

  it('aggregates results by engagement type', async () => {
    const records = [
      makeRecord({ engagementType: 'CALL' }),
      makeRecord({ engagementType: 'CALL' }),
      makeRecord({ engagementType: 'EMAIL' }),
    ];
    const path = writeFixture(records);

    const summary = await runTenantDataValidation(
      { inputPath: path, tenantId: 'tenant_acme' },
      { engine: makeStubEngine(), tenantPack: tenantPackFixture as TenantPackDraft },
    );

    expect(summary.byEngagementType['CALL']).toBeDefined();
    expect(summary.byEngagementType['CALL'].total).toBe(2);
    expect(summary.byEngagementType['EMAIL']).toBeDefined();
    expect(summary.byEngagementType['EMAIL'].total).toBe(1);
  });
});
