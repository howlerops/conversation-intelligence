import { analyzeConversation } from '../pipeline/analyze-conversation';
import { StubCanonicalAnalysisEngine } from '../rlm/engine';
import { supportFixtureEvalCases } from './support-fixture-cases';

export interface FixtureEvalResult {
  name: string;
  passed: boolean;
  messages: string[];
}

export async function runSupportFixtureEvals(): Promise<FixtureEvalResult[]> {
  const results: FixtureEvalResult[] = [];

  for (const testCase of supportFixtureEvalCases) {
    const engine = new StubCanonicalAnalysisEngine(testCase.extraction);
    const analysis = await analyzeConversation(testCase.transcript, testCase.tenantPack, {
      engine,
      now: new Date('2026-03-28T00:00:00.000Z'),
    });

    const messages: string[] = [];

    if (analysis.review.state !== testCase.expected.reviewState) {
      messages.push(`expected review=${testCase.expected.reviewState} actual=${analysis.review.state}`);
    }

    if (testCase.expected.tenantLabels) {
      const actualLabels = analysis.tenantMappedEvents.map((event) => event.tenantLabel);
      for (const label of testCase.expected.tenantLabels) {
        if (!actualLabels.includes(label)) {
          messages.push(`missing tenant label ${label}`);
        }
      }
    }

    if (testCase.expected.reviewReasonIncludes) {
      const reasonText = analysis.review.reasons.join(' | ');
      for (const needle of testCase.expected.reviewReasonIncludes) {
        if (!reasonText.includes(needle)) {
          messages.push(`missing review reason fragment ${needle}`);
        }
      }
    }

    results.push({
      name: testCase.name,
      passed: messages.length === 0,
      messages,
    });
  }

  return results;
}
