# Vercel Sandbox — CLI Reference

> Last fetched: 2026-02-06
> Source: https://vercel.com/docs/vercel-sandbox/cli-reference

## Prerequisites

- Vercel CLI installed: `npm i -g vercel`
- Logged in: `vercel login`
- Linked to a project: `vercel link`

## Commands

### `vercel sandbox`

Manage sandboxes from the command line.

### `vercel sandbox create`

Create a new sandbox.

```bash
vercel sandbox create [options]
```

**Options:**

| Flag | Description |
|------|-------------|
| `--runtime <runtime>` | Runtime image: `node24`, `node22`, `python3.13` |
| `--source <url>` | Git repository URL to clone |
| `--port <port>` | Port to expose (can repeat) |
| `--timeout <ms>` | Initial timeout in milliseconds |
| `--vcpus <n>` | Number of virtual CPUs |

### `vercel sandbox list`

List sandboxes for the current project.

```bash
vercel sandbox list [options]
```

**Options:**

| Flag | Description |
|------|-------------|
| `--limit <n>` | Max sandboxes to return |
| `--since <date>` | Filter by creation date (after) |
| `--until <date>` | Filter by creation date (before) |

### `vercel sandbox stop`

Stop a running sandbox.

```bash
vercel sandbox stop <sandbox-id>
```

### `vercel sandbox exec`

Execute a command in a sandbox.

```bash
vercel sandbox exec <sandbox-id> -- <command> [args...]
```

### `vercel sandbox logs`

Stream logs from a sandbox.

```bash
vercel sandbox logs <sandbox-id> [command-id]
```

## Common workflows

### Create and run interactively

```bash
# Create sandbox
vercel sandbox create --runtime node24 --port 3000

# Note the sandbox ID from output, then exec commands
vercel sandbox exec sbx_abc123 -- npm install
vercel sandbox exec sbx_abc123 -- npm start

# Stop when done
vercel sandbox stop sbx_abc123
```

### List and clean up

```bash
vercel sandbox list --limit 10
vercel sandbox stop sbx_abc123
```
