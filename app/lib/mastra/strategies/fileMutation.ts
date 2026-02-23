export type FileMutationMode = 'write_file' | 'edit_file';

export interface FileMutationOperation {
  path: string;
  content?: string;
  oldText?: string;
  newText?: string;
}

export interface FileMutationFailure {
  path: string;
  reason: string;
}

export interface FileMutationResult {
  mode: FileMutationMode;
  applied: number;
  failures: FileMutationFailure[];
}

export interface FileMutationContext {
  writeFile: (path: string, content: string) => Promise<void>;
  editFile?: (path: string, oldText: string, newText: string) => Promise<void>;
}

export interface FileMutationStrategy {
  readonly mode: FileMutationMode;
  mutate: (operations: FileMutationOperation[], context: FileMutationContext) => Promise<FileMutationResult>;
}

export class WriteFileStrategy implements FileMutationStrategy {
  readonly mode: FileMutationMode = 'write_file';

  async mutate(operations: FileMutationOperation[], context: FileMutationContext): Promise<FileMutationResult> {
    const failures: FileMutationFailure[] = [];
    let applied = 0;

    for (const operation of operations) {
      if (typeof operation.content !== 'string') {
        failures.push({
          path: operation.path,
          reason: 'Missing content for write_file operation',
        });
        continue;
      }

      await context.writeFile(operation.path, operation.content);
      applied += 1;
    }

    return {
      mode: this.mode,
      applied,
      failures,
    };
  }
}

export class EditFileStrategy implements FileMutationStrategy {
  readonly mode: FileMutationMode = 'edit_file';

  async mutate(operations: FileMutationOperation[], context: FileMutationContext): Promise<FileMutationResult> {
    const failures: FileMutationFailure[] = [];
    let applied = 0;

    if (!context.editFile) {
      return {
        mode: this.mode,
        applied,
        failures: operations.map((operation) => ({
          path: operation.path,
          reason: 'editFile is not available in current context',
        })),
      };
    }

    for (const operation of operations) {
      if (typeof operation.oldText !== 'string' || typeof operation.newText !== 'string') {
        failures.push({
          path: operation.path,
          reason: 'Missing oldText/newText for edit_file operation',
        });
        continue;
      }

      await context.editFile(operation.path, operation.oldText, operation.newText);
      applied += 1;
    }

    return {
      mode: this.mode,
      applied,
      failures,
    };
  }
}

export function getDefaultFileMutationStrategy(): FileMutationStrategy {
  return new WriteFileStrategy();
}

