import { CanaryAutomationService } from './canary-automation-service';

export interface CanaryAutomationWorkerOptions {
  automation: CanaryAutomationService;
  intervalMs?: number;
}

export class CanaryAutomationWorker {
  private readonly automation: CanaryAutomationService;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(options: CanaryAutomationWorkerOptions) {
    this.automation = options.automation;
    this.intervalMs = options.intervalMs ?? 60_000;
  }

  start(): void {
    if (this.timer) {
      return;
    }

    const tick = async (): Promise<void> => {
      if (this.running) {
        return;
      }

      this.running = true;
      try {
        await this.automation.evaluateConfiguredCanaries();
      } finally {
        this.running = false;
      }
    };

    this.timer = setInterval(() => {
      void tick();
    }, this.intervalMs);
    void tick();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
