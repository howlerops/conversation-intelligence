import { createStandaloneConversationIntelligenceRuntimeFromEnv } from '../src';

function parseArgs(argv: string[]) {
  const input: {
    tenantId?: string;
    useCase?: string;
    force?: boolean;
    includeTranscript?: boolean;
    requireAnalystSentiment?: boolean;
  } = {
    includeTranscript: true,
  };

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
      case '--force':
        input.force = true;
        break;
      case '--no-transcript':
        input.includeTranscript = false;
        break;
      case '--require-analyst-sentiment':
        input.requireAnalystSentiment = true;
        break;
    }
  }

  return input;
}

async function main(): Promise<void> {
  const runtime = await createStandaloneConversationIntelligenceRuntimeFromEnv();

  try {
    if (!runtime.reviewedExports) {
      throw new Error('Reviewed export refresh is disabled. Set CI_REVIEWED_EXPORT_ENABLED=true.');
    }

    const result = await runtime.reviewedExports.refreshConfiguredExports(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await runtime.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
