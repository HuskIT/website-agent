import type {
  FileMutationContext,
  FileMutationOperation,
  FileMutationResult,
  FileMutationStrategy,
} from '~/lib/mastra/strategies/fileMutation';
import { getDefaultFileMutationStrategy } from '~/lib/mastra/strategies/fileMutation';

export interface EditWebsiteInput {
  projectId: string;
  prompt: string;
  operations: FileMutationOperation[];
}

export interface EditWebsiteOutput {
  projectId: string;
  prompt: string;
  mutation: FileMutationResult;
  success: boolean;
}

export interface EditWebsiteWorkflow {
  id: 'editWebsite';
  mutationMode: FileMutationStrategy['mode'];
  run: (input: EditWebsiteInput, context: FileMutationContext) => Promise<EditWebsiteOutput>;
}

export function createEditWebsiteWorkflow(
  strategy: FileMutationStrategy = getDefaultFileMutationStrategy(),
): EditWebsiteWorkflow {
  return {
    id: 'editWebsite',
    mutationMode: strategy.mode,
    async run(input: EditWebsiteInput, context: FileMutationContext): Promise<EditWebsiteOutput> {
      const mutation = await strategy.mutate(input.operations, context);

      return {
        projectId: input.projectId,
        prompt: input.prompt,
        mutation,
        success: mutation.failures.length === 0,
      };
    },
  };
}
