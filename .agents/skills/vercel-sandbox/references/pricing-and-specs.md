# Vercel Sandbox — Pricing, Limits & System Specifications

> Last fetched: 2026-02-06
> Sources:
> - https://vercel.com/docs/vercel-sandbox/pricing
> - https://vercel.com/docs/vercel-sandbox (system specifications section)

## Pricing

Sandbox is billed based on **compute time** (vCPU-seconds).

| Plan | Included | Overage |
|------|----------|---------|
| Hobby | 100 sandbox-hours/month | N/A (hard limit) |
| Pro | 100 sandbox-hours/month | $0.00028/vCPU-second |
| Enterprise | Custom | Custom |

> Note: Pricing may change — consult https://vercel.com/docs/vercel-sandbox/pricing for current rates.

## Resource limits

| Resource | Hobby | Pro | Enterprise |
|----------|-------|-----|------------|
| Max vCPUs per sandbox | 2 | 8 | 8 |
| Max concurrent sandboxes | 5 | 20 | Custom |
| Max execution timeout | 45 minutes | 5 hours | 5 hours |
| Default timeout | 5 minutes | 5 minutes | 5 minutes |
| Disk space | 10 GB | 10 GB | 10 GB |
| Memory | Scales with vCPUs | Scales with vCPUs | Scales with vCPUs |

## Snapshot expiration

Snapshots expire after **7 days**. Plan ahead if you rely on snapshots for fast boot workflows.

## System specifications

### Base image

Amazon Linux 2023 with common build tools:
- `git`, `tar`, `openssl`, `dnf`, `curl`, `wget`

### Runtimes and package managers

| Image | Runtime | Package managers |
|-------|---------|-----------------|
| `node24` | Node.js 24.x | `npm`, `pnpm` |
| `node22` | Node.js 22.x | `npm`, `pnpm` |
| `python3.13` | Python 3.13 | `pip`, `uv` |

### Execution environment

- User: `vercel-sandbox`
- Default working directory: `/vercel/sandbox`
- Internet access: available
- Filesystem: **ephemeral** — lost when sandbox stops
- Sudo: enabled, `HOME=/root` when using sudo, `PATH` preserved

### Installing system packages

Use `dnf` inside the sandbox:

```ts
// TypeScript
await sandbox.runCommand({ cmd: 'sudo', args: ['dnf', 'install', '-y', 'gcc'] });
```

```python
# Python
await sandbox.run_command(cmd='sudo', args=['dnf', 'install', '-y', 'gcc'])
```

Available packages: https://docs.aws.amazon.com/linux/al2023/release-notes/all-packages-AL2023.7.html

### Sudo config

- `HOME` is set to `/root` (root's config files sourced)
- `PATH` is preserved (local/project binaries remain available)
- All other environment variables are inherited

## Observability

View sandbox activity per project:
1. Vercel Dashboard → Project → Observability tab → Sandboxes
2. Track compute usage across projects: Dashboard → Usage tab
