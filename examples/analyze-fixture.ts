import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  analyzeConversation,
  RlmCanonicalAnalysisEngine,
  resolveProviderProfileFromEnv,
  TranscriptInputDraft,
  TenantPackDraft,
} from '../src';

function loadJson<T>(relativePath: string): T {
  const absolutePath = resolve(__dirname, '..', relativePath);
  return JSON.parse(readFileSync(absolutePath, 'utf8')) as T;
}

async function main(): Promise<void> {
  const transcript = loadJson<TranscriptInputDraft>('fixtures/transcript.support.basic.json');
  const tenantPack = loadJson<TenantPackDraft>('fixtures/tenant-pack.support.acme.json');
  const providerProfile = resolveProviderProfileFromEnv(process.env);

  const engine = new RlmCanonicalAnalysisEngine(providerProfile);

  const result = await analyzeConversation(transcript, tenantPack, {
    engine,
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
