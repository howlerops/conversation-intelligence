import { runSupportFixtureEvals } from '../src';

async function main(): Promise<void> {
  const results = await runSupportFixtureEvals();
  const failed = results.filter((result) => !result.passed);

  for (const result of results) {
    const prefix = result.passed ? 'PASS' : 'FAIL';
    console.log(`${prefix} ${result.name}`);

    for (const message of result.messages) {
      console.log(`  - ${message}`);
    }
  }

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
