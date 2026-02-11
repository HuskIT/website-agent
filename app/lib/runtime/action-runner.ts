import type { WebContainer } from '@webcontainer/api';
import { path as nodePath } from '~/utils/path';
import { atom, map, type MapStore } from 'nanostores';
import type { ActionAlert, BoltAction, DeployAlert, FileHistory, SupabaseAction, SupabaseAlert } from '~/types/actions';
import { createScopedLogger } from '~/utils/logger';
import { unreachable } from '~/utils/unreachable';
import type { ActionCallbackData } from './message-parser';
import type { BoltShell } from '~/utils/shell';
import type { VercelShell } from '~/lib/sandbox/vercel-terminal';
import { applyEdit, groupEditsByFile, parseEditBlocks, sortEditsForApplication } from './edit-parser';
import { ENABLE_AST_MATCHING, getAstContext } from './ast-context';
import type { SandboxProvider } from '~/lib/sandbox/types';
import { getProviderInstance, waitForProviderInstance } from '~/lib/stores/sandbox';

const logger = createScopedLogger('ActionRunner');

export type ActionStatus = 'pending' | 'running' | 'complete' | 'aborted' | 'failed';

export type BaseActionState = BoltAction & {
  status: Exclude<ActionStatus, 'failed'>;
  abort: () => void;
  executed: boolean;
  abortSignal: AbortSignal;
  output?: string; // Captured stdout/stderr from shell commands
};

export type FailedActionState = BoltAction &
  Omit<BaseActionState, 'status'> & {
    status: Extract<ActionStatus, 'failed'>;
    error: string;
  };

export type ActionState = BaseActionState | FailedActionState;

type BaseActionUpdate = Partial<Pick<BaseActionState, 'status' | 'abort' | 'executed' | 'output'>>;

export type ActionStateUpdate =
  | BaseActionUpdate
  | (Omit<BaseActionUpdate, 'status'> & { status: 'failed'; error: string });

type ActionsMap = MapStore<Record<string, ActionState>>;

class ActionCommandError extends Error {
  readonly _output: string;
  readonly _header: string;

  constructor(message: string, output: string) {
    // Create a formatted message that includes both the error message and output
    const formattedMessage = `Failed To Execute Shell Command: ${message}\n\nOutput:\n${output}`;
    super(formattedMessage);

    // Set the output separately so it can be accessed programmatically
    this._header = message;
    this._output = output;

    // Maintain proper prototype chain
    Object.setPrototypeOf(this, ActionCommandError.prototype);

    // Set the name of the error for better debugging
    this.name = 'ActionCommandError';
  }

  // Optional: Add a method to get just the terminal output
  get output() {
    return this._output;
  }
  get header() {
    return this._header;
  }
}

export class ActionRunner {
  #webcontainer: Promise<WebContainer>;
  #currentExecutionPromise: Promise<void> = Promise.resolve();
  #shellTerminal: () => BoltShell | VercelShell;
  #onMarkRecentlySaved?: (relativePath: string, timeout?: number) => void;
  #onSandboxExpired?: () => Promise<void>;
  runnerId = atom<string>(`${Date.now()}`);
  actions: ActionsMap = map({});
  onAlert?: (alert: ActionAlert) => void;
  onSupabaseAlert?: (alert: SupabaseAlert) => void;
  onDeployAlert?: (alert: DeployAlert) => void;
  buildOutput?: { path: string; exitCode: number; output: string };

  constructor(
    webcontainerPromise: Promise<WebContainer>,
    getShellTerminal: () => BoltShell | VercelShell,
    onAlert?: (alert: ActionAlert) => void,
    onSupabaseAlert?: (alert: SupabaseAlert) => void,
    onDeployAlert?: (alert: DeployAlert) => void,
    onMarkRecentlySaved?: (relativePath: string, timeout?: number) => void,
    onSandboxExpired?: () => Promise<void>,
  ) {
    this.#webcontainer = webcontainerPromise;
    this.#shellTerminal = getShellTerminal;
    this.onAlert = onAlert;
    this.onSupabaseAlert = onSupabaseAlert;
    this.onDeployAlert = onDeployAlert;
    this.#onMarkRecentlySaved = onMarkRecentlySaved;
    this.#onSandboxExpired = onSandboxExpired;
  }

  /**
   * Get the active SandboxProvider if available and connected, otherwise null.
   * Dynamically checks provider status to handle async connection timing.
   * Waits for provider initialization if needed.
   */
  async #getProvider(): Promise<SandboxProvider | null> {
    let provider = getProviderInstance();

    /*
     * If no provider exists yet, wait for it to be initialized
     * This handles the case where artifacts are created before sandbox is ready
     */
    if (!provider) {
      console.log('[ActionRunner] No provider instance yet, waiting for initialization...');
      provider = await waitForProviderInstance(30000); // Wait up to 30s

      if (provider) {
        console.log('[ActionRunner] Provider initialized:', {
          type: provider.type,
          status: provider.status,
          sandboxId: provider.sandboxId,
        });
      } else {
        console.warn('[ActionRunner] Provider initialization timed out');
        return null;
      }
    }

    // Check if provider is a Vercel Sandbox
    if (provider && provider.type === 'vercel') {
      // If connected, return immediately
      if (provider.status === 'connected') {
        return provider;
      }

      // If connecting or reconnecting, wait for it
      if (provider.status === 'connecting' || provider.status === 'reconnecting') {
        console.log('[ActionRunner] Provider connecting, waiting...');

        try {
          // Wait up to 5 seconds for connection
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              cleanup();
              reject(new Error('Provider connection timeout'));
            }, 5000);

            const cleanup = provider!.onStatusChange((status) => {
              if (status === 'connected') {
                cleanup();
                clearTimeout(timeout);
                resolve();
              } else if (status === 'disconnected' || status === 'error') {
                cleanup();
                clearTimeout(timeout);
                reject(new Error(`Provider failed to connect: ${status}`));
              }
            });
          });

          // Re-check status after wait
          const currentProvider = getProviderInstance();

          if (currentProvider && currentProvider.status === 'connected') {
            return currentProvider;
          }
        } catch (error) {
          console.warn('[ActionRunner] Failed to wait for provider connection:', error);
        }
      }
    }

    return provider?.type === 'vercel' ? provider : null;
  }

  /**
   * Wait for all queued actions to complete execution.
   * Used to ensure file writes are finished before taking snapshots.
   */
  async waitForCompletion(): Promise<void> {
    await this.#currentExecutionPromise;
  }

  addAction(data: ActionCallbackData) {
    const { actionId } = data;

    const actions = this.actions.get();
    const action = actions[actionId];

    if (action) {
      // action already added
      return;
    }

    const abortController = new AbortController();

    this.actions.setKey(actionId, {
      ...data.action,
      status: 'pending',
      executed: false,
      abort: () => {
        abortController.abort();
        this.#updateAction(actionId, { status: 'aborted' });
      },
      abortSignal: abortController.signal,
    });

    this.#currentExecutionPromise.then(() => {
      this.#updateAction(actionId, { status: 'running' });
    });
  }

  async runAction(data: ActionCallbackData, isStreaming: boolean = false) {
    const { actionId } = data;
    const action = this.actions.get()[actionId];

    if (!action) {
      unreachable(`Action ${actionId} not found`);
    }

    if (action.executed) {
      return; // No return value here
    }

    if (isStreaming && action.type !== 'file') {
      return; // No return value here
    }

    // Manage streaming mode for file sync to prevent API spam
    this.#manageFileSyncStreaming(isStreaming);

    this.#updateAction(actionId, { ...action, ...data.action, executed: !isStreaming });

    this.#currentExecutionPromise = this.#currentExecutionPromise
      .then(() => {
        return this.#executeAction(actionId, isStreaming);
      })
      .catch((error) => {
        logger.error('Action execution promise failed:', error);
      });

    await this.#currentExecutionPromise;

    return;
  }

  /**
   * Manage FileSyncManager streaming mode to prevent API spam during LLM streaming.
   * When streaming starts, delay file syncs. When streaming ends, flush all pending files.
   */
  #manageFileSyncStreaming(isStreaming: boolean): void {
    // Dynamic import to avoid circular dependency
    import('~/lib/stores/workbench')
      .then(({ workbenchStore }) => {
        const fileSyncManager = workbenchStore.getFileSyncManager?.();

        if (fileSyncManager) {
          fileSyncManager.setStreamingMode(isStreaming);
        }
      })
      .catch(() => {
        // Ignore errors - workbench store might not be available
      });
  }

  /**
   * Flush any pending file syncs before running shell commands.
   * This ensures files are written before commands that depend on them (e.g., npm install).
   */
  async #flushPendingFileSyncs(): Promise<void> {
    try {
      const { workbenchStore } = await import('~/lib/stores/workbench');
      const fileSyncManager = workbenchStore.getFileSyncManager?.();

      if (fileSyncManager) {
        // Disable streaming mode and flush all pending writes
        fileSyncManager.setStreamingMode(false);
        await fileSyncManager.flushWrites();
        logger.debug('[ActionRunner] Flushed pending file syncs before shell command');
      }
    } catch {
      // Ignore errors - workbench store might not be available
    }
  }

  async #executeAction(actionId: string, isStreaming: boolean = false) {
    const action = this.actions.get()[actionId];

    this.#updateAction(actionId, { status: 'running' });

    try {
      switch (action.type) {
        case 'shell': {
          await this.#runShellAction(actionId, action);
          break;
        }
        case 'file': {
          await this.#runFileAction(action);
          break;
        }
        case 'supabase': {
          try {
            await this.handleSupabaseAction(action as SupabaseAction);
          } catch (error: any) {
            // Update action status
            this.#updateAction(actionId, {
              status: 'failed',
              error: error instanceof Error ? error.message : 'Supabase action failed',
            });

            // Return early without re-throwing
            return;
          }
          break;
        }
        case 'build': {
          const buildOutput = await this.#runBuildAction(action);

          // Store build output for deployment
          this.buildOutput = buildOutput;
          break;
        }
        case 'edit': {
          await this.#runEditAction(action);
          break;
        }
        case 'start': {
          // making the start app non blocking

          this.#runStartAction(action)
            .then(() => this.#updateAction(actionId, { status: 'complete' }))
            .catch((err: Error) => {
              if (action.abortSignal.aborted) {
                return;
              }

              this.#updateAction(actionId, { status: 'failed', error: 'Action failed' });
              logger.error(`[${action.type}]:Action failed\n\n`, err);

              if (!(err instanceof ActionCommandError)) {
                return;
              }

              this.onAlert?.({
                type: 'error',
                title: 'Dev Server Failed',
                description: err.header,
                content: err.output,
              });
            });

          /*
           * adding a delay to avoid any race condition between 2 start actions
           * i am up for a better approach
           */
          await new Promise((resolve) => setTimeout(resolve, 2000));

          return;
        }
      }

      this.#updateAction(actionId, {
        status: isStreaming ? 'running' : action.abortSignal.aborted ? 'aborted' : 'complete',
      });
    } catch (error) {
      if (action.abortSignal.aborted) {
        return;
      }

      this.#updateAction(actionId, { status: 'failed', error: 'Action failed' });
      logger.error(`[${action.type}]:Action failed\n\n`, error);

      if (!(error instanceof ActionCommandError)) {
        return;
      }

      this.onAlert?.({
        type: 'error',
        title: 'Dev Server Failed',
        description: error.header,
        content: error.output,
      });

      // re-throw the error to be caught in the promise chain
      throw error;
    }
  }

  async #runShellAction(actionId: string, action: ActionState) {
    if (action.type !== 'shell') {
      unreachable('Expected shell action');
    }

    /*
     * Flush any pending file syncs before running shell commands
     * This ensures files are written before commands that depend on them (e.g., npm install)
     */
    await this.#flushPendingFileSyncs();

    // Try to use provider abstraction if available (Vercel Sandbox)
    const provider = await this.#getProvider();

    // Use provider (Vercel Sandbox) if available and connected
    if (provider) {
      if (provider.status === 'connected') {
        logger.info(`[ActionRunner] Running shell command via Vercel: ${action.content.substring(0, 50)}...`);

        // Pre-validate command for common issues (skip for Vercel - it handles this better)
        const validationResult = await this.#validateShellCommand(action.content);

        if (validationResult.shouldModify && validationResult.modifiedCommand) {
          logger.debug(`Modified command: ${action.content} -> ${validationResult.modifiedCommand}`);
          action.content = validationResult.modifiedCommand;
        }

        // Parse command for provider execution
        const { cmd, args } = this.#parseCommand(action.content);

        let result;

        try {
          result = await provider.runCommand(cmd, args);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const is410Error =
            errorMessage.includes('410') ||
            errorMessage.includes('expired') ||
            errorMessage.includes('SANDBOX_EXPIRED');

          if (is410Error && this.#onSandboxExpired) {
            logger.warn('Sandbox expired during command, triggering auto-recovery', { cmd });
            await this.#onSandboxExpired();

            // After recovery, retry the command once
            logger.info('Retrying command after sandbox recovery', { cmd });
            result = await provider.runCommand(cmd, args);
          } else {
            throw error;
          }
        }

        logger.debug(`Provider shell response: [exit code:${result.exitCode}]`);

        // Capture output for both success and failure
        const output = result.stdout || result.stderr || '';

        // Store output in action state for LLM context
        this.#updateAction(actionId, { output });

        if (result.exitCode !== 0) {
          const enhancedError = this.#createEnhancedShellError(
            action.content,
            result.exitCode,
            result.stderr || result.stdout,
          );
          throw new ActionCommandError(enhancedError.title, enhancedError.details);
        }

        return;
      } else {
        // Provider exists but is not connected - fail with clear error
        logger.error(`[ActionRunner] Provider exists but is not connected (status: ${provider.status})`);
        throw new ActionCommandError(
          'Sandbox not connected',
          `Cannot execute command: ${action.content.substring(0, 50)}...\n\nThe sandbox is not connected (status: ${provider.status}). Please wait for the sandbox to reconnect or refresh the page.`,
        );
      }
    }

    // WebContainer fallback - only used when no provider is configured
    logger.info('[ActionRunner] Running shell command via WebContainer (no provider available)');

    const shell = this.#shellTerminal();
    await shell.ready();

    if (!shell || !shell.terminal || !shell.process) {
      unreachable('Shell terminal not found');
    }

    // Pre-validate command for common issues
    const validationResult = await this.#validateShellCommand(action.content);

    if (validationResult.shouldModify && validationResult.modifiedCommand) {
      logger.debug(`Modified command: ${action.content} -> ${validationResult.modifiedCommand}`);
      action.content = validationResult.modifiedCommand;
    }

    const resp = await shell.executeCommand(this.runnerId.get(), action.content, () => {
      logger.debug(`[${action.type}]:Aborting Action\n\n`, action);
      action.abort();
    });
    logger.debug(`${action.type} Shell Response: [exit code:${resp?.exitCode}]`);

    // Capture output for LLM context
    if (resp?.output) {
      this.#updateAction(actionId, { output: resp.output });
    }

    if (resp?.exitCode != 0) {
      const enhancedError = this.#createEnhancedShellError(action.content, resp?.exitCode, resp?.output);
      throw new ActionCommandError(enhancedError.title, enhancedError.details);
    }
  }

  /**
   * Parse a shell command string into command and arguments
   */
  #parseCommand(command: string): { cmd: string; args: string[] } {
    const trimmed = command.trim();

    // Handle quoted arguments
    const parts: string[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';

    for (let i = 0; i < trimmed.length; i++) {
      const char = trimmed[i];

      if (!inQuote && (char === '"' || char === "'")) {
        inQuote = true;
        quoteChar = char;

        if (current) {
          parts.push(current);
        }

        current = '';
      } else if (inQuote && char === quoteChar) {
        inQuote = false;
        parts.push(current);
        current = '';
      } else if (!inQuote && /\s/.test(char)) {
        if (current) {
          parts.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }

    if (current) {
      parts.push(current);
    }

    const cmd = parts[0] || trimmed;
    const args = parts.slice(1);

    return { cmd, args };
  }

  async #runStartAction(action: ActionState) {
    if (action.type !== 'start') {
      unreachable('Expected start action');
    }

    // Try to use provider abstraction if available (Vercel Sandbox)
    const provider = await this.#getProvider();

    // Debug logging for provider routing
    console.log('[ActionRunner] Start action routing check', {
      hasProvider: !!provider,
      providerType: provider?.type,
      providerStatus: provider?.status,
      command: action.content.substring(0, 50),
      timestamp: Date.now(),
    });

    if (provider && provider.status === 'connected') {
      console.log(`[ActionRunner] 🚀 Running start command via Vercel Sandbox: ${action.content.substring(0, 50)}...`);

      try {
        // Parse command for provider execution
        const { cmd, args } = this.#parseCommand(action.content);

        // Fire and forget for dev server (it runs indefinitely)
        provider.runCommand(cmd, args).catch((error) => {
          logger.error('Provider start command failed:', error);
        });

        // Return immediately (dev server runs in background)
        return;
      } catch (error) {
        logger.warn('Provider start command setup failed, falling back to WebContainer', error);

        // Fall through to WebContainer
      }
    }

    // Fallback to WebContainer
    console.log('[ActionRunner] Falling back to WebContainer for start command');

    if (!this.#shellTerminal) {
      unreachable('Shell terminal not found');
    }

    const shell = this.#shellTerminal();
    await shell.ready();

    if (!shell || !shell.terminal || !shell.process) {
      unreachable('Shell terminal not found');
    }

    const resp = await shell.executeCommand(this.runnerId.get(), action.content, () => {
      logger.debug(`[${action.type}]:Aborting Action\n\n`, action);
      action.abort();
    });
    logger.debug(`${action.type} Shell Response: [exit code:${resp?.exitCode}]`);

    if (resp?.exitCode != 0) {
      throw new ActionCommandError('Failed To Start Application', resp?.output || 'No Output Available');
    }

    return;
  }

  async #runFileAction(action: ActionState) {
    if (action.type !== 'file') {
      unreachable('Expected file action');
    }

    try {
      // Use FilesStore to save file (handles optimistic updates, cloud sync, and local fallback)
      const { workbenchStore } = await import('~/lib/stores/workbench');
      logger.info('[ActionRunner] Calling saveFile', { filePath: action.filePath });
      await workbenchStore.filesStore.saveFile(action.filePath, action.content);
    } catch (error) {
      logger.error('Failed to run file action\n\n', error);
    }
  }

  async #runEditAction(action: ActionState) {
    if (action.type !== 'edit') {
      unreachable('Expected edit action');
    }

    const provider = await this.#getProvider();
    const useProvider = provider && provider.status === 'connected';
    const webcontainer = useProvider ? null : await this.#webcontainer;

    const { blocks, errors } = parseEditBlocks(action.content);

    if (errors.length > 0) {
      logger.warn('Edit parsing warnings:', errors);
    }

    if (blocks.length === 0) {
      logger.warn('EditAction contains no valid edit blocks');
      this.onAlert?.({
        type: 'warning',
        title: 'No Edits Found',
        description: 'The edit action did not contain any valid SEARCH/REPLACE blocks.',
        content: action.content.slice(0, 200),
      });

      return;
    }

    const editsByFile = groupEditsByFile(blocks);
    const results: { filePath: string; applied: number; failed: number; strategies: string[] }[] = [];

    for (const [filePath, fileBlocks] of editsByFile) {
      const normalizedPath = filePath.startsWith('/') ? filePath.slice(1) : filePath;
      const relativePath = webcontainer
        ? nodePath.relative(webcontainer.workdir, nodePath.join(webcontainer.workdir, normalizedPath))
        : normalizedPath;

      let fileContent: string;

      try {
        if (useProvider && provider) {
          const content = await provider.readFile(relativePath);

          if (content === null) {
            throw new Error('File not found');
          }

          fileContent = content;
        } else if (webcontainer) {
          fileContent = await webcontainer.fs.readFile(relativePath, 'utf-8');
        } else {
          throw new Error('No provider or WebContainer available');
        }
      } catch (error) {
        logger.warn(`File not found for edit: ${relativePath}`, error);
        this.onAlert?.({
          type: 'error',
          title: 'Edit Failed',
          description: `File not found: ${filePath}`,
          content: 'The target file does not exist. Create it first with a file action.',
        });
        results.push({ filePath, applied: 0, failed: fileBlocks.length, strategies: [] });
        continue;
      }

      const sortedBlocks = sortEditsForApplication(fileBlocks, fileContent);

      let currentContent = fileContent;
      let applied = 0;
      let failed = 0;
      const strategies: string[] = [];
      let tree = ENABLE_AST_MATCHING ? await getAstContext(filePath, currentContent) : null;

      for (const block of sortedBlocks) {
        const result = applyEdit(currentContent, block, tree);

        if (result.success) {
          currentContent = result.newContent;
          applied++;
          strategies.push(result.strategy);

          if (ENABLE_AST_MATCHING) {
            tree = await getAstContext(filePath, currentContent);
          }

          logger.debug(`Edit applied (${result.strategy})`, {
            filePath,
            searchSnippet: block.searchContent.slice(0, 80),
          });
        } else {
          failed++;
          logger.warn('Failed to apply edit block', {
            filePath,
            searchSnippet: block.searchContent.slice(0, 120),
            error: result.error,
          });

          this.onAlert?.({
            type: 'error',
            title: 'Edit Match Failed',
            description: `Could not find matching code in ${filePath}`,
            content: `SEARCH block:\n${block.searchContent.slice(0, 300)}`,
          });
        }
      }

      if (applied > 0 && currentContent !== fileContent) {
        const { workbenchStore } = await import('~/lib/stores/workbench');
        await workbenchStore.filesStore.saveFile(filePath, currentContent);

        logger.info(`Edited ${filePath}: ${applied} edits applied`);
      }

      results.push({ filePath, applied, failed, strategies });
    }

    const totalApplied = results.reduce((sum, entry) => sum + entry.applied, 0);
    const totalFailed = results.reduce((sum, entry) => sum + entry.failed, 0);

    logger.info('Edit action complete', {
      totalApplied,
      totalFailed,
      files: results.length,
    });
  }

  #updateAction(id: string, newState: ActionStateUpdate) {
    const actions = this.actions.get();

    this.actions.setKey(id, { ...actions[id], ...newState });
  }

  async getFileHistory(filePath: string): Promise<FileHistory | null> {
    try {
      const provider = await this.#getProvider();
      const historyPath = this.#getHistoryPath(filePath);

      if (provider && provider.status === 'connected') {
        const content = await provider.readFile(historyPath);

        if (content === null) {
          return null;
        }

        return JSON.parse(content);
      }

      const webcontainer = await this.#webcontainer;
      const content = await webcontainer.fs.readFile(historyPath, 'utf-8');

      return JSON.parse(content);
    } catch (error) {
      logger.error('Failed to get file history:', error);
      return null;
    }
  }

  async saveFileHistory(filePath: string, history: FileHistory) {
    // const webcontainer = await this.#webcontainer;
    const historyPath = this.#getHistoryPath(filePath);

    await this.#runFileAction({
      type: 'file',
      filePath: historyPath,
      content: JSON.stringify(history),
      changeSource: 'auto-save',
    } as any);
  }

  #getHistoryPath(filePath: string) {
    return nodePath.join('.history', filePath);
  }

  async #runBuildAction(action: ActionState) {
    if (action.type !== 'build') {
      unreachable('Expected build action');
    }

    // Trigger build started alert
    this.onDeployAlert?.({
      type: 'info',
      title: 'Building Application',
      description: 'Building your application...',
      stage: 'building',
      buildStatus: 'running',
      deployStatus: 'pending',
      source: 'netlify',
    });

    // Try to use provider abstraction if available (Vercel Sandbox)
    const provider = await this.#getProvider();
    let exitCode: number | undefined;
    let output = '';

    if (provider && provider.status === 'connected') {
      logger.debug('Running build via provider');

      try {
        const result = await provider.runCommand('npm', ['run', 'build']);
        exitCode = result.exitCode;
        output = result.stdout + result.stderr;

        logger.debug(`Provider build response: [exit code:${exitCode}]`);
      } catch (error) {
        logger.warn('Provider build failed, falling back to WebContainer', error);

        // Fall through to WebContainer
        exitCode = undefined;
      }
    }

    // Fallback to WebContainer if provider not available or failed
    if (exitCode === undefined) {
      const webcontainer = await this.#webcontainer;

      // Create a new terminal specifically for the build
      const buildProcess = await webcontainer.spawn('npm', ['run', 'build']);

      buildProcess.output.pipeTo(
        new WritableStream({
          write(data) {
            output += data;
          },
        }),
      );

      exitCode = await buildProcess.exit;
    }

    if (exitCode !== 0) {
      // Trigger build failed alert
      this.onDeployAlert?.({
        type: 'error',
        title: 'Build Failed',
        description: 'Your application build failed',
        content: output || 'No build output available',
        stage: 'building',
        buildStatus: 'failed',
        deployStatus: 'pending',
        source: 'netlify',
      });

      throw new ActionCommandError('Build Failed', output || 'No Output Available');
    }

    // Trigger build success alert
    this.onDeployAlert?.({
      type: 'success',
      title: 'Build Completed',
      description: 'Your application was built successfully',
      stage: 'deploying',
      buildStatus: 'complete',
      deployStatus: 'running',
      source: 'netlify',
    });

    // Check for common build directories
    const commonBuildDirs = ['dist', 'build', 'out', 'output', '.next', 'public'];

    let buildDir = '';
    const workdir = '/home/project'; // Standard workdir for both providers

    // Try to find the first existing build directory
    for (const dir of commonBuildDirs) {
      const dirPath = nodePath.join(workdir, dir);

      try {
        // Use provider if available, otherwise WebContainer
        if (provider && provider.status === 'connected') {
          // For provider, check if directory exists using ls command
          const result = await provider.runCommand('ls', [dirPath]);

          if (result.exitCode === 0) {
            buildDir = dirPath;
            break;
          }
        } else {
          // WebContainer path
          const webcontainer = await this.#webcontainer;
          await webcontainer.fs.readdir(dirPath);
          buildDir = dirPath;
          break;
        }
      } catch {
        continue;
      }
    }

    // If no build directory was found, use the default (dist)
    if (!buildDir) {
      buildDir = nodePath.join(workdir, 'dist');
    }

    return {
      path: buildDir,
      exitCode,
      output,
    };
  }
  async handleSupabaseAction(action: SupabaseAction) {
    const { operation, content, filePath } = action;
    logger.debug('[Supabase Action]:', { operation, filePath, content });

    switch (operation) {
      case 'migration':
        if (!filePath) {
          throw new Error('Migration requires a filePath');
        }

        // Show alert for migration action
        this.onSupabaseAlert?.({
          type: 'info',
          title: 'Supabase Migration',
          description: `Create migration file: ${filePath}`,
          content,
          source: 'supabase',
        });

        // Only create the migration file
        await this.#runFileAction({
          type: 'file',
          filePath,
          content,
          changeSource: 'supabase',
        } as any);
        return { success: true };

      case 'query': {
        // Always show the alert and let the SupabaseAlert component handle connection state
        this.onSupabaseAlert?.({
          type: 'info',
          title: 'Supabase Query',
          description: 'Execute database query',
          content,
          source: 'supabase',
        });

        // The actual execution will be triggered from SupabaseChatAlert
        return { pending: true };
      }

      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
  }

  // Add this method declaration to the class
  handleDeployAction(
    stage: 'building' | 'deploying' | 'complete',
    status: ActionStatus,
    details?: {
      url?: string;
      error?: string;
      source?: 'netlify' | 'vercel' | 'github' | 'gitlab' | 'amplify' | 'cloudflare';
    },
  ): void {
    if (!this.onDeployAlert) {
      logger.debug('No deploy alert handler registered');
      return;
    }

    const alertType = status === 'failed' ? 'error' : status === 'complete' ? 'success' : 'info';

    const title =
      stage === 'building'
        ? 'Building Application'
        : stage === 'deploying'
          ? 'Deploying Application'
          : 'Deployment Complete';

    const description =
      status === 'failed'
        ? `${stage === 'building' ? 'Build' : 'Deployment'} failed`
        : status === 'running'
          ? `${stage === 'building' ? 'Building' : 'Deploying'} your application...`
          : status === 'complete'
            ? `${stage === 'building' ? 'Build' : 'Deployment'} completed successfully`
            : `Preparing to ${stage === 'building' ? 'build' : 'deploy'} your application`;

    const buildStatus =
      stage === 'building' ? status : stage === 'deploying' || stage === 'complete' ? 'complete' : 'pending';

    const deployStatus = stage === 'building' ? 'pending' : status;

    this.onDeployAlert({
      type: alertType,
      title,
      description,
      content: details?.error || '',
      url: details?.url,
      stage,
      buildStatus: buildStatus as any,
      deployStatus: deployStatus as any,
      source: details?.source || 'netlify',
    });
  }

  async #validateShellCommand(command: string): Promise<{
    shouldModify: boolean;
    modifiedCommand?: string;
    warning?: string;
  }> {
    const trimmedCommand = command.trim();

    // Handle rm commands that might fail due to missing files
    if (trimmedCommand.startsWith('rm ') && !trimmedCommand.includes(' -f')) {
      const rmMatch = trimmedCommand.match(/^rm\s+(.+)$/);

      if (rmMatch) {
        const filePaths = rmMatch[1].split(/\s+/);

        // Check if any of the files exist using WebContainer
        try {
          const webcontainer = await this.#webcontainer;
          const existingFiles = [];

          for (const filePath of filePaths) {
            if (filePath.startsWith('-')) {
              continue;
            } // Skip flags

            try {
              await webcontainer.fs.readFile(filePath);
              existingFiles.push(filePath);
            } catch {
              // File doesn't exist, skip it
            }
          }

          if (existingFiles.length === 0) {
            // No files exist, modify command to use -f flag to avoid error
            return {
              shouldModify: true,
              modifiedCommand: `rm -f ${filePaths.join(' ')}`,
              warning: 'Added -f flag to rm command as target files do not exist',
            };
          } else if (existingFiles.length < filePaths.length) {
            // Some files don't exist, modify to only remove existing ones with -f for safety
            return {
              shouldModify: true,
              modifiedCommand: `rm -f ${filePaths.join(' ')}`,
              warning: 'Added -f flag to rm command as some target files do not exist',
            };
          }
        } catch (error) {
          logger.debug('Could not validate rm command files:', error);
        }
      }
    }

    // Handle cd commands to non-existent directories
    if (trimmedCommand.startsWith('cd ')) {
      const cdMatch = trimmedCommand.match(/^cd\s+(.+)$/);

      if (cdMatch) {
        const targetDir = cdMatch[1].trim();

        try {
          const webcontainer = await this.#webcontainer;
          await webcontainer.fs.readdir(targetDir);
        } catch {
          return {
            shouldModify: true,
            modifiedCommand: `mkdir -p ${targetDir} && cd ${targetDir}`,
            warning: 'Directory does not exist, created it first',
          };
        }
      }
    }

    // Handle cp/mv commands with missing source files
    if (trimmedCommand.match(/^(cp|mv)\s+/)) {
      const parts = trimmedCommand.split(/\s+/);

      if (parts.length >= 3) {
        const sourceFile = parts[1];

        try {
          const webcontainer = await this.#webcontainer;
          await webcontainer.fs.readFile(sourceFile);
        } catch {
          return {
            shouldModify: false,
            warning: `Source file '${sourceFile}' does not exist`,
          };
        }
      }
    }

    return { shouldModify: false };
  }

  #createEnhancedShellError(
    command: string,
    exitCode: number | undefined,
    output: string | undefined,
  ): {
    title: string;
    details: string;
  } {
    const trimmedCommand = command.trim();
    const firstWord = trimmedCommand.split(/\s+/)[0];

    // Common error patterns and their explanations
    const errorPatterns = [
      {
        pattern: /cannot remove.*No such file or directory/,
        title: 'File Not Found',
        getMessage: () => {
          const fileMatch = output?.match(/'([^']+)'/);
          const fileName = fileMatch ? fileMatch[1] : 'file';

          return `The file '${fileName}' does not exist and cannot be removed.\n\nSuggestion: Use 'ls' to check what files exist, or use 'rm -f' to ignore missing files.`;
        },
      },
      {
        pattern: /No such file or directory/,
        title: 'File or Directory Not Found',
        getMessage: () => {
          if (trimmedCommand.startsWith('cd ')) {
            const dirMatch = trimmedCommand.match(/cd\s+(.+)/);
            const dirName = dirMatch ? dirMatch[1] : 'directory';

            return `The directory '${dirName}' does not exist.\n\nSuggestion: Use 'mkdir -p ${dirName}' to create it first, or check available directories with 'ls'.`;
          }

          return `The specified file or directory does not exist.\n\nSuggestion: Check the path and use 'ls' to see available files.`;
        },
      },
      {
        pattern: /Permission denied/,
        title: 'Permission Denied',
        getMessage: () =>
          `Permission denied for '${firstWord}'.\n\nSuggestion: The file may not be executable. Try 'chmod +x filename' first.`,
      },
      {
        pattern: /command not found/,
        title: 'Command Not Found',
        getMessage: () =>
          `The command '${firstWord}' is not available in WebContainer.\n\nSuggestion: Check available commands or use a package manager to install it.`,
      },
      {
        pattern: /Is a directory/,
        title: 'Target is a Directory',
        getMessage: () =>
          `Cannot perform this operation - target is a directory.\n\nSuggestion: Use 'ls' to list directory contents or add appropriate flags.`,
      },
      {
        pattern: /File exists/,
        title: 'File Already Exists',
        getMessage: () => `File already exists.\n\nSuggestion: Use a different name or add '-f' flag to overwrite.`,
      },
    ];

    // Try to match known error patterns
    for (const errorPattern of errorPatterns) {
      if (output && errorPattern.pattern.test(output)) {
        return {
          title: errorPattern.title,
          details: errorPattern.getMessage(),
        };
      }
    }

    // Generic error with suggestions based on command type
    let suggestion = '';

    if (trimmedCommand.startsWith('npm ')) {
      suggestion = '\n\nSuggestion: Try running "npm install" first or check package.json.';
    } else if (trimmedCommand.startsWith('git ')) {
      suggestion = "\n\nSuggestion: Check if you're in a git repository or if remote is configured.";
    } else if (trimmedCommand.match(/^(ls|cat|rm|cp|mv)/)) {
      suggestion = '\n\nSuggestion: Check file paths and use "ls" to see available files.';
    }

    return {
      title: `Command Failed (exit code: ${exitCode})`,
      details: `Command: ${trimmedCommand}\n\nOutput: ${output || 'No output available'}${suggestion}`,
    };
  }
}
