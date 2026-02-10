/**
 * Experimental test script to determine the best method for capturing
 * browser console errors from Vercel Sandbox previews.
 *
 * This script:
 * 1. Creates a Vercel Sandbox
 * 2. Writes HTML with intentional JavaScript errors
 * 3. Tests multiple capture methods
 * 4. Reports which methods successfully detect the errors
 *
 * Run: npx tsx scripts/test-error-capture.ts
 */

import { Sandbox } from '@vercel/sandbox';

const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID;

if (!VERCEL_TOKEN || !VERCEL_TEAM_ID || !VERCEL_PROJECT_ID) {
  console.error('Missing required environment variables:');
  console.error('  VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID');
  process.exit(1);
}

// Test cases: different types of JavaScript errors
const TEST_CASES = [
  {
    name: 'ReferenceError - Undefined Variable',
    html: `
<!DOCTYPE html>
<html>
<head><title>Test: ReferenceError</title></head>
<body>
  <h1>Testing ReferenceError</h1>
  <script>
    // This will throw: ReferenceError: Clock is not defined
    console.log(Clock);
  </script>
</body>
</html>
    `.trim(),
  },
  {
    name: 'TypeError - Cannot Read Property',
    html: `
<!DOCTYPE html>
<html>
<head><title>Test: TypeError</title></head>
<body>
  <h1>Testing TypeError</h1>
  <script>
    // This will throw: TypeError: Cannot read property 'foo' of undefined
    const obj = undefined;
    console.log(obj.foo);
  </script>
</body>
</html>
    `.trim(),
  },
  {
    name: 'SyntaxError - Invalid JavaScript',
    html: `
<!DOCTYPE html>
<html>
<head><title>Test: SyntaxError</title></head>
<body>
  <h1>Testing SyntaxError</h1>
  <script>
    // This will throw: SyntaxError: Unexpected token
    const x = {;
  </script>
</body>
</html>
    `.trim(),
  },
  {
    name: 'Vite Dev Server Error',
    viteProject: true,
    files: {
      'index.html': `
<!DOCTYPE html>
<html>
<head>
  <title>Vite Error Test</title>
  <script type="module" src="/src/main.ts"></script>
</head>
<body>
  <h1>Testing Vite Build Error</h1>
  <div id="app"></div>
</body>
</html>
      `.trim(),
      'src/main.ts': `
// Intentional error: using undefined variable
console.log(UndefinedVariable);

// Intentional error: importing non-existent module
import { NonExistent } from './does-not-exist';
      `.trim(),
      'package.json': JSON.stringify(
        {
          name: 'vite-error-test',
          version: '1.0.0',
          type: 'module',
          scripts: {
            dev: 'vite --host',
          },
          dependencies: {
            vite: '^5.0.0',
          },
        },
        null,
        2,
      ),
    },
  },
];

interface CaptureResult {
  method: string;
  detected: boolean;
  errorContent?: string;
  responseTime?: number;
  notes?: string;
}

/**
 * Method 1: Fetch HTML and check for Vite error overlay
 */
async function testHTMLErrorOverlay(url: string): Promise<CaptureResult> {
  const start = Date.now();
  try {
    const response = await fetch(url);
    const html = await response.text();
    const responseTime = Date.now() - start;

    // Check for Vite error overlay
    const hasViteOverlay = html.includes('vite-error-overlay') || html.includes('vite-error');

    // Check for error patterns in HTML
    const errorPatterns = [
      'ReferenceError',
      'TypeError',
      'SyntaxError',
      'Uncaught',
      'Cannot find module',
      'Failed to resolve',
    ];

    const detectedError = errorPatterns.find((pattern) => html.includes(pattern));

    return {
      method: 'HTML Error Overlay Detection',
      detected: hasViteOverlay || !!detectedError,
      errorContent: detectedError || (hasViteOverlay ? 'Vite error overlay present' : undefined),
      responseTime,
      notes: `HTML size: ${html.length} bytes`,
    };
  } catch (error) {
    return {
      method: 'HTML Error Overlay Detection',
      detected: false,
      notes: `Fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Method 2: Check sandbox logs via Vercel API
 */
async function testSandboxLogs(sandbox: any): Promise<CaptureResult> {
  const start = Date.now();
  try {
    // Check if Vercel SDK exposes logs
    // @ts-ignore - exploring API
    const logs = sandbox.logs || sandbox.getLogs?.() || null;
    const responseTime = Date.now() - start;

    if (logs) {
      const logsStr = JSON.stringify(logs);
      const errorPatterns = ['Error', 'ReferenceError', 'TypeError', 'SyntaxError'];
      const detectedError = errorPatterns.find((pattern) => logsStr.includes(pattern));

      return {
        method: 'Sandbox Logs API',
        detected: !!detectedError,
        errorContent: detectedError,
        responseTime,
        notes: `Logs available: ${typeof logs}`,
      };
    }

    return {
      method: 'Sandbox Logs API',
      detected: false,
      responseTime,
      notes: 'No logs API available',
    };
  } catch (error) {
    return {
      method: 'Sandbox Logs API',
      detected: false,
      notes: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Method 3: Execute command to read dev server output
 */
async function testDevServerOutput(sandbox: any): Promise<CaptureResult> {
  const start = Date.now();
  try {
    // Try to check if there's a way to stream/capture dev server output
    // @ts-ignore
    const streams = sandbox.streams || sandbox.getStreams?.() || null;
    const responseTime = Date.now() - start;

    return {
      method: 'Dev Server Output Streaming',
      detected: false,
      responseTime,
      notes: streams ? 'Streams available but need investigation' : 'No streaming API found',
    };
  } catch (error) {
    return {
      method: 'Dev Server Output Streaming',
      detected: false,
      notes: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Method 4: Browser console access via CDP/DevTools Protocol
 */
async function testCDPAccess(url: string): Promise<CaptureResult> {
  return {
    method: 'Chrome DevTools Protocol (CDP)',
    detected: false,
    notes: 'CDP requires Chrome instance - not available in sandbox environment',
  };
}

/**
 * Method 5: Check HTTP response headers for error signals
 */
async function testHTTPHeaders(url: string): Promise<CaptureResult> {
  const start = Date.now();
  try {
    const response = await fetch(url, { method: 'HEAD' });
    const responseTime = Date.now() - start;

    const headers = Object.fromEntries(response.headers.entries());

    return {
      method: 'HTTP Response Headers',
      detected: false,
      responseTime,
      notes: `Status: ${response.status}, Headers: ${Object.keys(headers).join(', ')}`,
    };
  } catch (error) {
    return {
      method: 'HTTP Response Headers',
      detected: false,
      notes: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Method 6: Polling with multiple requests to detect error state changes
 */
async function testPollingDetection(url: string, samples: number = 3): Promise<CaptureResult> {
  const start = Date.now();
  const results: boolean[] = [];

  try {
    for (let i = 0; i < samples; i++) {
      const response = await fetch(url);
      const html = await response.text();
      const hasError =
        html.includes('vite-error-overlay') ||
        html.includes('ReferenceError') ||
        html.includes('TypeError') ||
        html.includes('Uncaught');
      results.push(hasError);
      await new Promise((resolve) => setTimeout(resolve, 1000)); // 1s between polls
    }

    const responseTime = Date.now() - start;
    const detected = results.some((r) => r);

    return {
      method: 'Polling Detection (3 samples)',
      detected,
      responseTime,
      notes: `Detected in ${results.filter((r) => r).length}/${samples} samples`,
    };
  } catch (error) {
    return {
      method: 'Polling Detection',
      detected: false,
      notes: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Run all detection methods for a test case
 */
async function runTestCase(testCase: (typeof TEST_CASES)[0]) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Test Case: ${testCase.name}`);
  console.log('='.repeat(80));

  try {
    // Create sandbox
    console.log('\n📦 Creating sandbox...');
    const sandbox = await Sandbox.create({
      token: VERCEL_TOKEN!,
      teamId: VERCEL_TEAM_ID!,
      projectId: VERCEL_PROJECT_ID!,
      runtime: 'node22',
      ports: [5173, 3000],
    });

    console.log(`✅ Sandbox created: ${sandbox.sandboxId}`);

    // Write test files
    if (testCase.viteProject && testCase.files) {
      console.log('\n📝 Writing Vite project files...');
      const filesToWrite = Object.entries(testCase.files).map(([path, content]) => ({
        path, // Use relative paths (sandbox starts in /home/project)
        content: Buffer.from(content),
      }));
      await sandbox.writeFiles(filesToWrite);

      // Install dependencies
      console.log('📦 Installing dependencies...');
      await sandbox.runCommand('npm', ['install']);

      // Start dev server
      console.log('🚀 Starting Vite dev server...');
      // Fire-and-forget - dev server runs indefinitely
      sandbox.runCommand('npm', ['run', 'dev']).catch(() => {
        // Expected - dev server never completes
      });

      // Wait for dev server to be ready
      console.log('⏳ Waiting for dev server...');
      await new Promise((resolve) => setTimeout(resolve, 5000));
    } else {
      console.log('\n📝 Writing test HTML...');
      await sandbox.writeFiles([
        {
          path: 'index.html', // Use relative path
          content: Buffer.from(testCase.html!),
        },
      ]);

      // Start simple HTTP server
      console.log('🚀 Starting HTTP server...');
      sandbox.runCommand('npx', ['serve', '-s', '.', '-l', '5173']).catch(() => {
        // Expected - server never completes
      });

      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    // Get preview URL
    const previewUrl = sandbox.domain(5173);
    console.log(`\n🌐 Preview URL: ${previewUrl}`);

    // Wait a bit more for errors to manifest
    console.log('⏳ Waiting for errors to manifest...');
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Test all capture methods
    console.log('\n🔍 Testing capture methods...\n');
    const results: CaptureResult[] = [];

    results.push(await testHTMLErrorOverlay(previewUrl));
    results.push(await testSandboxLogs(sandbox));
    results.push(await testDevServerOutput(sandbox));
    results.push(await testCDPAccess(previewUrl));
    results.push(await testHTTPHeaders(previewUrl));
    results.push(await testPollingDetection(previewUrl));

    // Print results
    console.log('\n📊 Results:\n');
    for (const result of results) {
      const status = result.detected ? '✅ DETECTED' : '❌ Not detected';
      console.log(`${status} | ${result.method}`);
      if (result.errorContent) {
        console.log(`  └─ Error: ${result.errorContent}`);
      }
      if (result.responseTime) {
        console.log(`  └─ Response time: ${result.responseTime}ms`);
      }
      if (result.notes) {
        console.log(`  └─ Notes: ${result.notes}`);
      }
      console.log();
    }

    // Clean up
    console.log('🧹 Cleaning up...');
    await sandbox.stop();
    console.log('✅ Sandbox stopped');

    return results;
  } catch (error) {
    console.error('❌ Test case failed:', error);
    return [];
  }
}

/**
 * Main test runner
 */
async function main() {
  console.log('🚀 Starting Error Capture Experiment');
  console.log('═'.repeat(80));

  const allResults: Array<{ testCase: string; results: CaptureResult[] }> = [];

  // Run first test case only for now (faster iteration)
  const testCase = TEST_CASES[0];
  const results = await runTestCase(testCase);
  allResults.push({ testCase: testCase.name, results });

  // Summary
  console.log('\n\n' + '═'.repeat(80));
  console.log('📊 SUMMARY');
  console.log('═'.repeat(80));

  for (const { testCase, results } of allResults) {
    console.log(`\n${testCase}:`);
    const detected = results.filter((r) => r.detected);
    console.log(`  ${detected.length}/${results.length} methods detected errors`);
    if (detected.length > 0) {
      console.log('  Working methods:');
      detected.forEach((r) => {
        console.log(`    • ${r.method}`);
      });
    }
  }

  console.log('\n✨ Experiment complete!');
}

// Run the experiment
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
