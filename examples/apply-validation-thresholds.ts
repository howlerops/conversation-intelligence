import { createStandaloneConversationIntelligenceRuntimeFromEnv } from '../src';

function parseArgs(argv: string[]) {
  const input: {
    tenantId?: string;
    useCase?: string;
    packVersion?: string;
    force?: boolean;
    enableValidationMonitoring?: boolean;
    nightlyIntervalMinutes?: number;
    evaluationWindowHours?: number;
    minimumRunCount?: number;
    minimumReviewedSampleSize?: number;
    minimumRunCountPerEngagementType?: number;
    minimumReviewedSampleSizePerEngagementType?: number;
    minimumRunCountPerQueue?: number;
    minimumReviewedSampleSizePerQueue?: number;
    minimumRunCountPerTranscriptLengthBucket?: number;
    minimumReviewedSampleSizePerTranscriptLengthBucket?: number;
    autoApply?: boolean;
  } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    switch (value) {
      case '--tenant':
        input.tenantId = argv[index + 1];
        index += 1;
        break;
      case '--use-case':
        input.useCase = argv[index + 1];
        index += 1;
        break;
      case '--pack-version':
        input.packVersion = argv[index + 1];
        index += 1;
        break;
      case '--force':
        input.force = true;
        break;
      case '--disable-validation-monitoring':
        input.enableValidationMonitoring = false;
        break;
      case '--nightly-interval-minutes':
        input.nightlyIntervalMinutes = Number(argv[index + 1]);
        index += 1;
        break;
      case '--evaluation-window-hours':
        input.evaluationWindowHours = Number(argv[index + 1]);
        index += 1;
        break;
      case '--minimum-run-count':
        input.minimumRunCount = Number(argv[index + 1]);
        index += 1;
        break;
      case '--minimum-reviewed-sample-size':
        input.minimumReviewedSampleSize = Number(argv[index + 1]);
        index += 1;
        break;
      case '--minimum-run-count-per-engagement':
        input.minimumRunCountPerEngagementType = Number(argv[index + 1]);
        index += 1;
        break;
      case '--minimum-reviewed-sample-size-per-engagement':
        input.minimumReviewedSampleSizePerEngagementType = Number(argv[index + 1]);
        index += 1;
        break;
      case '--minimum-run-count-per-queue':
        input.minimumRunCountPerQueue = Number(argv[index + 1]);
        index += 1;
        break;
      case '--minimum-reviewed-sample-size-per-queue':
        input.minimumReviewedSampleSizePerQueue = Number(argv[index + 1]);
        index += 1;
        break;
      case '--minimum-run-count-per-transcript-length':
        input.minimumRunCountPerTranscriptLengthBucket = Number(argv[index + 1]);
        index += 1;
        break;
      case '--minimum-reviewed-sample-size-per-transcript-length':
        input.minimumReviewedSampleSizePerTranscriptLengthBucket = Number(argv[index + 1]);
        index += 1;
        break;
      case '--auto-apply':
        input.autoApply = true;
        break;
    }
  }

  return input;
}

async function main(): Promise<void> {
  const runtime = await createStandaloneConversationIntelligenceRuntimeFromEnv();

  try {
    const result = await runtime.modelValidation.applyRecommendedThresholds(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await runtime.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
