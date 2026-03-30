/**
 * Export a fine-tuning dataset from gold-label public records.
 *
 * Each output line is one OpenAI-compatible chat JSONL training example:
 *   { messages: [ {role:system}, {role:user, content:<prompt>}, {role:assistant, content:<ideal JSON>} ] }
 *
 * The prompt uses the exact same pipeline as production inference so the fine-tuned
 * model learns the same input shape it will see at runtime.
 *
 * Usage:
 *   npx tsx examples/export-fine-tuning-dataset.ts [--output dir] [--split 0.8]
 *
 * Options:
 *   --output <dir>   Output directory (default: output/fine-tuning)
 *   --split <ratio>  Train/eval split ratio (default: 0.8)
 *   --tenant-pack    Tenant pack path (default: fixtures/tenant-pack.support.acme.json)
 */
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import {
  normalizeTranscript,
  resolveSpeakers,
  buildCanonicalAnalysisPrompt,
  buildOllamaCompatPromptForExport,
  TenantPackDraft,
  TranscriptInputDraft,
} from '../src';
import { generateHybridGoldLabelDataset } from '../src/validation/synthetic-gold-label-generator';
import { GoldLabelRecord } from '../src/validation/gold-label-toolkit';

// ---------------------------------------------------------------------------
// Build the ideal assistant response from analyst gold labels.
// This is the JSON we WANT the model to output for each training example.
// ---------------------------------------------------------------------------

function buildIdealResponse(
  record: GoldLabelRecord,
  transcript: TranscriptInputDraft,
): string {
  const { score100, polarity } = record.sentiment;

  const intensity = score100 <= 20 ? 0.9
    : score100 <= 40 ? 0.7
    : score100 <= 60 ? 0.5
    : score100 <= 80 ? 0.65
    : 0.85;

  const turns = (transcript.turns ?? []) as Array<{ turnId: string; text?: string }>;
  const AGENT_TYPES = new Set(['RESOLUTION_COMMITMENT', 'POLICY_CONFLICT']);

  const canonicalEvents = record.expectedKeyMoments.map((km, i) => {
    const actorRole = AGENT_TYPES.has(km.type) ? 'AGENT' : 'END_USER';
    const turnIdx = actorRole === 'AGENT'
      ? Math.min(i * 2 + 1, turns.length - 1)
      : Math.min(i * 2, turns.length - 1);
    const turn = turns[turnIdx] ?? turns[0];
    const quote = turn ? ((turn.text ?? '') as string).slice(0, 80) : '';
    return {
      type: km.type,
      actorRole,
      confidence: 0.85,
      rationale: `${km.type.replace(/_/g, ' ').toLowerCase()} detected in transcript.`,
      businessImpact: km.businessImpact ?? (score100 <= 30 ? 'HIGH' : score100 <= 55 ? 'MEDIUM' : 'LOW'),
      evidence: turn && quote ? [{ turnId: turn.turnId, speakerRole: actorRole, quote }] : [],
    };
  });

  const canonicalKeyMoments = canonicalEvents.map((evt, i) => ({
    ...evt,
    startTurnId: turns[Math.max(0, i * 2)]?.turnId ?? turns[0]?.turnId ?? 't1',
    endTurnId: turns[Math.min(turns.length - 1, i * 2 + 2)]?.turnId
      ?? turns[turns.length - 1]?.turnId ?? 't1',
  }));

  const descriptions: Record<string, string> = {
    VERY_NEGATIVE: 'Customer expressed significant distress throughout the interaction.',
    NEGATIVE: 'Customer showed frustration or unresolved concern.',
    NEUTRAL: 'Conversation was primarily transactional with no strong emotional signals.',
    POSITIVE: 'Customer appeared satisfied with the resolution provided.',
    VERY_POSITIVE: 'Customer expressed strong appreciation or delight.',
  };

  const summary = `${descriptions[polarity] ?? 'Conversation analyzed.'} Score: ${score100}/100.`;
  const reviewReasons: string[] = [];
  if (record.sentiment.correctionApplied) reviewReasons.push('Analyst correction applied.');
  if (record.sentiment.note) reviewReasons.push(record.sentiment.note);

  return JSON.stringify({
    summary,
    overallEndUserSentiment: {
      polarity,
      intensity,
      confidence: 0.9,
      rationale: descriptions[polarity] ?? '',
      score100,
    },
    canonicalEvents,
    canonicalKeyMoments,
    reviewState: record.expectedReviewState ?? 'VERIFIED',
    reviewReasons,
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  outputDir: string;
  splitRatio: number;
  tenantPackPath: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    outputDir: resolve(process.cwd(), 'output/fine-tuning'),
    splitRatio: 0.8,
    tenantPackPath: resolve(process.cwd(), 'fixtures/tenant-pack.support.acme.json'),
  };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--output': args.outputDir = resolve(argv[++i]); break;
      case '--split': args.splitRatio = Number(argv[++i]); break;
      case '--tenant-pack': args.tenantPackPath = resolve(argv[++i]); break;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  mkdirSync(args.outputDir, { recursive: true });

  const tenantPack = JSON.parse(readFileSync(args.tenantPackPath, 'utf8')) as TenantPackDraft;

  // Load all public records that have real transcripts
  const hybrid = generateHybridGoldLabelDataset({}, process.cwd());
  const usable = hybrid.publicRecords.filter(
    (r) => hybrid.transcriptsByRecordId.has(r.recordId) && r.status !== 'REJECTED',
  );

  console.log(`Found ${usable.length} public records with transcripts.`);
  const byType: Record<string, number> = {};
  for (const r of usable) byType[r.engagementType] = (byType[r.engagementType] ?? 0) + 1;
  for (const [k, v] of Object.entries(byType)) console.log(`  ${k}: ${v}`);

  const SYSTEM_MSG = 'You are a conversation-intelligence extraction assistant. Return only valid JSON.';

  const examples: Array<{ recordId: string; system: string; user: string; assistant: string }> = [];
  let skipped = 0;

  for (const record of usable) {
    const transcript = hybrid.transcriptsByRecordId.get(record.recordId)!;
    try {
      const normalized = normalizeTranscript(transcript as Parameters<typeof normalizeTranscript>[0]);
      const assignments = resolveSpeakers(normalized, tenantPack as Parameters<typeof resolveSpeakers>[1]);
      const prompt = buildCanonicalAnalysisPrompt(normalized, assignments, tenantPack as Parameters<typeof buildCanonicalAnalysisPrompt>[2]);

      const userMsg = buildOllamaCompatPromptForExport({
        query: prompt.query,
        context: prompt.context,
        eventTypeDefinitions: prompt.eventTypeDefinitions,
        supportedEventTypes: prompt.supportedEventTypes,
      });
      const assistantMsg = buildIdealResponse(record, transcript);

      // Verify assistant output parses correctly
      JSON.parse(assistantMsg);

      examples.push({ recordId: record.recordId, system: SYSTEM_MSG, user: userMsg, assistant: assistantMsg });
    } catch (err) {
      console.warn(`  Skipped ${record.recordId}: ${(err as Error).message}`);
      skipped++;
    }
  }

  console.log(`\nBuilt ${examples.length} examples (${skipped} skipped).`);

  // Deterministic sort then train/eval split
  examples.sort((a, b) => a.recordId.localeCompare(b.recordId));
  const trainCount = Math.round(examples.length * args.splitRatio);
  const trainSet = examples.slice(0, trainCount);
  const evalSet = examples.slice(trainCount);
  console.log(`Train: ${trainSet.length} | Eval: ${evalSet.length}`);

  const toJsonl = (set: typeof examples) =>
    set.map((ex) => JSON.stringify({
      messages: [
        { role: 'system', content: ex.system },
        { role: 'user', content: ex.user },
        { role: 'assistant', content: ex.assistant },
      ],
    })).join('\n') + '\n';

  const trainPath = resolve(args.outputDir, 'train.jsonl');
  const evalPath = resolve(args.outputDir, 'eval.jsonl');
  const manifestPath = resolve(args.outputDir, 'manifest.json');

  writeFileSync(trainPath, toJsonl(trainSet));
  writeFileSync(evalPath, toJsonl(evalSet));
  writeFileSync(manifestPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalExamples: examples.length,
    trainExamples: trainSet.length,
    evalExamples: evalSet.length,
    splitRatio: args.splitRatio,
    byEngagementType: byType,
    recordIds: examples.map((e) => e.recordId),
  }, null, 2));

  console.log(`\nWrote:`);
  console.log(`  ${trainPath}`);
  console.log(`  ${evalPath}`);
  console.log(`  ${manifestPath}`);
  console.log(`\nNext steps (pick one):`);
  console.log(`  OpenAI gpt-4o-mini (easiest):`);
  console.log(`    openai api fine_tuning.jobs.create -t ${trainPath} -v ${evalPath} -m gpt-4o-mini`);
  console.log(`  Axolotl QLoRA local (see docs/FINE_TUNING.md for full config):`);
  console.log(`    axolotl train docs/axolotl-qlora.yml`);
}

main().catch(console.error);
