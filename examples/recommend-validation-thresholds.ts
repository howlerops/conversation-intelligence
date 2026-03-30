import { createStandaloneConversationIntelligenceRuntimeFromEnv } from '../src';

function parseArgs(argv: string[]): {
  tenantId?: string;
  useCase?: string;
  packVersion?: string;
} {
  const input: {
    tenantId?: string;
    useCase?: string;
    packVersion?: string;
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
    }
  }

  return input;
}

async function main(): Promise<void> {
  const runtime = await createStandaloneConversationIntelligenceRuntimeFromEnv();

  try {
    const result = await runtime.modelValidation.recommendThresholds(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await runtime.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
