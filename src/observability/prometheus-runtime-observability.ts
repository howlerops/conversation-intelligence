import {
  ObservabilityAttributes,
  ObservabilityValue,
  RuntimeObservability,
  RuntimeSpan,
} from './runtime-observability';

export interface MetricsEndpointProvider {
  contentType: string;
  renderMetrics(): string;
}

type MetricSeries = {
  name: string;
  labels: Record<string, string>;
};

type CounterPoint = MetricSeries & {
  value: number;
};

type HistogramPoint = MetricSeries & {
  count: number;
  sum: number;
};

function sanitizeMetricName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_:]/g, '_').replace(/_+/g, '_');
}

function sanitizeLabelName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_');
}

function normalizeLabelValue(value: ObservabilityValue): string {
  return String(value);
}

function normalizeLabels(attributes: ObservabilityAttributes = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(attributes)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [sanitizeLabelName(name), normalizeLabelValue(value as ObservabilityValue)]),
  );
}

function seriesKey(name: string, labels: Record<string, string>): string {
  return `${name}|${JSON.stringify(labels)}`;
}

function renderLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (!entries.length) {
    return '';
  }

  const rendered = entries
    .map(([name, value]) => `${name}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(',');
  return `{${rendered}}`;
}

export class PrometheusRuntimeObservability implements RuntimeObservability, MetricsEndpointProvider {
  readonly contentType = 'text/plain; version=0.0.4; charset=utf-8';

  private readonly counters = new Map<string, CounterPoint>();
  private readonly histograms = new Map<string, HistogramPoint>();
  private readonly gauges = new Map<string, CounterPoint>();

  incrementCounter(name: string, value = 1, attributes: ObservabilityAttributes = {}): void {
    const metricName = this.counterMetricName(name);
    const labels = normalizeLabels(attributes);
    const key = seriesKey(metricName, labels);
    const point = this.counters.get(key) ?? {
      name: metricName,
      labels,
      value: 0,
    };

    point.value += value;
    this.counters.set(key, point);
  }

  recordHistogram(name: string, value: number, attributes: ObservabilityAttributes = {}): void {
    const metricName = sanitizeMetricName(name);
    const labels = normalizeLabels(attributes);
    const key = seriesKey(metricName, labels);
    const point = this.histograms.get(key) ?? {
      name: metricName,
      labels,
      count: 0,
      sum: 0,
    };

    point.count += 1;
    point.sum += value;
    this.histograms.set(key, point);
  }

  recordGauge(name: string, value: number, attributes: ObservabilityAttributes = {}): void {
    const metricName = sanitizeMetricName(name);
    const labels = normalizeLabels(attributes);
    const key = seriesKey(metricName, labels);
    this.gauges.set(key, {
      name: metricName,
      labels,
      value,
    });
  }

  startSpan(name: string, attributes: ObservabilityAttributes = {}): RuntimeSpan {
    const startedAt = Date.now();
    let outcome: 'ok' | 'error' = 'ok';

    return {
      addEvent(): void {},
      setAttribute(): void {},
      fail(): void {
        outcome = 'error';
      },
      end: (_outcome = 'ok', endAttributes: ObservabilityAttributes = {}): void => {
        const finalOutcome = outcome === 'error' ? 'error' : _outcome;
        const spanAttributes: ObservabilityAttributes = {
          ...attributes,
          ...endAttributes,
          span: name,
          outcome: finalOutcome,
        };

        this.incrementCounter('conversation_intelligence.spans', 1, spanAttributes);
        this.recordHistogram('conversation_intelligence.span.duration_ms', Date.now() - startedAt, spanAttributes);
      },
    };
  }

  renderMetrics(): string {
    const lines: string[] = [];

    const counterMetrics = Array.from(this.counters.values()).sort((left, right) => {
      const byName = left.name.localeCompare(right.name);
      return byName !== 0 ? byName : JSON.stringify(left.labels).localeCompare(JSON.stringify(right.labels));
    });
    const histogramMetrics = Array.from(this.histograms.values()).sort((left, right) => {
      const byName = left.name.localeCompare(right.name);
      return byName !== 0 ? byName : JSON.stringify(left.labels).localeCompare(JSON.stringify(right.labels));
    });
    const gaugeMetrics = Array.from(this.gauges.values()).sort((left, right) => {
      const byName = left.name.localeCompare(right.name);
      return byName !== 0 ? byName : JSON.stringify(left.labels).localeCompare(JSON.stringify(right.labels));
    });

    const emittedCounterTypes = new Set<string>();
    for (const point of counterMetrics) {
      if (!emittedCounterTypes.has(point.name)) {
        lines.push(`# TYPE ${point.name} counter`);
        emittedCounterTypes.add(point.name);
      }
      lines.push(`${point.name}${renderLabels(point.labels)} ${point.value}`);
    }

    const emittedHistogramTypes = new Set<string>();
    for (const point of histogramMetrics) {
      if (!emittedHistogramTypes.has(point.name)) {
        lines.push(`# TYPE ${point.name} histogram`);
        emittedHistogramTypes.add(point.name);
      }

      lines.push(`${point.name}_bucket${renderLabels({ ...point.labels, le: '+Inf' })} ${point.count}`);
      lines.push(`${point.name}_sum${renderLabels(point.labels)} ${point.sum}`);
      lines.push(`${point.name}_count${renderLabels(point.labels)} ${point.count}`);
    }

    const emittedGaugeTypes = new Set<string>();
    for (const point of gaugeMetrics) {
      if (!emittedGaugeTypes.has(point.name)) {
        lines.push(`# TYPE ${point.name} gauge`);
        emittedGaugeTypes.add(point.name);
      }
      lines.push(`${point.name}${renderLabels(point.labels)} ${point.value}`);
    }

    return `${lines.join('\n')}\n`;
  }

  private counterMetricName(name: string): string {
    const sanitized = sanitizeMetricName(name);
    return sanitized.endsWith('_total') ? sanitized : `${sanitized}_total`;
  }
}
