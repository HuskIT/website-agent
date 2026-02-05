# How to execute AI-generated code safely with Vercel Sandbox
Last updated January 29, 2026
By Allen ZhouAmy Burns

---

When you let AI models generate and execute code, you need a secure execution environment. The AI might produce code that consumes excessive resources, accesses sensitive files, makes unwanted network requests, or runs destructive commands.

[Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) provides isolation, resource limits, and automatic timeouts that make it safe to run untrusted code. This guide shows you how to build an "AI code runner" that takes a task, generates code using the [AI SDK](https://ai-sdk.dev) with [AI Gateway](https://vercel.com/docs/ai-gateway), and executes it in a sandbox.

## [Prerequisites](#prerequisites)

Before you begin, make sure you have:

*   Vercel CLI installed (`pnpm install -g vercel`)
*   Node.js 22 or later
*   A [Vercel project](https://vercel.com/docs/projects) to link your sandbox to and generate an OIDC token

## [1\. Project setup](#1.-project-setup)

Create a new directory and install dependencies:

```
mkdir ai-code-runnercd ai-code-runnerpnpm initpnpm add @vercel/sandbox ai ms zod dotenvpnpm add -D @types/node
```

## [2\. Set up authentication](#2.-set-up-authentication)

Link your project to Vercel and pull the OIDC token. This token authenticates both Sandbox and [AI Gateway](https://vercel.com/docs/ai-gateway):

```
vercel linkvercel env pull
```

## [3\. Create the script](#3.-create-the-script)

Create a file called `index.ts` and add the code below. The script:

1.  Takes a task description from the command line
2.  Sends it to Claude via AI Gateway
3.  Writes the generated code to an isolated sandbox
4.  Executes it and captures the output

```
1import ms from 'ms';2import { generateText } from 'ai';3import { Sandbox } from '@vercel/sandbox';4import dotenv from 'dotenv';5
6dotenv.config({ path: '.env.local' });7
8const SYSTEM_PROMPT = `You are a code generator. Write JavaScript code that runs in Node.js.9
10Rules:11- Output ONLY the code, no explanations or markdown12- Use only standard Node.js features (no external packages)13- No file system access (no fs module)14- No network requests (no fetch, http, etc.)15- No process.env access16- Code must complete within 10 seconds17- Use console.log() to output results`;18
19async function generateCode(task: string): Promise<string> {20  const { text } = await generateText({21    model: 'anthropic/claude-sonnet-4.5',22    system: SYSTEM_PROMPT,23    prompt: `Write JavaScript code to: ${task}`,24  });25
26  return text27    .replace(/^\s*```(?:javascript|js)?\s*/i, '')28    .replace(/\s*```\s*$/i, '')29    .trim();30}31
32async function executeCode(code: string): Promise<{ output: string; exitCode: number }> {33  const sandbox = await Sandbox.create({34    resources: { vcpus: 2 },35    timeout: ms('2m'),36    runtime: 'node22',37  });38
39  try {40    await sandbox.writeFiles([41      { path: '/vercel/sandbox/code.mjs', content: Buffer.from(code) },42    ]);43
44    const result = await sandbox.runCommand({ cmd: 'node', args: ['code.mjs'] });45
46    const stdout = await result.stdout();47    const stderr = await result.stderr();48
49    return { output: stdout || stderr || '(no output)', exitCode: result.exitCode };50  } finally {51    await sandbox.stop();52  }53}54
55async function main() {56  const task = process.argv.slice(2).join(' ').trim();57
58  if (!task) {59    process.exit(1);60  }61
62  console.log(`Task: ${task}\n`);63
64  const code = await generateCode(task);65
66  console.log('Generated code:\n');67  console.log(code);68  console.log('\nRunning in sandbox...\n');69
70  const { output, exitCode } = await executeCode(code);71
72  console.log('Output:\n');73  console.log(output);74
75  process.exitCode = exitCode;76}77
78main().catch((error) => {79  console.error(error instanceof Error ? error.message : String(error));80  process.exit(1);81});
```

## [4\. Run the script](#4.-run-the-script)

Run the script with a task description:

```
pnpm dlx tsx index.ts "Calculate the first 20 Fibonacci numbers"
```

Expected output:

```
Task: Calculate the first 20 Fibonacci numbers
Generated code:
function fibonacci(n) {  const result = [];  if (n >= 1) result.push(0);  if (n >= 2) result.push(1);
  for (let i = 2; i < n; i++) {    result.push(result[i - 1] + result[i - 2]);  }
  return result;}
console.log(fibonacci(20));
Running in sandbox...
Output:
[  0, 1, 1, 2, 3,  5, 8, 13, 21, 34,  55, 89, 144, 233, 377,  610, 987, 1597, 2584, 4181]
```

Try other tasks:

```
pnpm dlx tsx index.ts "Find all prime numbers under 100"pnpm dlx tsx index.ts "Implement quicksort and sort [64, 34, 25, 12, 22, 11, 90]"pnpm dlx tsx index.ts "Reverse each word in 'Hello World from Sandbox'"
```

## [Safety layers](#safety-layers)

The script uses multiple safety layers to handle untrusted code:

Sandbox isolation: Each execution runs in a fresh microVM with limited resources and a short timeout. If the code hangs or tries to use too much memory, the sandbox terminates it.

Prompt constraints: The system prompt instructs Claude to avoid dangerous operations: no file system access, no network requests, no environment variables. While not foolproof, this reduces the likelihood of problematic code.

Error capture: The sandbox captures both stdout and stderr, so you can inspect failures without them affecting your host system.

## [Next steps](#next-steps)

*   Add [snapshots](https://vercel.com/docs/vercel-sandbox/managing#snapshotting) to speed up repeated executions
*   Use [Sandbox.get()](https://vercel.com/docs/vercel-sandbox/sdk-reference#sandbox.get) to reuse sandboxes across requests
*   Explore [AI SDK](https://ai-sdk.dev) features like streaming and tool calling
*   Learn about [AI Gateway](https://vercel.com/docs/ai-gateway) model routing and fallbacks