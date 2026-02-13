import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import { atom, type WritableAtom } from 'nanostores';
import type { ITerminal } from '~/types/terminal';
import { newBoltShellProcess, newShellProcess } from '~/utils/shell';
import { coloredText } from '~/utils/terminal';
import { newVercelShellProcess, VercelShell } from '~/lib/sandbox/vercel-terminal';
import type { SandboxProvider } from '~/lib/sandbox/types';
import { workbenchStore } from './workbench';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('TerminalStore');

export class TerminalStore {
  #webcontainer: Promise<WebContainer>;
  #terminals: Array<{ terminal: ITerminal; process: WebContainerProcess }> = [];
  #boltTerminal = newBoltShellProcess();
  #vercelBoltTerminal: VercelShell | null = null;

  showTerminal: WritableAtom<boolean> = import.meta.hot?.data.showTerminal ?? atom(true);

  constructor(webcontainerPromise: Promise<WebContainer>) {
    this.#webcontainer = webcontainerPromise;

    if (import.meta.hot) {
      import.meta.hot.data.showTerminal = this.showTerminal;
    }
  }

  /**
   * Get the appropriate bolt terminal based on the active provider
   */
  get boltTerminal() {
    // Check if Vercel provider is active
    const provider = workbenchStore.sandboxProvider;

    if (provider?.type === 'vercel' && provider.status === 'connected') {
      if (!this.#vercelBoltTerminal) {
        this.#vercelBoltTerminal = newVercelShellProcess();
        this.#vercelBoltTerminal.setProvider(provider);
      } else {
        // Ensure provider is up to date
        this.#vercelBoltTerminal.setProvider(provider);
      }

      return this.#vercelBoltTerminal;
    }

    return this.#boltTerminal;
  }

  toggleTerminal(value?: boolean) {
    this.showTerminal.set(value !== undefined ? value : !this.showTerminal.get());
  }

  async attachBoltTerminal(terminal: ITerminal) {
    // Check if we should use Vercel
    const provider = workbenchStore.sandboxProvider;

    if (provider?.type === 'vercel' && provider.status === 'connected') {
      try {
        if (!this.#vercelBoltTerminal) {
          this.#vercelBoltTerminal = newVercelShellProcess();
        }

        await this.#vercelBoltTerminal.init(provider, terminal);
      } catch (error: any) {
        terminal.write(coloredText.red('Failed to spawn Vercel shell\n\n') + error.message);
        return;
      }
    } else {
      // Use WebContainer
      try {
        const wc = await this.#webcontainer;
        await this.#boltTerminal.init(wc, terminal);
      } catch (error: any) {
        terminal.write(coloredText.red('Failed to spawn bolt shell\n\n') + error.message);
        return;
      }
    }
  }

  async attachTerminal(terminal: ITerminal) {
    // Check if we should use Vercel
    const provider = workbenchStore.sandboxProvider;

    if (provider?.type === 'vercel' && provider.status === 'connected') {
      // For Vercel, we create a shell-like interface
      try {
        if (!this.#vercelBoltTerminal) {
          this.#vercelBoltTerminal = newVercelShellProcess();
        }

        await this.#vercelBoltTerminal.init(provider, terminal);
      } catch (error: any) {
        terminal.write(coloredText.red('Failed to spawn Vercel shell\n\n') + error.message);
        return;
      }
    } else {
      // Use WebContainer
      try {
        const shellProcess = await newShellProcess(await this.#webcontainer, terminal);
        this.#terminals.push({ terminal, process: shellProcess });
      } catch (error: any) {
        terminal.write(coloredText.red('Failed to spawn shell\n\n') + error.message);
        return;
      }
    }
  }

  onTerminalResize(cols: number, rows: number) {
    // WebContainer terminals support resize
    for (const { process } of this.#terminals) {
      process.resize({ cols, rows });
    }

    // Vercel shell doesn't support resize (commands are stateless)
  }

  async detachTerminal(terminal: ITerminal) {
    const terminalIndex = this.#terminals.findIndex((t) => t.terminal === terminal);

    if (terminalIndex !== -1) {
      const { process } = this.#terminals[terminalIndex];

      try {
        process.kill();
      } catch (error) {
        logger.warn('Failed to kill terminal process', { error });
      }
      this.#terminals.splice(terminalIndex, 1);
    }

    // For Vercel, there's no persistent process to kill
  }

  /**
   * Switch the terminal provider (called when switching between WebContainer and Vercel)
   */
  async switchProvider(provider: SandboxProvider | null): Promise<void> {
    if (provider?.type === 'vercel') {
      // Switching to Vercel
      if (!this.#vercelBoltTerminal) {
        this.#vercelBoltTerminal = newVercelShellProcess();
      }

      this.#vercelBoltTerminal.setProvider(provider);
    } else {
      // Switching to WebContainer
      this.#vercelBoltTerminal?.setProvider(null);
    }
  }
}
