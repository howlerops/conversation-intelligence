import { ModelValidationService } from './model-validation-service';

export interface ModelValidationWorkerOptions {
  validation: ModelValidationService;
  intervalMs?: number;
  beforeRun?: () => Promise<void>;
}

export class ModelValidationWorker {
  private readonly validation: ModelValidationService;
  private readonly intervalMs: number;
  private readonly beforeRun?: () => Promise<void>;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(options: ModelValidationWorkerOptions) {
    this.validation = options.validation;
    this.intervalMs = options.intervalMs ?? 24 * 60 * 60 * 1000;
    this.beforeRun = options.beforeRun;
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
        if (this.beforeRun) {
          await this.beforeRun();
        }
        await this.validation.runConfiguredValidations();
      } finally {
        this.running = false;
      }
    };

    void tick();
    this.timer = setInterval(() => {
      void tick();
    }, this.intervalMs);
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
