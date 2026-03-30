import {
  AnalysisJobRecord,
  AuditEventsSnapshot,
  ReviewQueueSnapshot,
  RunEventsSnapshot,
} from '../contracts/jobs';
import { AuditEvent, RunEvent } from '../contracts/runtime';

export interface JobListFilters {
  tenantId?: string;
}

export interface AuditEventFilters {
  tenantId?: string;
  resourceId?: string;
}

export interface JobStore {
  initialize(): Promise<void>;
  createJob(job: AnalysisJobRecord): Promise<AnalysisJobRecord>;
  getJob(jobId: string): Promise<AnalysisJobRecord | null>;
  updateJob(job: AnalysisJobRecord): Promise<AnalysisJobRecord>;
  listJobs(filters?: JobListFilters): Promise<AnalysisJobRecord[]>;
  listReviewQueue(tenantId?: string): Promise<ReviewQueueSnapshot>;
  claimNextQueuedJob(workerId: string, claimedAt: string): Promise<AnalysisJobRecord | null>;
  appendRunEvent(event: RunEvent): Promise<RunEvent>;
  listRunEvents(runId: string): Promise<RunEventsSnapshot>;
  appendAuditEvent(event: AuditEvent): Promise<AuditEvent>;
  listAuditEvents(filters?: AuditEventFilters): Promise<AuditEventsSnapshot>;
}
