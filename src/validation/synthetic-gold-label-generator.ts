import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { GoldLabelRecord, GoldLabelDatasetSummary, summarizeGoldLabelDataset } from './gold-label-toolkit';
import { ExpectedKeyMoment } from './key-moment-evaluation';
import { SentimentPolarity } from '../contracts/roles';
import {
  buildPublicDataPipelineSuite,
  PublicDataPipelineSuiteOutput,
  PublicDataPipelineRecordOutput,
} from './public-data-test-pipeline';
import { TranscriptInputDraft } from '../contracts/transcript';

export interface SyntheticGoldLabelOptions {
  count?: number;
  seed?: number;
  edgeCases?: boolean;
  keyMomentSubsetRate?: number;
}

// mulberry32 — deterministic 32-bit PRNG
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function polarityFromScore(score100: number): SentimentPolarity {
  if (score100 <= 15) return 'VERY_NEGATIVE';
  if (score100 <= 35) return 'NEGATIVE';
  if (score100 <= 65) return 'NEUTRAL';
  if (score100 <= 85) return 'POSITIVE';
  return 'VERY_POSITIVE';
}

function score5FromScore100(score100: number): 1 | 2 | 3 | 4 | 5 {
  if (score100 <= 20) return 1;
  if (score100 <= 40) return 2;
  if (score100 <= 60) return 3;
  if (score100 <= 80) return 4;
  return 5;
}

const ENGAGEMENT_TYPES = ['CALL', 'EMAIL', 'TICKET', 'CHAT'] as const;
const TENANTS = ['acme', 'globex', 'initech'];
const USE_CASES = ['support', 'sales', 'onboarding'];
const REVIEWERS = ['analyst-1', 'analyst-2', 'analyst-3'];
const DATASETS = ['ABCD', 'Taskmaster', 'Doc2Dial', 'DynaSent', 'SARC'];
const KEY_MOMENT_TYPES = [
  'FRUSTRATION_ONSET', 'ESCALATION_REQUEST', 'POLICY_CONFLICT',
  'PROMISE_BROKEN', 'RESOLUTION_COMMITMENT',
] as const;

export function generateSyntheticGoldLabelDataset(
  options: SyntheticGoldLabelOptions = {},
): GoldLabelRecord[] {
  const count = options.count ?? 120;
  const seed = options.seed ?? 42;
  const edgeCases = options.edgeCases ?? true;
  const keyMomentRate = options.keyMomentSubsetRate ?? 0.3;
  const rand = mulberry32(seed);

  const perType = Math.floor(count / ENGAGEMENT_TYPES.length);
  const records: GoldLabelRecord[] = [];

  for (const engType of ENGAGEMENT_TYPES) {
    for (let i = 0; i < perType; i++) {
      const idx = records.length;
      const r = rand();
      const score100 = Math.max(5, Math.min(95, Math.round(r * 90 + 5)));
      const statusRoll = rand();
      const status = statusRoll < 0.7 ? 'ACCEPTED' as const : statusRoll < 0.9 ? 'CORRECTED' as const : 'REJECTED' as const;

      const expectedKeyMoments: ExpectedKeyMoment[] = [];
      if (rand() < keyMomentRate) {
        const momentCount = rand() < 0.6 ? 1 : 2;
        for (let m = 0; m < momentCount; m++) {
          expectedKeyMoments.push({
            type: KEY_MOMENT_TYPES[Math.floor(rand() * KEY_MOMENT_TYPES.length)],
            businessImpact: score100 < 30 ? 'HIGH' : score100 < 50 ? 'MEDIUM' : 'LOW',
          });
        }
      }

      records.push({
        recordId: `gold-${engType}-${String(i + 1).padStart(3, '0')}`,
        tenantId: TENANTS[idx % TENANTS.length],
        useCase: USE_CASES[idx % USE_CASES.length],
        engagementType: engType,
        sourceDataset: DATASETS[idx % DATASETS.length],
        reviewedBy: REVIEWERS[idx % REVIEWERS.length],
        reviewedAt: new Date(Date.now() - Math.round(rand() * 30 * 86400_000)).toISOString(),
        status,
        sentiment: {
          score100,
          score5: score5FromScore100(score100),
          polarity: polarityFromScore(score100),
          correctionApplied: status === 'CORRECTED',
        },
        expectedKeyMoments,
      });
    }
  }

  if (edgeCases) {
    const baseIdx = records.length;
    const edgeCaseRecords: GoldLabelRecord[] = [];

    // 8 sarcasm cases — polarity is positive but score is low (model might be confused)
    for (let i = 0; i < 8; i++) {
      const engType = ENGAGEMENT_TYPES[i % ENGAGEMENT_TYPES.length];
      edgeCaseRecords.push({
        recordId: `gold-sarcasm-${i + 1}`,
        tenantId: TENANTS[(baseIdx + i) % TENANTS.length],
        useCase: 'support',
        engagementType: engType,
        sourceDataset: 'SARC',
        reviewedBy: REVIEWERS[(baseIdx + i) % REVIEWERS.length],
        reviewedAt: new Date(Date.now() - Math.round(rand() * 30 * 86400_000)).toISOString(),
        status: 'CORRECTED',
        sentiment: {
          score100: 20 + Math.round(rand() * 15),
          score5: 2,
          polarity: 'NEGATIVE',
          correctionApplied: true,
          note: 'Sarcastic tone — literal sentiment positive but intended negative.',
        },
        expectedKeyMoments: [{ type: 'FRUSTRATION_ONSET' }],
      });
    }

    // 6 mixed sentiment cases — score near 50
    for (let i = 0; i < 6; i++) {
      const engType = ENGAGEMENT_TYPES[i % ENGAGEMENT_TYPES.length];
      edgeCaseRecords.push({
        recordId: `gold-mixed-${i + 1}`,
        tenantId: TENANTS[(baseIdx + 8 + i) % TENANTS.length],
        useCase: 'support',
        engagementType: engType,
        sourceDataset: 'DynaSent',
        reviewedBy: REVIEWERS[(baseIdx + 8 + i) % REVIEWERS.length],
        reviewedAt: new Date(Date.now() - Math.round(rand() * 30 * 86400_000)).toISOString(),
        status: 'ACCEPTED',
        sentiment: {
          score100: 45 + Math.round(rand() * 10),
          score5: 3,
          polarity: 'NEUTRAL',
          correctionApplied: false,
          note: 'Mixed sentiment — positive about resolution, negative about wait time.',
        },
        expectedKeyMoments: [],
      });
    }

    // 6 multi-speaker cases
    for (let i = 0; i < 6; i++) {
      const engType = ENGAGEMENT_TYPES[i % ENGAGEMENT_TYPES.length];
      const score = 30 + Math.round(rand() * 40);
      edgeCaseRecords.push({
        recordId: `gold-multispeaker-${i + 1}`,
        tenantId: TENANTS[(baseIdx + 14 + i) % TENANTS.length],
        useCase: 'support',
        engagementType: engType,
        sourceDataset: 'Taskmaster',
        reviewedBy: REVIEWERS[(baseIdx + 14 + i) % REVIEWERS.length],
        reviewedAt: new Date(Date.now() - Math.round(rand() * 30 * 86400_000)).toISOString(),
        status: 'ACCEPTED',
        sentiment: {
          score100: score,
          score5: score5FromScore100(score),
          polarity: polarityFromScore(score),
          correctionApplied: false,
          note: 'Multi-speaker conversation with divergent sentiment across participants.',
        },
        expectedKeyMoments: rand() < 0.5 ? [{ type: 'ESCALATION_REQUEST' }] : [],
      });
    }

    // 3 short transcripts
    for (let i = 0; i < 3; i++) {
      const score = 60 + Math.round(rand() * 30);
      edgeCaseRecords.push({
        recordId: `gold-short-${i + 1}`,
        tenantId: TENANTS[(baseIdx + 20 + i) % TENANTS.length],
        useCase: 'support',
        engagementType: ENGAGEMENT_TYPES[i % ENGAGEMENT_TYPES.length],
        sourceDataset: 'ABCD',
        reviewedBy: REVIEWERS[i % REVIEWERS.length],
        reviewedAt: new Date(Date.now() - Math.round(rand() * 30 * 86400_000)).toISOString(),
        status: 'ACCEPTED',
        sentiment: {
          score100: score,
          score5: score5FromScore100(score),
          polarity: polarityFromScore(score),
          correctionApplied: false,
        },
        expectedKeyMoments: [],
        transcriptHash: `short-${i + 1}`,
      });
    }

    // 2 long transcripts
    for (let i = 0; i < 2; i++) {
      const score = 15 + Math.round(rand() * 25);
      edgeCaseRecords.push({
        recordId: `gold-long-${i + 1}`,
        tenantId: TENANTS[(baseIdx + 23 + i) % TENANTS.length],
        useCase: 'support',
        engagementType: ENGAGEMENT_TYPES[i % ENGAGEMENT_TYPES.length],
        sourceDataset: 'Doc2Dial',
        reviewedBy: REVIEWERS[i % REVIEWERS.length],
        reviewedAt: new Date(Date.now() - Math.round(rand() * 30 * 86400_000)).toISOString(),
        status: 'CORRECTED',
        sentiment: {
          score100: score,
          score5: score5FromScore100(score),
          polarity: polarityFromScore(score),
          correctionApplied: true,
          note: 'Very long transcript with sentiment shift over time.',
        },
        expectedKeyMoments: [{ type: 'FRUSTRATION_ONSET' }, { type: 'RESOLUTION_COMMITMENT' }],
        transcriptHash: `long-${i + 1}`,
      });
    }

    records.push(...edgeCaseRecords);
  }

  return records;
}

export interface GoldLabelCoverageValidation {
  valid: boolean;
  issues: string[];
}

export function validateGoldLabelCoverage(records: GoldLabelRecord[]): GoldLabelCoverageValidation {
  const issues: string[] = [];
  const summary = summarizeGoldLabelDataset(records);

  for (const type of ENGAGEMENT_TYPES) {
    if ((summary.byEngagementType[type] ?? 0) < 25) {
      issues.push(`${type}: only ${summary.byEngagementType[type] ?? 0} records (need 25+)`);
    }
  }

  const hasSarcasm = records.some((r) => r.sentiment.note?.toLowerCase().includes('sarcas'));
  if (!hasSarcasm) issues.push('Missing sarcasm edge cases');

  const hasMixed = records.some((r) => r.sentiment.note?.toLowerCase().includes('mixed'));
  if (!hasMixed) issues.push('Missing mixed sentiment edge cases');

  const hasMultiSpeaker = records.some((r) => r.sentiment.note?.toLowerCase().includes('multi-speaker'));
  if (!hasMultiSpeaker) issues.push('Missing multi-speaker edge cases');

  const withKeyMoments = records.filter((r) => r.expectedKeyMoments.length > 0);
  if (withKeyMoments.length < 20) {
    issues.push(`Only ${withKeyMoments.length} records have expected key moments (need 20+)`);
  }

  if (!summary.statisticallySignificant) {
    issues.push(`Only ${summary.accepted + summary.corrected} usable records (need 100+)`);
  }

  return { valid: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Hybrid gold-label dataset — real public data + synthetic gap fillers.
// ---------------------------------------------------------------------------

export interface HybridGoldLabelOptions {
  pipelineSuitePaths?: string[];
  syntheticCount?: number;
  seed?: number;
  minimumPerEngagementType?: number;
}

export interface HybridGoldLabelDataset {
  records: GoldLabelRecord[];
  publicRecords: GoldLabelRecord[];
  syntheticRecords: GoldLabelRecord[];
  transcriptsByRecordId: Map<string, TranscriptInputDraft>;
}

const DEFAULT_PIPELINE_SUITE_PATHS = [
  'fixtures/public-data/pipeline-suite.json',
  'fixtures/public-data/pipeline-suite.support-doc2dial.json',
  'fixtures/public-data/pipeline-suite.support-callcenteren.research.json',
];

function loadPipelineSuites(paths: string[], cwd: string): PublicDataPipelineSuiteOutput[] {
  const suites: PublicDataPipelineSuiteOutput[] = [];
  for (const path of paths) {
    const resolved = resolve(cwd, path);
    if (!existsSync(resolved)) continue;
    const raw = JSON.parse(readFileSync(resolved, 'utf8'));
    suites.push(buildPublicDataPipelineSuite(raw, () => new Date('2026-03-28T00:00:00.000Z')));
  }
  return suites;
}

function publicRecordToGoldLabel(
  record: PublicDataPipelineRecordOutput,
  pipelineEngagementType: string,
): { goldLabel: GoldLabelRecord; transcript: TranscriptInputDraft } | null {
  const sample = record.reviewedSentimentSample;
  if (!sample?.analyst) return null;

  const analystScore100 = sample.analyst.score100;
  const engType = (record.transcript.metadata?.engagementType as string)
    ?? pipelineEngagementType;
  const normalizedEngType = (['CALL', 'EMAIL', 'TICKET', 'CHAT'].includes(engType) ? engType : 'CALL') as
    'CALL' | 'EMAIL' | 'TICKET' | 'CHAT';

  const expectedKeyMoments: ExpectedKeyMoment[] = record.canonicalEventLabels.map((type) => ({
    type,
  }));

  const goldLabel: GoldLabelRecord = {
    recordId: `public-${record.dataset.toLowerCase()}-${record.sourceRecordId}`,
    tenantId: record.tenantId,
    useCase: record.useCase,
    engagementType: normalizedEngType,
    sourceDataset: record.dataset,
    reviewedBy: sample.reviewedBy ?? 'public_annotator',
    reviewedAt: sample.reviewedAt ?? '2026-03-28T00:00:00.000Z',
    status: 'ACCEPTED',
    sentiment: {
      score100: analystScore100,
      score5: score5FromScore100(analystScore100),
      polarity: polarityFromScore(analystScore100),
      correctionApplied: sample.analyst.correctionApplied ?? false,
      note: sample.note,
    },
    expectedKeyMoments,
    expectedReviewState: sample.analyst.reviewState,
  };

  return { goldLabel, transcript: record.transcript as TranscriptInputDraft };
}

export function generateHybridGoldLabelDataset(
  options: HybridGoldLabelOptions = {},
  cwd = process.cwd(),
): HybridGoldLabelDataset {
  const paths = options.pipelineSuitePaths ?? DEFAULT_PIPELINE_SUITE_PATHS;
  const syntheticCount = options.syntheticCount ?? 100;
  const seed = options.seed ?? 42;
  const minPerType = options.minimumPerEngagementType ?? 25;

  const suites = loadPipelineSuites(paths, cwd);
  const transcriptsByRecordId = new Map<string, TranscriptInputDraft>();
  const publicRecords: GoldLabelRecord[] = [];

  for (const suite of suites) {
    for (const pipeline of suite.pipelines) {
      for (const record of pipeline.records) {
        const result = publicRecordToGoldLabel(record, pipeline.engagementType);
        if (!result) continue;
        publicRecords.push(result.goldLabel);
        transcriptsByRecordId.set(result.goldLabel.recordId, result.transcript);
      }
    }
  }

  const publicByType: Record<string, number> = {};
  for (const r of publicRecords) {
    publicByType[r.engagementType] = (publicByType[r.engagementType] ?? 0) + 1;
  }

  const neededPerType: Record<string, number> = {};
  let totalNeeded = 0;
  for (const type of ENGAGEMENT_TYPES) {
    const gap = Math.max(0, minPerType - (publicByType[type] ?? 0));
    neededPerType[type] = gap;
    totalNeeded += gap;
  }

  const syntheticTarget = Math.max(syntheticCount, totalNeeded);
  const syntheticRecords = generateSyntheticGoldLabelDataset({
    count: syntheticTarget,
    seed,
    edgeCases: true,
  });

  const allRecords = [...publicRecords, ...syntheticRecords];

  return {
    records: allRecords,
    publicRecords,
    syntheticRecords,
    transcriptsByRecordId,
  };
}
