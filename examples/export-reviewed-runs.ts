import { writeFile } from 'fs/promises';
import {
  ReviewedRunExportRequest,
  createStandaloneConversationIntelligenceRuntimeFromEnv,
} from '../src';

function parseArgs(argv: string[]): { request: ReviewedRunExportRequest; outputPath?: string } {
  const request: ReviewedRunExportRequest = {};
  let outputPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    switch (value) {
      case '--tenant':
        request.tenantId = argv[index + 1];
        index += 1;
        break;
      case '--use-case':
        request.useCase = argv[index + 1];
        index += 1;
        break;
      case '--pack-version':
        request.packVersion = argv[index + 1];
        index += 1;
        break;
      case '--since':
        request.since = argv[index + 1];
        index += 1;
        break;
      case '--until':
        request.until = argv[index + 1];
        index += 1;
        break;
      case '--no-transcript':
        request.includeTranscript = false;
        break;
      case '--require-analyst-sentiment':
        request.requireAnalystSentiment = true;
        break;
      case '--out':
        outputPath = argv[index + 1];
        index += 1;
        break;
    }
  }

  return { request, outputPath };
}

async function main(): Promise<void> {
  const { request, outputPath } = parseArgs(process.argv.slice(2));
  const runtime = await createStandaloneConversationIntelligenceRuntimeFromEnv();

  try {
    const result = await runtime.modelValidation.exportReviewedRuns(request);
    if (outputPath) {
      await writeFile(outputPath, result.ndjson, 'utf8');
    } else {
      process.stdout.write(`${result.ndjson}\n`);
    }

    console.error(JSON.stringify(result.response, null, 2));
  } finally {
    await runtime.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
