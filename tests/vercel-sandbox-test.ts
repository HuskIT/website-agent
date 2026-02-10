/**
 * Vercel Sandbox Connection Test
 * Feature: 001-sandbox-providers
 *
 * This script tests the Vercel Sandbox connection in isolation
 * to verify authentication and basic functionality.
 *
 * Run: npx tsx tests/vercel-sandbox-test.ts
 */

import { config } from 'dotenv';
import { Sandbox } from '@vercel/sandbox';

// Load .env.local file
config({ path: '.env.local' });

// Load environment variables
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID;
const VERCEL_TEAM_SLUG = process.env.VERCEL_TEAM_SLUG;

console.log('=== Vercel Sandbox Connection Test ===\n');

// Validate environment
if (!VERCEL_TOKEN) {
  console.error('❌ VERCEL_TOKEN is not set');
  process.exit(1);
}

if (!VERCEL_TEAM_ID) {
  console.error('❌ VERCEL_TEAM_ID is not set');
  process.exit(1);
}

if (!VERCEL_PROJECT_ID) {
  console.error('❌ VERCEL_PROJECT_ID is not set');
  process.exit(1);
}

console.log('Environment variables:');
console.log(`  VERCEL_TOKEN: ${VERCEL_TOKEN.substring(0, 10)}...`);
console.log(`  VERCEL_TEAM_ID: ${VERCEL_TEAM_ID}`);
console.log(`  VERCEL_PROJECT_ID: ${VERCEL_PROJECT_ID}`);
console.log(`  VERCEL_TEAM_SLUG: ${VERCEL_TEAM_SLUG || 'not set'}`);
console.log();

async function testSandboxConnection() {
  let sandbox: Sandbox | null = null;

  try {
    console.log('Test 1: Creating sandbox with explicit credentials...');

    // According to docs, we pass credentials directly to Sandbox.create()
    // The SDK reads VERCEL_OIDC_TOKEN from env by default, but we can override
    // by passing token, teamId, and projectId explicitly
    sandbox = await Sandbox.create({
      runtime: 'node22',
      timeout: 5 * 60 * 1000, // 5 minutes
      ports: [3000],
      // Explicit credentials for external/non-Vercel environments
      token: VERCEL_TOKEN,
      teamId: VERCEL_TEAM_ID,
      projectId: VERCEL_PROJECT_ID,
    } as any); // Using 'as any' because SDK types may vary

    console.log(`✅ Sandbox created successfully!`);
    console.log(`   Sandbox ID: ${sandbox.sandboxId}`);
    console.log(`   Status: ${sandbox.status}`);
    console.log(`   Created at: ${sandbox.createdAt}`);
    console.log();

    console.log('Test 2: Running a simple command...');
    const result = await sandbox.runCommand('node', ['--version']);
    console.log(`✅ Command executed!`);
    console.log(`   Exit code: ${result.exitCode}`);
    const stdout = await result.stdout();
    console.log(`   Output: ${stdout.trim()}`);
    console.log();

    console.log('Test 3: Writing a file...');
    await sandbox.writeFiles([
      { path: 'test.txt', content: Buffer.from('Hello from Vercel Sandbox!') },
    ]);
    console.log('✅ File written successfully');
    console.log();

    console.log('Test 4: Reading the file...');
    const content = await sandbox.readFileToBuffer({ path: 'test.txt' });
    if (content) {
      console.log(`✅ File read successfully: ${content.toString()}`);
    }
    console.log();

    console.log('Test 5: Getting preview URL...');
    try {
      const url = sandbox.domain(3000);
      console.log(`✅ Preview URL: ${url}`);
    } catch (e: any) {
      console.log(`⚠️  No preview URL for port 3000 (expected if not exposed yet)`);
    }
    console.log();

    console.log('=== All tests passed! ===');

  } catch (error: any) {
    console.error('❌ Test failed:', error.message);
    if (error.response) {
      console.error('   Response:', error.response.body);
      console.error('   Status:', error.response.statusCode);
    }
    process.exit(1);
  } finally {
    if (sandbox) {
      console.log('\nCleaning up: Stopping sandbox...');
      await sandbox.stop();
      console.log('✅ Sandbox stopped');
    }
  }
}

// Run the test
testSandboxConnection();
