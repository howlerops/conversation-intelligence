import {
  ModelValidationAlert,
  ModelValidationAlertSeverity,
  ModelValidationReport,
} from '../contracts';
import {
  RuntimeObservability,
  noopRuntimeObservability,
} from '../observability/runtime-observability';

export interface ValidationAlertNotifier {
  notify(report: ModelValidationReport): Promise<void>;
}

export interface WebhookValidationAlertNotifierOptions {
  webhookUrls: string[];
  minimumSeverity?: ModelValidationAlertSeverity;
  fetcher?: typeof fetch;
  observability?: RuntimeObservability;
}

export interface SlackValidationAlertNotifierOptions {
  webhookUrl: string;
  minimumSeverity?: ModelValidationAlertSeverity;
  fetcher?: typeof fetch;
  observability?: RuntimeObservability;
}

function severityRank(severity: ModelValidationAlertSeverity): number {
  switch (severity) {
    case 'CRITICAL':
      return 3;
    case 'WARNING':
      return 2;
    case 'INFO':
      return 1;
  }
}

export class CompositeValidationAlertNotifier implements ValidationAlertNotifier {
  constructor(private readonly notifiers: ValidationAlertNotifier[]) {}

  async notify(report: ModelValidationReport): Promise<void> {
    for (const notifier of this.notifiers) {
      await notifier.notify(report);
    }
  }
}

export class WebhookValidationAlertNotifier implements ValidationAlertNotifier {
  private readonly webhookUrls: string[];
  private readonly minimumSeverity: ModelValidationAlertSeverity;
  private readonly fetcher: typeof fetch;
  private readonly observability: RuntimeObservability;

  constructor(options: WebhookValidationAlertNotifierOptions) {
    this.webhookUrls = Array.from(new Set(options.webhookUrls.filter(Boolean)));
    this.minimumSeverity = options.minimumSeverity ?? 'WARNING';
    this.fetcher = options.fetcher ?? fetch;
    this.observability = options.observability ?? noopRuntimeObservability;
  }

  async notify(report: ModelValidationReport): Promise<void> {
    if (!this.webhookUrls.length) {
      return;
    }

    const alerts = report.alerts.filter((alert) => (
      severityRank(alert.severity) >= severityRank(this.minimumSeverity)
    ));
    if (!alerts.length) {
      return;
    }

    const payload = {
      generatedAt: report.generatedAt,
      tenantId: report.tenantId,
      useCase: report.useCase,
      packVersion: report.packVersion,
      reportId: report.reportId,
      alerts,
      liveMetrics: report.liveMetrics,
      reviewedMetrics: report.reviewedMetrics,
      regression: report.regression,
    };

    await Promise.all(this.webhookUrls.map(async (url) => {
      const response = await this.fetcher(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        this.observability.incrementCounter('conversation_intelligence.model_validation.alert_delivery.failures', 1, {
          channel: 'webhook',
          severity: highestSeverity(alerts),
        });
        throw new Error(`Alert webhook ${url} returned ${response.status} ${response.statusText}.`);
      }

      this.observability.incrementCounter('conversation_intelligence.model_validation.alert_delivery.success', 1, {
        channel: 'webhook',
        severity: highestSeverity(alerts),
      });
    }));
  }
}

export class SlackValidationAlertNotifier implements ValidationAlertNotifier {
  private readonly webhookUrl: string;
  private readonly minimumSeverity: ModelValidationAlertSeverity;
  private readonly fetcher: typeof fetch;
  private readonly observability: RuntimeObservability;

  constructor(options: SlackValidationAlertNotifierOptions) {
    this.webhookUrl = options.webhookUrl;
    this.minimumSeverity = options.minimumSeverity ?? 'WARNING';
    this.fetcher = options.fetcher ?? fetch;
    this.observability = options.observability ?? noopRuntimeObservability;
  }

  async notify(report: ModelValidationReport): Promise<void> {
    const alerts = report.alerts.filter((alert) => (
      severityRank(alert.severity) >= severityRank(this.minimumSeverity)
    ));
    if (!alerts.length) {
      return;
    }

    const response = await this.fetcher(this.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        text: slackSummaryText(report, alerts),
        blocks: slackBlocks(report, alerts),
      }),
    });

    if (!response.ok) {
      this.observability.incrementCounter('conversation_intelligence.model_validation.alert_delivery.failures', 1, {
        channel: 'slack',
        severity: highestSeverity(alerts),
      });
      throw new Error(`Slack validation alert webhook returned ${response.status} ${response.statusText}.`);
    }

    this.observability.incrementCounter('conversation_intelligence.model_validation.alert_delivery.success', 1, {
      channel: 'slack',
      severity: highestSeverity(alerts),
    });
  }
}

function highestSeverity(alerts: ModelValidationAlert[]): ModelValidationAlertSeverity {
  return alerts.reduce<ModelValidationAlertSeverity>((current, alert) => {
    return severityRank(alert.severity) > severityRank(current) ? alert.severity : current;
  }, 'INFO');
}

function slackSummaryText(report: ModelValidationReport, alerts: ModelValidationAlert[]): string {
  return [
    `[${highestSeverity(alerts)}] conversation intelligence validation alerts`,
    `tenant=${report.tenantId}`,
    `useCase=${report.useCase}`,
    `pack=${report.packVersion ?? '_all'}`,
    `alerts=${alerts.map((alert) => alert.kind).join(',')}`,
  ].join(' | ');
}

function slackBlocks(report: ModelValidationReport, alerts: ModelValidationAlert[]) {
  const header = `*Conversation Intelligence Validation Alerts*\nTenant: \`${report.tenantId}\`\nUse case: \`${report.useCase}\`\nPack: \`${report.packVersion ?? '_all'}\``;
  const metricSummary = [
    `Failure rate: ${report.liveMetrics.failureRate}`,
    `Review rate: ${report.liveMetrics.reviewRate}`,
    `Uncertain rate: ${report.liveMetrics.uncertainRate}`,
    `Schema-valid rate: ${report.liveMetrics.schemaValidRate ?? 'n/a'}`,
    `P95 latency: ${report.liveMetrics.p95ProcessingDurationMs ?? 'n/a'}ms`,
  ].join('\n');

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: header,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: metricSummary,
      },
    },
    ...alerts.map((alert) => ({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${alert.severity}* \`${alert.kind}\`\n${alert.message}`,
      },
    })),
  ];
}
