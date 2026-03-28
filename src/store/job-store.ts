import { AnalysisJobRecord, ReviewQueueSnapshot } from '../contracts/jobs';

export interface JobStore {
  initialize(): Promise<void>;
  createJob(job: AnalysisJobRecord): Promise<AnalysisJobRecord>;
  getJob(jobId: string): Promise<AnalysisJobRecord | null>;
  updateJob(job: AnalysisJobRecord): Promise<AnalysisJobRecord>;
  listJobs(): Promise<AnalysisJobRecord[]>;
  listReviewQueue(): Promise<ReviewQueueSnapshot>;
  claimNextQueuedJob(workerId: string, claimedAt: string): Promise<AnalysisJobRecord | null>;
}
