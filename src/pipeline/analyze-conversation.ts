import { randomUUID } from 'crypto';
import {
  CanonicalExtraction,
  ConversationAnalysis,
  conversationAnalysisSchema,
} from '../contracts/analysis';
import { PiiRedactionSummary } from '../contracts/pii';
import { transcriptInputSchema, TranscriptInputDraft } from '../contracts/transcript';
import { tenantPackSchema, TenantPackDraft } from '../contracts/tenant-pack';
import { normalizeTranscript } from './normalize-transcript';
import { resolveSpeakers } from './resolve-speakers';
import { buildCanonicalAnalysisPrompt } from '../rlm/prompting';
import {
  CanonicalAnalysisEngine,
  CanonicalAnalysisEngineResult,
} from '../rlm/engine';
import { mapTenantEvents } from './map-tenant-events';
import { verifyAnalysis } from './verify-analysis';

export interface AnalyzeConversationOptions {
  engine: CanonicalAnalysisEngine;
  jobId?: string;
  now?: Date;
  piiRedactionSummary?: PiiRedactionSummary;
}

function buildEmptyExtraction(reason: string): CanonicalExtraction {
  return {
    overallEndUserSentiment: null,
    aspectSentiments: [],
    canonicalEvents: [],
    canonicalKeyMoments: [],
    summary: 'Analysis skipped pending review.',
    review: {
      state: 'NEEDS_REVIEW',
      reasons: [reason],
    },
  };
}

export async function analyzeConversation(
  input: TranscriptInputDraft,
  packInput: TenantPackDraft,
  options: AnalyzeConversationOptions,
): Promise<ConversationAnalysis> {
  const transcript = transcriptInputSchema.parse(input);
  const pack = tenantPackSchema.parse(packInput);
  const normalized = normalizeTranscript(transcript);
  const speakerAssignments = resolveSpeakers(normalized, pack);
  const eligibleSentimentTurns = speakerAssignments.filter((assignment) => assignment.eligibleForSentiment);

  let extractionResult: CanonicalAnalysisEngineResult;
  let promptVersion = 'not-run';

  if (eligibleSentimentTurns.length === 0) {
    extractionResult = {
      extraction: buildEmptyExtraction('No END_USER-eligible turns were found in the transcript.'),
      engine: 'stub',
    };
  } else {
    const prompt = buildCanonicalAnalysisPrompt(normalized, speakerAssignments, pack);
    promptVersion = prompt.promptVersion;
    extractionResult = await options.engine.analyze({
      query: prompt.query,
      context: prompt.context,
    });
  }

  const averageConfidence = speakerAssignments.reduce(
    (sum, assignment) => sum + assignment.confidence,
    0,
  ) / Math.max(speakerAssignments.length, 1);

  const analysis = conversationAnalysisSchema.parse({
    jobId: options.jobId ?? randomUUID(),
    tenantId: transcript.tenantId,
    conversationId: transcript.conversationId,
    useCase: transcript.useCase,
    analysisScope: {
      sentimentRoles: pack.analysisPolicy.sentimentRoles,
      keyMomentRoles: pack.analysisPolicy.keyMomentRoles,
    },
    speakerSummary: {
      resolvedRoles: Array.from(new Set(speakerAssignments.map((assignment) => assignment.role))),
      confidence: Number(averageConfidence.toFixed(4)),
    },
    overallEndUserSentiment: extractionResult.extraction.overallEndUserSentiment,
    aspectSentiments: extractionResult.extraction.aspectSentiments,
    canonicalEvents: extractionResult.extraction.canonicalEvents,
    canonicalKeyMoments: extractionResult.extraction.canonicalKeyMoments,
    tenantMappedEvents: mapTenantEvents(extractionResult.extraction.canonicalEvents, pack),
    speakerAssignments,
    review: extractionResult.extraction.review,
    piiRedactionSummary: options.piiRedactionSummary,
    summary: extractionResult.extraction.summary,
    trace: {
      engine: extractionResult.engine,
      model: extractionResult.model,
      packVersion: pack.packVersion,
      promptVersion,
      generatedAt: (options.now ?? new Date()).toISOString(),
    },
  });

  return verifyAnalysis(analysis, pack);
}
