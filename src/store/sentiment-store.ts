import {
  CalibrationSampleRecord,
  KeyMomentRecord,
  PhraseSearchResult,
  SentimentAnalysisRecord,
  SentimentSegmentRecord,
  SentimentTrendPoint,
} from '../contracts/sentiment-persistence';

export interface SentimentAnalysisFilters {
  tenantId?: string;
  polarity?: string;
  minScore100?: number;
  maxScore100?: number;
  limit?: number;
  offset?: number;
}

export interface KeyMomentFilters {
  tenantId?: string;
  type?: string;
  businessImpact?: string;
  limit?: number;
  offset?: number;
}

export interface CalibrationSampleFilters {
  tenantId?: string;
  useCase?: string;
  engagementType?: string;
  sinceDate?: string;
  limit?: number;
}

export type TrendBucket = 'day' | 'week' | 'month';

export interface SentimentStore {
  initialize(): Promise<void>;

  saveSentimentAnalysis(record: SentimentAnalysisRecord): Promise<SentimentAnalysisRecord>;
  getSentimentAnalysis(jobId: string): Promise<SentimentAnalysisRecord | null>;
  listSentimentAnalyses(filters?: SentimentAnalysisFilters): Promise<SentimentAnalysisRecord[]>;

  saveSentimentSegments(segments: SentimentSegmentRecord[]): Promise<void>;
  searchSegmentsByPhrase(tenantId: string, query: string, limit?: number): Promise<PhraseSearchResult[]>;

  saveKeyMoments(moments: KeyMomentRecord[]): Promise<void>;
  listKeyMoments(filters?: KeyMomentFilters): Promise<KeyMomentRecord[]>;

  saveCalibrationSample(sample: CalibrationSampleRecord): Promise<CalibrationSampleRecord>;
  listCalibrationSamples(filters?: CalibrationSampleFilters): Promise<CalibrationSampleRecord[]>;

  getSentimentTrend(tenantId: string, bucket: TrendBucket, days: number): Promise<SentimentTrendPoint[]>;
}
