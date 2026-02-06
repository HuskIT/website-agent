# Vercel Sandbox — Quickstart

> Last fetched: 2026-02-06
> Source: https://vercel.com/docs/vercel-sandbox/quickstart

## Prerequisites

- A Vercel account (https://vercel.com/signup)
- Vercel CLI installed (`npm i -g vercel`)
- Node.js 22+

## Steps

### 1. Install the SDK

```bash
pnpm i @vercel/sandbox
```

### 2. Connect to a Vercel project

Link your local directory to a Vercel project for authentication:

```bash
# New project
mkdir my-sandbox-app && cd my-sandbox-app
npm init -y
vercel link
# Select "Create a new project" when prompted — no code deploy needed

# Existing project
vercel link
```

### 3. Pull your authentication token

```bash
vercel env pull
```

Creates `.env.local` with an OIDC token the SDK uses. Token expires after **12 hours** locally.
Run `vercel env pull` again on auth errors. In production on Vercel, tokens are managed automatically.

### 4. Write your code

```ts
// index.ts
import { Sandbox } from '@vercel/sandbox';

const sandbox = await Sandbox.create();
const result = await sandbox.runCommand('echo', ['Hello from Vercel Sandbox!']);
console.log(await result.stdout());
await sandbox.stop();
```

### 5. Run it

```bash
node --env-file .env.local index.ts
```

Output: `Hello from Vercel Sandbox!`

## What happens

1. SDK installed
2. Project linked for auth
3. OIDC token pulled to `.env.local`
4. Isolated Linux microVM created
5. Command executed inside it
6. Sandbox stopped, resources freed

## Authentication methods

### Vercel OIDC token (recommended)

SDK uses OIDC tokens automatically when available.
- **Local dev**: `vercel env pull` → `.env.local` (12h expiry)
- **Production on Vercel**: Managed automatically

### Access tokens (alternative)

For environments where OIDC is unavailable. Required env vars:
- `VERCEL_TEAM_ID` — your team ID
- `VERCEL_PROJECT_ID` — your project ID
- `VERCEL_TOKEN` — a Vercel access token with team access

```ts
const sandbox = await Sandbox.create({
  teamId: process.env.VERCEL_TEAM_ID!,
  projectId: process.env.VERCEL_PROJECT_ID!,
  token: process.env.VERCEL_TOKEN!,
  source: { url: 'https://github.com/vercel/sandbox-example-next.git', type: 'git' },
  resources: { vcpus: 4 },
  timeout: 300000, // 5 min
  ports: [3000],
  runtime: 'node24',
});
```
