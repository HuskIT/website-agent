import type {
  FileMutationContext,
  FileMutationOperation,
  FileMutationResult,
  FileMutationStrategy,
} from '~/lib/mastra/strategies/fileMutation';
import { getDefaultFileMutationStrategy } from '~/lib/mastra/strategies/fileMutation';

export interface BootstrapWebsiteInput {
  projectId: string;
  operations: FileMutationOperation[];
}

export interface BootstrapWebsiteOutput {
  projectId: string;
  mutation: FileMutationResult;
  success: boolean;
}

export interface BootstrapWebsiteWorkflow {
  id: 'bootstrapWebsite';
  mutationMode: FileMutationStrategy['mode'];
  run: (input: BootstrapWebsiteInput, context: FileMutationContext) => Promise<BootstrapWebsiteOutput>;
}

export function createBootstrapWebsiteWorkflow(
  strategy: FileMutationStrategy = getDefaultFileMutationStrategy(),
): BootstrapWebsiteWorkflow {
  return {
    id: 'bootstrapWebsite',
    mutationMode: strategy.mode,
    async run(input: BootstrapWebsiteInput, context: FileMutationContext): Promise<BootstrapWebsiteOutput> {
      const mutation = await strategy.mutate(input.operations, context);

      return {
        projectId: input.projectId,
        mutation,
        success: mutation.failures.length === 0,
      };
    },
  };
}
