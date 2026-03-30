import { describe, expect, it } from 'vitest';
import { PrometheusRuntimeObservability } from '../src';

describe('PrometheusRuntimeObservability', () => {
  it('aggregates counters, histograms, and span metrics in Prometheus text format', () => {
    const observability = new PrometheusRuntimeObservability();

    observability.incrementCounter('conversation_intelligence.jobs.completed', 1, {
      tenant_id: 'tenant_a',
      use_case: 'support',
    });
    observability.recordHistogram('conversation_intelligence.jobs.processing.duration_ms', 25, {
      tenant_id: 'tenant_a',
    });
    observability.recordGauge('conversation_intelligence.model_validation.failure_rate', 0.12, {
      tenant_id: 'tenant_a',
      use_case: 'support',
    });

    const span = observability.startSpan('test_span', {
      tenant_id: 'tenant_a',
    });
    span.end('ok', {
      engine: 'rules',
    });

    const metrics = observability.renderMetrics();
    expect(metrics).toContain('# TYPE conversation_intelligence_jobs_completed_total counter');
    expect(metrics).toContain('tenant_id="tenant_a"');
    expect(metrics).toContain('# TYPE conversation_intelligence_jobs_processing_duration_ms histogram');
    expect(metrics).toContain('# TYPE conversation_intelligence_model_validation_failure_rate gauge');
    expect(metrics).toContain('conversation_intelligence_model_validation_failure_rate{tenant_id="tenant_a",use_case="support"} 0.12');
    expect(metrics).toContain('conversation_intelligence_span_duration_ms_bucket');
    expect(metrics).toContain('conversation_intelligence_spans_total');
  });
});
