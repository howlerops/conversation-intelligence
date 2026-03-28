import { describe, expect, it } from 'vitest';
import { runSupportFixtureEvals } from '../src';

describe('support fixture evals', () => {
  it('all configured fixture evals pass', async () => {
    const results = await runSupportFixtureEvals();
    const failed = results.filter((result) => !result.passed);

    expect(failed).toEqual([]);
  });
});
