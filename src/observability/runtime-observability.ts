export type ObservabilityValue = string | number | boolean;
export type ObservabilityAttributes = Record<string, ObservabilityValue | undefined>;

export interface RecordedMetric {
  kind: 'counter' | 'histogram' | 'gauge';
  name: string;
  value: number;
  attributes: ObservabilityAttributes;
}

export interface RecordedSpan {
  name: string;
  attributes: ObservabilityAttributes;
  events: Array<{
    name: string;
    attributes: ObservabilityAttributes;
  }>;
  ended: boolean;
  outcome?: 'ok' | 'error';
  errorMessage?: string;
}

export interface RuntimeSpan {
  addEvent(name: string, attributes?: ObservabilityAttributes): void;
  setAttribute(name: string, value: ObservabilityValue): void;
  fail(error: unknown): void;
  end(outcome?: 'ok' | 'error', attributes?: ObservabilityAttributes): void;
}

export interface RuntimeObservability {
  incrementCounter(name: string, value?: number, attributes?: ObservabilityAttributes): void;
  recordHistogram(name: string, value: number, attributes?: ObservabilityAttributes): void;
  recordGauge(name: string, value: number, attributes?: ObservabilityAttributes): void;
  startSpan(name: string, attributes?: ObservabilityAttributes): RuntimeSpan;
}

function cleanAttributes(attributes: ObservabilityAttributes = {}): ObservabilityAttributes {
  return Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value !== undefined),
  );
}

class NoopRuntimeSpan implements RuntimeSpan {
  addEvent(): void {}
  setAttribute(): void {}
  fail(): void {}
  end(): void {}
}

export const noopRuntimeObservability: RuntimeObservability = {
  incrementCounter(): void {},
  recordHistogram(): void {},
  recordGauge(): void {},
  startSpan(): RuntimeSpan {
    return new NoopRuntimeSpan();
  },
};

export class InMemoryRuntimeObservability implements RuntimeObservability {
  readonly metrics: RecordedMetric[] = [];
  readonly spans: RecordedSpan[] = [];

  incrementCounter(name: string, value = 1, attributes: ObservabilityAttributes = {}): void {
    this.metrics.push({
      kind: 'counter',
      name,
      value,
      attributes: cleanAttributes(attributes),
    });
  }

  recordHistogram(name: string, value: number, attributes: ObservabilityAttributes = {}): void {
    this.metrics.push({
      kind: 'histogram',
      name,
      value,
      attributes: cleanAttributes(attributes),
    });
  }

  recordGauge(name: string, value: number, attributes: ObservabilityAttributes = {}): void {
    this.metrics.push({
      kind: 'gauge',
      name,
      value,
      attributes: cleanAttributes(attributes),
    });
  }

  startSpan(name: string, attributes: ObservabilityAttributes = {}): RuntimeSpan {
    const span: RecordedSpan = {
      name,
      attributes: cleanAttributes(attributes),
      events: [],
      ended: false,
    };

    this.spans.push(span);

    return {
      addEvent(eventName: string, eventAttributes: ObservabilityAttributes = {}): void {
        span.events.push({
          name: eventName,
          attributes: cleanAttributes(eventAttributes),
        });
      },
      setAttribute(attributeName: string, value: ObservabilityValue): void {
        span.attributes[attributeName] = value;
      },
      fail(error: unknown): void {
        span.outcome = 'error';
        span.errorMessage = error instanceof Error ? error.message : String(error);
      },
      end(outcome = 'ok', endAttributes: ObservabilityAttributes = {}): void {
        span.ended = true;
        span.outcome = span.outcome ?? outcome;
        Object.assign(span.attributes, cleanAttributes(endAttributes));
      },
    };
  }
}
