import { describe, expect, it, vi } from 'vitest';
import {
  SlackValidationAlertNotifier,
  WebhookValidationAlertNotifier,
  modelValidationReportSchema,
} from '../src';

function buildReport() {
  return modelValidationReportSchema.parse({
    reportId: 'report_1',
    tenantId: 'tenant_support_acme',
    useCase: 'support',
    packVersion: 'support-v2',
    generatedAt: '2026-03-28T12:00:00.000Z',
    windowStartedAt: '2026-03-27T12:00:00.000Z',
    windowEndedAt: '2026-03-28T12:00:00.000Z',
    thresholds: {
      minimumReviewedSampleSize: 1,
      maximumFailureRate: 0.1,
      maximumReviewRate: 0.2,
      maximumUncertainRate: 0.2,
      minimumSchemaValidRate: 0.9,
      maximumAverageDeltaScore100: 5,
      maximumAverageDeltaScore5: 0.5,
      minimumExactScore5MatchRate: 0.8,
      minimumWithinFivePointsRate: 0.95,
      maximumAverageProcessingDurationMs: 5000,
      maximumP95ProcessingDurationMs: 9000,
    },
    liveMetrics: {
      runCount: 2,
      completedRuns: 1,
      failedRuns: 1,
      reviewCount: 0,
      uncertainCount: 0,
      scoredRuns: 1,
      schemaValidatedRuns: 2,
      schemaValidRuns: 1,
      schemaInvalidRuns: 1,
      failureRate: 0.5,
      reviewRate: 0,
      uncertainRate: 0,
      schemaValidRate: 0.5,
      averageScore100: 42,
      averageProcessingDurationMs: 8000,
      p95ProcessingDurationMs: 12000,
    },
    alerts: [
      {
        alertId: 'alert_info',
        reportId: 'report_1',
        tenantId: 'tenant_support_acme',
        useCase: 'support',
        packVersion: 'support-v2',
        createdAt: '2026-03-28T12:00:00.000Z',
        kind: 'REVIEWED_SAMPLE_SIZE_LOW',
        severity: 'INFO',
        message: 'informational',
        metadata: {},
      },
      {
        alertId: 'alert_warning',
        reportId: 'report_1',
        tenantId: 'tenant_support_acme',
        useCase: 'support',
        packVersion: 'support-v2',
        createdAt: '2026-03-28T12:00:00.000Z',
        kind: 'LATENCY_HIGH',
        severity: 'WARNING',
        message: 'latency high',
        metadata: {},
      },
    ],
  });
}

describe('model validation alert notifiers', () => {
  it('posts filtered validation alerts to configured webhooks', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
    }));

    const notifier = new WebhookValidationAlertNotifier({
      webhookUrls: ['http://example.test/alerts'],
      minimumSeverity: 'WARNING',
      fetcher: fetcher as unknown as typeof fetch,
    });

    const report = buildReport();

    await notifier.notify(report);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const call = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const payload = JSON.parse(String(call[1]?.body));
    expect(payload.alerts).toHaveLength(1);
    expect(payload.alerts[0].kind).toBe('LATENCY_HIGH');
  });

  it('formats Slack payloads for warning and critical alerts', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
    }));

    const notifier = new SlackValidationAlertNotifier({
      webhookUrl: 'http://example.test/slack',
      minimumSeverity: 'WARNING',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await notifier.notify(buildReport());

    const call = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const payload = JSON.parse(String(call[1]?.body));
    expect(payload.text).toContain('conversation intelligence validation alerts');
    expect(payload.blocks[2].text.text).toContain('LATENCY_HIGH');
  });
});
