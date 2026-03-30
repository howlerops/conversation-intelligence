import {
  recommendSentimentScoringConfigFromDataset,
} from '../src';

async function main(): Promise<void> {
  const datasetPath = process.argv[2];
  const minimumSampleSize = process.argv[3] ? Number(process.argv[3]) : undefined;
  const minimumSampleSizePerEngagementType = process.argv[4] ? Number(process.argv[4]) : undefined;

  const recommendation = await recommendSentimentScoringConfigFromDataset(datasetPath, {
    minimumSampleSize,
    minimumSampleSizePerEngagementType,
  });

  console.log(JSON.stringify({
    datasetPath: datasetPath ?? 'fixtures/sentiment-reviewed-outcomes.support.json',
    recommendation,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
