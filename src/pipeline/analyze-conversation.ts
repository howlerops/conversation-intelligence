import { randomUUID } from 'crypto';
import {
  CanonicalExtraction,
  ConversationAnalysis,
  conversationAnalysisSchema,
} from '../contracts/analysis';
import type { TenantAdminSentimentScoring } from '../contracts/admin-config';
import { PiiRedactionSummary } from '../contracts/pii';
import { PiiTokenMap, decodeExtraction, decodeSpeakerAssignments } from '../pii/masking';
import { transcriptInputSchema, TranscriptInputDraft } from '../contracts/transcript';
import { tenantPackSchema, TenantPackDraft } from '../contracts/tenant-pack';
import {
  noopRuntimeObservability,
  RuntimeObservability,
} from '../observability/runtime-observability';
import { normalizeTranscript } from './normalize-transcript';
import { resolveSpeakers } from './resolve-speakers';
import { buildCanonicalAnalysisPrompt } from '../rlm/prompting';
import {
  CanonicalAnalysisEngine,
  CanonicalAnalysisEngineResult,
} from '../rlm/engine';
import { mapTenantEvents } from './map-tenant-events';
import { verifyAnalysis } from './verify-analysis';
import { enrichOverallSentimentScore } from '../sentiment/scoring';
import {
  applySupportSentimentCueAdjustments,
  buildSupportSentimentCueProfile,
} from '../sentiment/support-cue-adjustment';

export interface AnalyzeConversationOptions {
  engine: CanonicalAnalysisEngine;
  jobId?: string;
  now?: Date;
  signal?: AbortSignal;
  piiRedactionSummary?: PiiRedactionSummary;
  /** When reversible PII masking was used, pass the token map here so speaker
   *  names and field values are restored in the returned analysis. */
  piiTokenMap?: PiiTokenMap;
  observability?: RuntimeObservability;
  sentimentScoringConfig?: TenantAdminSentimentScoring;
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
      comments: [],
      history: [],
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
  const observability = options.observability ?? noopRuntimeObservability;
  const normalized = normalizeTranscript(transcript);
  const speakerAssignments = resolveSpeakers(normalized, pack);
  const cueProfile = buildSupportSentimentCueProfile(normalized, speakerAssignments);
  const eligibleSentimentTurns = speakerAssignments.filter((assignment) => assignment.eligibleForSentiment);

  let extractionResult: CanonicalAnalysisEngineResult;
  let promptVersion = 'not-run';

  if (eligibleSentimentTurns.length === 0) {
    extractionResult = {
      extraction: buildEmptyExtraction('No END_USER-eligible turns were found in the transcript.'),
      engine: 'rules',
    };
  } else {
    const prompt = buildCanonicalAnalysisPrompt(normalized, speakerAssignments, pack);
    promptVersion = prompt.promptVersion;
    const span = observability.startSpan('conversation_intelligence.engine.analyze', {
      tenant_id: transcript.tenantId,
      use_case: transcript.useCase,
    });
    const startedAt = Date.now();

    try {
      extractionResult = await options.engine.analyze({
        query: prompt.query,
        context: prompt.context,
        signal: options.signal,
        eventTypeDefinitions: prompt.eventTypeDefinitions,
        supportedEventTypes: prompt.supportedEventTypes,
      });
      observability.incrementCounter('conversation_intelligence.engine.calls', 1, {
        engine: extractionResult.engine,
        model: extractionResult.model ?? 'unknown',
      });
      observability.recordHistogram(
        'conversation_intelligence.engine.duration_ms',
        Date.now() - startedAt,
        {
          engine: extractionResult.engine,
          model: extractionResult.model ?? 'unknown',
        },
      );
      span.end('ok', {
        engine: extractionResult.engine,
        model: extractionResult.model ?? 'unknown',
      });
    } catch (error) {
      observability.incrementCounter('conversation_intelligence.engine.errors', 1, {
        use_case: transcript.useCase,
      });
      span.fail(error);
      span.end('error');
      throw error;
    }
  }

  // Decode PII tokens in the extraction if reversible masking was used.
  // This restores real names/emails/phones in evidence quotes, rationales,
  // and the summary — while ensuring the LLM never saw the raw values.
  const tokenMap = options.piiTokenMap;
  const decodedExtraction = tokenMap && tokenMap.size > 0
    ? decodeExtraction(extractionResult.extraction, tokenMap)
    : extractionResult.extraction;
  const decodedSpeakerAssignments = tokenMap && tokenMap.size > 0
    ? decodeSpeakerAssignments(speakerAssignments, tokenMap)
    : speakerAssignments;

  const averageConfidence = decodedSpeakerAssignments.reduce(
    (sum, assignment) => sum + assignment.confidence,
    0,
  ) / Math.max(decodedSpeakerAssignments.length, 1);

  const engagementType = resolveEngagementType(transcript.metadata.engagementType);
  const scoredSentiment = enrichOverallSentimentScore(decodedExtraction.overallEndUserSentiment, {
    scoringConfig: options.sentimentScoringConfig,
    context: {
      engagementType,
    },
  });

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
      resolvedRoles: Array.from(new Set(decodedSpeakerAssignments.map((assignment) => assignment.role))),
      confidence: Number(averageConfidence.toFixed(4)),
    },
    overallEndUserSentiment: applySupportSentimentCueAdjustments(scoredSentiment, {
      engagementType,
      profile: cueProfile,
    }),
    aspectSentiments: decodedExtraction.aspectSentiments,
    canonicalEvents: decodedExtraction.canonicalEvents,
    canonicalKeyMoments: decodedExtraction.canonicalKeyMoments,
    tenantMappedEvents: mapTenantEvents(decodedExtraction.canonicalEvents, pack),
    speakerAssignments: decodedSpeakerAssignments,
    review: decodedExtraction.review,
    piiRedactionSummary: options.piiRedactionSummary,
    summary: decodedExtraction.summary,
    trace: {
      engine: extractionResult.engine === 'rlm' ? 'rlm' : 'rules',
      model: extractionResult.model,
      packVersion: pack.packVersion,
      promptVersion,
      generatedAt: (options.now ?? new Date()).toISOString(),
    },
  });

  return verifyAnalysis(analysis, pack);
}

function resolveEngagementType(value: unknown): 'CALL' | 'EMAIL' | 'TICKET' | 'CHAT' | undefined {
  return value === 'CALL' || value === 'EMAIL' || value === 'TICKET' || value === 'CHAT'
    ? value
    : undefined;
}
