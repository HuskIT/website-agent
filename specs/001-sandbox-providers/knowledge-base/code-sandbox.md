# Safely running AI generated code in your Next.js application
Last updated January 27, 2026
By Delba de Oliveira

---

AI models are increasingly used to generate code. Often, applications return this code to the user as plain text. But some apps could run the generated code to produce UI or other results.

This creates powerful possibilities but introduces risk. Generated code is untrusted. It may delete files, leak sensitive data, or consume excessive resources. The danger increases when users can influence prompts and craft malicious input. So running AI generated code on your machine or in your production application is unsafe.

[Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) addresses this by running untrusted code in a remote, isolated environment with strong safeguards and full control.

## [Overview](#overview)

In this guide, you'll learn:

*   What Vercel Sandbox is and how it works.
*   How to create a sandbox, run commands, and capture results.
*   Example: Use an AI SDK Agent to generate and safely execute code inside a sandbox.

## [Example](#example)

To understand how Vercel Sandbox works, let's build a minimal AI app that responds to natural language queries that require computation or network access, such as: "Get the top story from Hacker News” or "What is 44 × 44?"

To keep the example simple and avoid boilerplate code, we'll use the following tools:

*   A Next.js [route handler](https://nextjs.org/docs/app/getting-started/route-handlers-and-middleware) that accepts user input and returns the result.
*   The [AI Gateway](https://vercel.com/docs/ai-gateway) to query OpenAI without managing API keys.
*   The [AI SDK](https://ai-sdk.dev/) to create an agent that orchestrates tool calls and sandbox execution.
*   [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) to run the generated code.

Here's how it works:

![safely-run-code-in-sandbox-light__1_.png](/vc-ap-vercel-docs/_next/image?url=https%3A%2F%2Fimages.ctfassets.net%2Fhjgychtc108g%2FgzQ6IcXhyegDNl3DKKOza%2F51b3dd0a954046132ee29e4c65c083d9%2Fsafely-run-code-in-sandbox-light__1_.png&w=3840&q=75)![safely-run-code-in-sandbox-light__1_.png](/vc-ap-vercel-docs/_next/image?url=https%3A%2F%2Fimages.ctfassets.net%2Fhjgychtc108g%2FjJlgzVUBWJ9xIzoC6oALx%2Fdbca2cfdd7da8c32928db8b8d0314efd%2Fsafely-run-code-in-sandbox-dark.png&w=3840&q=75)

Since the generated code and packages are unpredictable and potentially unsafe, we will run and install them inside Vercel Sandbox.

### [1\. Initial setup](#1.-initial-setup)

Create a minimal Next.js project:

Terminal

```
pnpx create-next-app sandbox-example --api
```

Install required packages:

Terminal

```
pnpm add @vercel/sandbox ai zod
```

### [2\. Authenticate with Vercel](#2.-authenticate-with-vercel)

*   Prerequisite: Install the [Vercel CLI.](https://vercel.com/docs/cli)

Vercel Sandbox and AI Gateway use [Vercel OIDC tokens](https://vercel.com/docs/vercel-sandbox#vercel-oidc-token) to authenticate whenever available. This is the most straightforward and recommended way to authenticate. You can also authenticate using [access tokens](https://vercel.com/docs/vercel-sandbox#using-access-tokens).

Link local directory to Vercel project:

Terminal

```
vercel link
```

Pull OIDC token for local development:

Terminal

```
vercel env pull
```

In development, the token expires after 12 hours (run vercel env pull again to refresh). In production, Vercel manages token expiration for you.

### [3\. Create a Route Handler](#3.-create-a-route-handler)

Finally, we'll set up a Next.js route handler that accepts a request, generates and runs code and returns a response to the user.

/app/api/agent/route.ts

```
import { NextRequest, after } from "next/server"import { Sandbox } from "@vercel/sandbox"import { Experimental_Agent as Agent, stepCountIs, tool } from "ai"import { z } from "zod"
export async function POST(req: NextRequest) {  let sandbox: Sandbox | null = null
  const body = await req.json()  const parsed = z    .object({ prompt: z.string().min(1).max(10_000) })    .safeParse(body)  if (!parsed.success) {    return Response.json(      { error: "Invalid body. Expected { prompt: string }." },      { status: 400 },    )  }  const { prompt } = parsed.data
  // create an isolated VM  sandbox = await Sandbox.create({    runtime: "node22",    // stop sandbox after 30 seconds of inactivity    timeout: 30_000,  })  console.log(`[agent] sandbox ${sandbox.sandboxId} created`)
  const agent = new Agent({    model: "openai/gpt-5-nano",    system:      "You are an AI assistant that generates and runs JS. Use console.log to output values.",    tools: {      generateAndRunCode: tool({        description: "Use this tool to run JS code in Node.js v22 sandbox",        inputSchema: z.object({          code: z.string().describe("The JS code to run"),          packages: z            .array(z.string())            .nullable()            .default([])            .describe("Optional packages to install"),        }),        execute: async ({ code, packages }) => {          // If the LLM output provides packages, install them with npm.          if (packages && packages.length > 0) {            console.log(`[agent] npm install ${packages.join(" ")}`)            const installStep = await sandbox.runCommand({              cmd: "npm",              args: ["install", ...packages],            })            const installOut = await installStep.stdout()            console.log(`[agent] npm install exit=${installStep.exitCode}`)            if (installStep.exitCode !== 0) {              return { output: installOut, exitCode: installStep.exitCode }            }          }          console.log(`[agent] generated code:\n${code}`)          console.log(`[agent] node -e (code length=${code.length})`)          // Execute generated code, e.g. node -e "console.log('Hello, world!')"          const runResult = await sandbox.runCommand({            cmd: "node",            args: ["-e", code],          })          const output = await runResult.stdout()          console.log(`[agent] node exit=${runResult.exitCode}`)          return { output, exitCode: runResult.exitCode }        },      }),    },    stopWhen: stepCountIs(10),  })
  console.log(`[agent] generate start`)  const result = await agent.generate({ prompt })  console.log(`[agent] generate done (text=${result.text.length} chars)`)
  after(async () => {    // cleanup sandbox after request is done    await sandbox.stop()  })  return Response.json({ text: result.text })}
```

### [4\. Test with a prompt](#4.-test-with-a-prompt)

We can now test our application using a prompt. Start the Next.js development server by running `pnpm run dev,` then in a new terminal window, send a user query using `cURL`:

Terminal

```
curl -X POST \  -H "Content-Type: application/json" \  -d '{"prompt":"Get Hacker News top story title and URL"}' \  http://localhost:3000/api/agent | jq .
```

You can switch to the development server terminal to observe the program running. Finally, once done, you can switch back to the other terminal to see the result. You should see a message that includes the title and url of a hackernews post.

### [5\. Verify isolation with safe "harmful" prompts](#5.-verify-isolation-with-safe-harmful-prompts)

You can also see the benefit of running the generated code in a sandbox by intentionally sending destructive and malicious queries to your application.

Attempt to delete files:

Terminal

```
curl -X POST \  -H "Content-Type: application/json" \  -d '{"prompt":"Delete the ./tmp folder and show me the result"}' \  http://localhost:3000/api/agent | jq .
```

_Expectation: The folder (if it exists) is removed inside the sandbox, but your main application files are unchanged._

Attempt to read secrets:

Terminal

```
curl -X POST \  -H "Content-Type: application/json" \  -d '{"prompt":"Print process.env"}' \  http://localhost:3000/api/agent | jq .
```

_Expectation: You only see environment variables of the sandbox and not the host environment._

## [Next steps](#next-steps)

This example showed how to combine Next.js, the AI SDK, and Vercel Sandbox to safely run generated code. Learn more in the [Vercel Sandbox docs](https://vercel.com/docs/vercel-sandbox) and [SDK reference](https://vercel.com/docs/vercel-sandbox/sdk-reference) and try it out in your own project today.