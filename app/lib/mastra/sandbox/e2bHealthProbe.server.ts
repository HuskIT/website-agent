type DynamicImport = (modulePath: string) => Promise<any>;

const dynamicImport: DynamicImport = new Function('modulePath', 'return import(modulePath)') as DynamicImport;

// Prefer the Quickstart package/API first.
const E2B_MODULE_CANDIDATES = ['@e2b/code-interpreter', 'e2b', '@e2b/sdk'];

export interface E2BHealthProbeResult {
  ok: boolean;
  provider: 'e2b';
  nodeVersion?: string;
  sandboxId?: string | null;
  latencyMs: number;
  error?: string;
}

function getE2BApiKey(): string | undefined {
  return process.env.E2B_API_KEY || process.env.E2B_API_TOKEN;
}

async function loadE2BModule(): Promise<any | null> {
  for (const modulePath of E2B_MODULE_CANDIDATES) {
    try {
      return await dynamicImport(modulePath);
    } catch {
      // Try next module candidate.
    }
  }

  return null;
}

async function createSandbox(moduleRef: any, apiKey: string): Promise<any> {
  if (moduleRef?.Sandbox?.create && typeof moduleRef.Sandbox.create === 'function') {
    try {
      // Preferred when SDK accepts explicit key.
      return await moduleRef.Sandbox.create({ apiKey });
    } catch {
      // Quickstart path: key from E2B_API_KEY env.
      return moduleRef.Sandbox.create();
    }
  }

  if (moduleRef?.createSandbox && typeof moduleRef.createSandbox === 'function') {
    return moduleRef.createSandbox({ apiKey });
  }

  if (moduleRef?.E2B?.Sandbox?.create && typeof moduleRef.E2B.Sandbox.create === 'function') {
    return moduleRef.E2B.Sandbox.create({ apiKey });
  }

  throw new Error('No supported sandbox factory found in loaded E2B module');
}

function parseNodeVersion(commandResult: any): string | null {
  if (typeof commandResult === 'string') {
    return commandResult.trim() || null;
  }

  if (typeof commandResult?.stdout === 'string') {
    return commandResult.stdout.trim() || null;
  }

  if (typeof commandResult?.output === 'string') {
    return commandResult.output.trim() || null;
  }

  const textLike = commandResult?.stdout?.toString?.() ?? commandResult?.output?.toString?.();

  if (typeof textLike === 'string') {
    return textLike.trim() || null;
  }

  return null;
}

async function runNodeVersionCommand(sandbox: any): Promise<string> {
  // Quickstart API: sandbox.commands.run("node --version")
  if (sandbox?.commands?.run && typeof sandbox.commands.run === 'function') {
    const result = await sandbox.commands.run('node --version');
    const parsed = parseNodeVersion(result);

    if (parsed) {
      return parsed;
    }
  }

  if (!sandbox?.runCommand || typeof sandbox.runCommand !== 'function') {
    throw new Error('Loaded sandbox does not expose commands.run or runCommand');
  }

  const attempts: Array<() => Promise<any>> = [
    () => sandbox.runCommand('node --version'),
    () => sandbox.runCommand({ cmd: 'node', args: ['--version'] }),
    () => sandbox.runCommand({ command: 'node --version' }),
  ];

  let lastError: unknown = null;

  for (const run of attempts) {
    try {
      const result = await run();
      const parsed = parseNodeVersion(result);

      if (parsed) {
        return parsed;
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Unable to execute "node --version" in E2B sandbox${lastError ? `: ${String(lastError)}` : ''}`);
}

async function cleanupSandbox(sandbox: any): Promise<void> {
  const cleanupFns = [sandbox?.kill, sandbox?.close, sandbox?.stop].filter((fn): fn is () => Promise<void> =>
    Boolean(fn && typeof fn === 'function'),
  );

  for (const fn of cleanupFns) {
    try {
      await fn.call(sandbox);
      return;
    } catch {
      // Try next cleanup function.
    }
  }
}

export async function runE2BHealthProbe(): Promise<E2BHealthProbeResult> {
  const startedAt = Date.now();
  const apiKey = getE2BApiKey();

  if (!apiKey) {
    return {
      ok: false,
      provider: 'e2b',
      latencyMs: Date.now() - startedAt,
      error: 'Missing E2B API key (set E2B_API_KEY or E2B_API_TOKEN)',
    };
  }

  const moduleRef = await loadE2BModule();

  if (!moduleRef) {
    return {
      ok: false,
      provider: 'e2b',
      latencyMs: Date.now() - startedAt,
      error: 'E2B SDK is not installed',
    };
  }

  let sandbox: any = null;

  try {
    sandbox = await createSandbox(moduleRef, apiKey);

    const nodeVersion = await runNodeVersionCommand(sandbox);

    return {
      ok: true,
      provider: 'e2b',
      nodeVersion,
      sandboxId: sandbox?.sandboxId ?? sandbox?.id ?? null,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Keep this server-safe for direct script execution (outside Vite runtime).
    console.error('[e2bHealthProbe] probe failed:', message);

    return {
      ok: false,
      provider: 'e2b',
      latencyMs: Date.now() - startedAt,
      sandboxId: sandbox?.sandboxId ?? sandbox?.id ?? null,
      error: message,
    };
  } finally {
    if (sandbox) {
      await cleanupSandbox(sandbox);
    }
  }
}
