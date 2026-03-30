import {
  runReviewedSentimentValidation,
  summarizeReviewedSentimentValidation,
} from '../src';

async function main(): Promise<void> {
  const datasetPath = process.argv[2];
  const calibrationConfigPath = process.argv[3];
  const results = await runReviewedSentimentValidation(datasetPath, calibrationConfigPath);
  const summary = summarizeReviewedSentimentValidation(results);

  console.log(JSON.stringify({
    datasetPath: datasetPath ?? 'fixtures/sentiment-reviewed-outcomes.support.json',
    calibrationConfigPath: calibrationConfigPath ?? null,
    summary,
    failures: results.filter((result) => result.deltaScore100 > 5 || result.deltaScore5 > 0),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
