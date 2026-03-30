import { readFile } from 'fs/promises';
import { resolve } from 'path';
import {
  buildPublicDataPipelineSuite,
  writePublicDataPipelineArtifacts,
} from '../src';

async function main(): Promise<void> {
  const manifestPath = process.argv[2]
    ? resolve(process.cwd(), process.argv[2])
    : resolve(process.cwd(), 'fixtures', 'public-data', 'pipeline-suite.json');
  const outputDir = process.argv[3]
    ? resolve(process.cwd(), process.argv[3])
    : resolve(process.cwd(), 'eval-data', 'public');
  const raw = await readFile(manifestPath, 'utf8');
  const suite = buildPublicDataPipelineSuite(JSON.parse(raw));
  const artifacts = await writePublicDataPipelineArtifacts(outputDir, suite);

  console.log(JSON.stringify({
    manifestPath,
    outputDir,
    summary: suite.summary,
    artifacts,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
