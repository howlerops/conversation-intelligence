import { mkdir, readFile, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import {
  buildReviewedBenchmarkDataset,
  writeReviewedBenchmarkDataset,
} from '../src';

interface CliArgs {
  outputDir: string;
  manifests: string[];
  annotationManifests: string[];
  packVersion?: string;
  promptVersion?: string;
  classification: 'INTERNAL' | 'RESTRICTED';
}

const defaultManifestPaths = [
  'fixtures/public-data/pipeline-suite.json',
  'fixtures/public-data/pipeline-suite.support-doc2dial.json',
  'fixtures/public-data/pipeline-suite.support-callcenteren.research.json',
];

function parseArgs(argv: string[]): CliArgs {
  if (argv.length < 1) {
    throw new Error('Usage: tsx examples/build-reviewed-benchmark-dataset.ts <output-dir> [--manifest PATH]... [--annotation-manifest PATH]... [--pack-version VERSION] [--prompt-version VERSION] [--classification INTERNAL|RESTRICTED]');
  }

  const args: CliArgs = {
    outputDir: argv[0],
    manifests: [],
    annotationManifests: [],
    classification: 'INTERNAL',
  };

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case '--manifest':
        args.manifests.push(argv[index + 1] ?? '');
        index += 1;
        break;
      case '--annotation-manifest':
        args.annotationManifests.push(argv[index + 1] ?? '');
        index += 1;
        break;
      case '--pack-version':
        args.packVersion = argv[index + 1];
        index += 1;
        break;
      case '--prompt-version':
        args.promptVersion = argv[index + 1];
        index += 1;
        break;
      case '--classification': {
        const value = (argv[index + 1] ?? '').toUpperCase();
        if (value !== 'INTERNAL' && value !== 'RESTRICTED') {
          throw new Error(`Invalid classification: ${argv[index + 1]}`);
        }
        args.classification = value;
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const inputPaths = dedupePaths([
    ...(args.manifests.length > 0 ? args.manifests : defaultManifestPaths),
    ...args.annotationManifests,
  ]).map((path) => resolve(path));

  const inputs = await Promise.all(inputPaths.map(async (path) => ({
    path,
    content: JSON.parse(await readFile(path, 'utf8')),
  })));

  const dataset = buildReviewedBenchmarkDataset(inputs, {
    packVersion: args.packVersion,
    promptVersion: args.promptVersion,
    classification: args.classification,
  });
  const artifacts = await writeReviewedBenchmarkDataset(resolve(args.outputDir), dataset);
  const metadataPath = join(artifacts.outputRootDir, 'build-reviewed-benchmark-dataset.json');

  await mkdir(artifacts.outputRootDir, { recursive: true });
  await writeFile(metadataPath, JSON.stringify({
    outputRootDir: artifacts.outputRootDir,
    inputPaths,
    summaryPath: artifacts.summaryPath,
    annotationBatchPath: artifacts.annotationBatchPath,
    scopeArtifacts: artifacts.scopeArtifacts,
    summary: dataset.summary,
  }, null, 2));

  console.log(JSON.stringify({
    outputRootDir: artifacts.outputRootDir,
    summaryPath: artifacts.summaryPath,
    annotationBatchPath: artifacts.annotationBatchPath,
    scopeArtifacts: artifacts.scopeArtifacts,
    metadataPath,
    summary: dataset.summary,
  }, null, 2));
}

function dedupePaths(paths: string[]): string[] {
  return Array.from(new Set(paths.filter((path) => path.length > 0)));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
