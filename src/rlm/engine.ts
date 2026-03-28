import { RLM } from 'recursive-llm-ts';
import { z } from 'zod';
import {
  CanonicalExtraction,
  canonicalExtractionSchema,
} from '../contracts/analysis';

export interface CanonicalAnalysisRequest {
  query: string;
  context: string;
}

export interface CanonicalAnalysisEngineResult {
  extraction: CanonicalExtraction;
  engine: 'rlm' | 'stub';
  model?: string;
}

export interface CanonicalAnalysisEngine {
  analyze(input: CanonicalAnalysisRequest): Promise<CanonicalAnalysisEngineResult>;
}

export interface RlmConversationEngineConfig {
  model: string;
  apiKey?: string;
  apiBase?: string;
  recursiveModel?: string;
  maxDepth?: number;
  maxIterations?: number;
  maxTokens?: number;
  temperature?: number;
  goBinaryPath?: string;
}

const extractionSchema: z.ZodType<CanonicalExtraction> = canonicalExtractionSchema;

export class RlmCanonicalAnalysisEngine implements CanonicalAnalysisEngine {
  private readonly rlm: RLM;
  private readonly model: string;

  constructor(config: RlmConversationEngineConfig) {
    this.model = config.model;
    this.rlm = new RLM(config.model, {
      api_key: config.apiKey ?? process.env.OPENAI_API_KEY ?? '',
      api_base: config.apiBase,
      recursive_model: config.recursiveModel,
      max_depth: config.maxDepth ?? 2,
      max_iterations: config.maxIterations ?? 12,
      max_tokens: config.maxTokens,
      temperature: config.temperature ?? 0,
      go_binary_path: config.goBinaryPath,
      context_overflow: {
        enabled: true,
        strategy: 'refine',
      },
    });
  }

  async analyze(input: CanonicalAnalysisRequest): Promise<CanonicalAnalysisEngineResult> {
    const result = await this.rlm.structuredCompletion(
      input.query,
      input.context,
      extractionSchema,
      {
        maxRetries: 3,
        parallelExecution: true,
      },
    );

    return {
      extraction: result.result,
      engine: 'rlm',
      model: this.model,
    };
  }
}

export class StubCanonicalAnalysisEngine implements CanonicalAnalysisEngine {
  constructor(
    private readonly extraction:
      | CanonicalExtraction
      | ((input: CanonicalAnalysisRequest) => CanonicalExtraction),
  ) {}

  async analyze(input: CanonicalAnalysisRequest): Promise<CanonicalAnalysisEngineResult> {
    const extraction = typeof this.extraction === 'function'
      ? this.extraction(input)
      : this.extraction;

    return {
      extraction,
      engine: 'stub',
    };
  }
}
