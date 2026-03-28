import { randomUUID } from 'crypto';
import { AnalysisJobRecord } from '../contracts/jobs';
import { ConversationIntelligenceService } from './conversation-intelligence-service';

export interface AnalysisWorkerOptions {
  service: ConversationIntelligenceService;
  pollIntervalMs?: number;
  workerId?: string;
}

export class AnalysisWorker {
  private readonly service: ConversationIntelligenceService;
  private readonly pollIntervalMs: number;
  private readonly workerId: string;
  private running = false;
  private loopPromise: Promise<void> | null = null;

  constructor(options: AnalysisWorkerOptions) {
    this.service = options.service;
    this.pollIntervalMs = options.pollIntervalMs ?? 50;
    this.workerId = options.workerId ?? randomUUID();
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loopPromise;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const claimed = await this.service.claimNextQueuedJob(this.workerId);

      if (!claimed) {
        await this.sleep(this.pollIntervalMs);
        continue;
      }

      await this.service.processClaimedJob(claimed);
    }
  }

  private sleep(durationMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, durationMs));
  }
}
