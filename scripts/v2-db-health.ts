import { config as loadEnv } from 'dotenv';
import { runV2DatabasePreflight } from '../app/lib/services/v2/databasePreflight.server';

// Load local env files for direct script execution.
loadEnv({ path: '.env' });
loadEnv({ path: '.env.local' });

async function main() {
  const enabled = process.env.V2_MASTRA_ENABLED === 'true';

  if (!enabled) {
    console.warn('[v2:db:health] V2_MASTRA_ENABLED is not true. Continuing probe anyway.');
  }

  const result = await runV2DatabasePreflight();
  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    process.exitCode = 1;
  }
}

void main();
