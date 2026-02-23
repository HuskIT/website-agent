import { config as loadEnv } from 'dotenv';
import { runE2BHealthProbe } from '../app/lib/mastra/sandbox/e2bHealthProbe.server';

// Load local env files for direct script execution.
loadEnv({ path: '.env' });
loadEnv({ path: '.env.local' });

async function main() {
  const enabled = process.env.V2_MASTRA_ENABLED === 'true';

  if (!enabled) {
    console.warn('[v2:sandbox:health] V2_MASTRA_ENABLED is not true. Continuing probe anyway.');
  }

  const result = await runE2BHealthProbe();
  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    process.exitCode = 1;
  }
}

void main();

