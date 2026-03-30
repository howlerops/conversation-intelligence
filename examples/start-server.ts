import {
  createStandaloneConversationIntelligenceRuntimeFromEnv,
} from '../src';

async function main(): Promise<void> {
  const runtime = await createStandaloneConversationIntelligenceRuntimeFromEnv(process.env, process.cwd());
  const server = await runtime.startServer();
  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Standalone server did not bind to a TCP port.');
  }

  console.log(`conversation-intelligence listening on http://localhost:${address.port}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
