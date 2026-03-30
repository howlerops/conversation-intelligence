import { resolve } from 'path';
import { comparePublicAndShadowValidation } from '../src';

function parseArgs(argv: string[]): {
  publicPath: string;
  shadowPath: string;
} {
  const input = {
    publicPath: resolve(process.cwd(), 'eval-data', 'public'),
    shadowPath: resolve(process.cwd(), 'fixtures', 'sentiment-reviewed-outcomes.support.json'),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    switch (value) {
      case '--public-path':
        input.publicPath = resolve(process.cwd(), argv[index + 1]);
        index += 1;
        break;
      case '--shadow-path':
        input.shadowPath = resolve(process.cwd(), argv[index + 1]);
        index += 1;
        break;
    }
  }

  return input;
}

async function main(): Promise<void> {
  const result = await comparePublicAndShadowValidation(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
