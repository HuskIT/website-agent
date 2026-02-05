/**
 * Vercel Terminal
 * Feature: 001-sandbox-providers
 *
 * Provides a terminal interface that routes commands to Vercel Sandbox
 * instead of WebContainer. Mimics the BoltShell interface for compatibility.
 */

import { atom } from 'nanostores';
import type { ITerminal } from '~/types/terminal';
import type { SandboxProvider } from './types';
import { createScopedLogger } from '~/utils/logger';
import { coloredText } from '~/utils/terminal';

const logger = createScopedLogger('VercelTerminal');

export type ExecutionResult = { output: string; exitCode: number } | undefined;

interface VercelTerminalState {
  sessionId: string;
  active: boolean;
  executionPrms?: Promise<any>;
  abort?: () => void;
}

/**
 * VercelShell provides a terminal interface compatible with BoltShell
 * but routes commands to Vercel Sandbox instead of WebContainer.
 */
export class VercelShell {
  #provider: SandboxProvider | null = null;
  #terminal: ITerminal | undefined;
  #initialized = false;
  #readyPromise: Promise<void>;
  #resolveReady!: () => void;
  executionState = atom<VercelTerminalState | undefined>(undefined);
  #commandHistory: string[] = [];
  #historyIndex = -1;
  #currentPrompt = '$ ';

  constructor() {
    this.#readyPromise = new Promise((resolve) => {
      this.#resolveReady = resolve;
    });
  }

  /**
   * Set the Vercel provider to use for command execution
   */
  setProvider(provider: SandboxProvider | null): void {
    this.#provider = provider;

    if (provider && !this.#initialized) {
      this.#initialized = true;
      this.#resolveReady();
    }
  }

  /**
   * Wait for the shell to be ready
   */
  ready(): Promise<void> {
    return this.#readyPromise;
  }

  /**
   * Initialize the shell with a terminal
   */
  async init(provider: SandboxProvider, terminal: ITerminal): Promise<void> {
    this.#provider = provider;
    this.#terminal = terminal;
    this.#initialized = true;

    // Write welcome message
    terminal.write(
      coloredText.cyan('Vercel Sandbox Terminal\n') +
        coloredText.gray('Commands are executed on Vercel Sandbox (cloud)\n\n'),
    );

    // Set up input handling
    terminal.onData((data) => this.#handleInput(data));

    // Show initial prompt
    this.#showPrompt();

    this.#resolveReady();
  }

  /**
   * Execute a command (used by ActionRunner)
   */
  async executeCommand(sessionId: string, command: string, abort?: () => void): Promise<ExecutionResult> {
    if (!this.#provider || this.#provider.status !== 'connected') {
      return undefined;
    }

    const state = this.executionState.get();

    if (state?.active && state.abort) {
      state.abort();
    }

    // Parse and execute the command
    const { cmd, args } = this.#parseCommand(command);

    logger.debug('Executing command via Vercel', { cmd, args: args.join(' ') });

    // Start execution
    this.executionState.set({ sessionId, active: true, abort });

    try {
      const result = await this.#provider.runCommand(cmd, args);

      this.executionState.set({ sessionId, active: false });

      return {
        output: result.stdout + (result.stderr ? '\n' + result.stderr : ''),
        exitCode: result.exitCode,
      };
    } catch (error) {
      this.executionState.set({ sessionId, active: false });

      const errorMessage = error instanceof Error ? error.message : String(error);

      return {
        output: `Error: ${errorMessage}`,
        exitCode: 1,
      };
    }
  }

  /**
   * Get current execution result
   */
  async getCurrentExecutionResult(): Promise<ExecutionResult> {
    /*
     * For Vercel, commands are synchronous
     * This method is here for BoltShell compatibility
     */
    return undefined;
  }

  get terminal() {
    return this.#terminal;
  }

  get process() {
    // Return a mock process for compatibility
    return {
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      kill: () => {},
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      resize: () => {},
    } as any;
  }

  /**
   * Handle terminal input
   */
  #handleInput(data: string): void {
    if (!this.#terminal) {
      return;
    }

    // Handle special keys
    if (data === '\r' || data === '\n') {
      // Enter key - execute command
      this.#terminal.write('\r\n');
      this.#executeInteractiveCommand();
    } else if (data === '\x7f' || data === '\b') {
      // Backspace
      if (this.#currentCommand.length > 0) {
        this.#currentCommand = this.#currentCommand.slice(0, -1);
        this.#terminal.write('\b \b');
      }
    } else if (data === '\x03') {
      // Ctrl+C - abort
      this.#terminal.write('^C\r\n');
      this.#currentCommand = '';
      this.#showPrompt();
    } else if (data === '\x1b[A') {
      // Up arrow - previous command
      if (this.#historyIndex < this.#commandHistory.length - 1) {
        this.#historyIndex++;
        this.#currentCommand = this.#commandHistory[this.#commandHistory.length - 1 - this.#historyIndex] || '';
        this.#redrawLine();
      }
    } else if (data === '\x1b[B') {
      // Down arrow - next command
      if (this.#historyIndex > 0) {
        this.#historyIndex--;
        this.#currentCommand = this.#commandHistory[this.#commandHistory.length - 1 - this.#historyIndex] || '';
        this.#redrawLine();
      } else if (this.#historyIndex === 0) {
        this.#historyIndex = -1;
        this.#currentCommand = '';
        this.#redrawLine();
      }
    } else if (data.startsWith('\x1b')) {
      // Ignore other escape sequences
      return;
    } else if (data >= ' ' && data <= '~') {
      // Printable characters
      this.#currentCommand += data;
      this.#terminal.write(data);
    }
  }

  #currentCommand = '';

  /**
   * Execute the current interactive command
   */
  async #executeInteractiveCommand(): Promise<void> {
    if (!this.#terminal || !this.#provider) {
      return;
    }

    const command = this.#currentCommand.trim();
    this.#currentCommand = '';
    this.#historyIndex = -1;

    if (command) {
      // Add to history
      this.#commandHistory.push(command);

      if (this.#commandHistory.length > 100) {
        this.#commandHistory.shift();
      }

      // Handle built-in commands
      if (command === 'clear' || command === 'cls') {
        this.#terminal.reset();
        this.#showPrompt();

        return;
      }

      if (command === 'help') {
        this.#terminal.write(
          coloredText.cyan('Vercel Sandbox Terminal Commands:\n') +
            '  clear, cls  - Clear the terminal\n' +
            '  help        - Show this help\n' +
            '  pwd         - Show current directory\n' +
            '  ls          - List files\n' +
            '\n' +
            coloredText.gray('Any other command is executed on Vercel Sandbox\n'),
        );
        this.#showPrompt();

        return;
      }

      // Execute on Vercel
      try {
        const { cmd, args } = this.#parseCommand(command);
        logger.debug('Interactive command', { cmd, args: args.join(' ') });

        this.executionState.set({ sessionId: Date.now().toString(), active: true });

        const result = await this.#provider.runCommand(cmd, args);

        this.executionState.set({ sessionId: Date.now().toString(), active: false });

        // Write output
        if (result.stdout) {
          this.#terminal.write(result.stdout);

          if (!result.stdout.endsWith('\n')) {
            this.#terminal.write('\n');
          }
        }

        if (result.stderr) {
          this.#terminal.write(coloredText.red(result.stderr));

          if (!result.stderr.endsWith('\n')) {
            this.#terminal.write('\n');
          }
        }

        if (result.exitCode !== 0 && !result.stderr) {
          this.#terminal.write(coloredText.red(`Exit code: ${result.exitCode}\n`));
        }
      } catch (error) {
        this.executionState.set({ sessionId: Date.now().toString(), active: false });

        const errorMessage = error instanceof Error ? error.message : String(error);
        this.#terminal.write(coloredText.red(`Error: ${errorMessage}\n`));
      }
    }

    this.#showPrompt();
  }

  /**
   * Show the command prompt
   */
  #showPrompt(): void {
    if (this.#terminal) {
      this.#terminal.write(this.#currentPrompt);
    }
  }

  /**
   * Redraw the current line (for history navigation)
   */
  #redrawLine(): void {
    if (!this.#terminal) {
      return;
    }

    // Clear line and redraw
    this.#terminal.write('\r\x1b[K');
    this.#terminal.write(this.#currentPrompt + this.#currentCommand);
  }

  /**
   * Parse a command string into command and arguments
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
}

/**
 * Factory function for creating a VercelShell instance
 */
export function newVercelShellProcess() {
  return new VercelShell();
}
