import { getDefaultFileMutationStrategy, type FileMutationStrategy } from '~/lib/mastra/strategies/fileMutation';
import {
  createBootstrapWebsiteWorkflow,
  type BootstrapWebsiteWorkflow,
} from '~/lib/mastra/workflows/bootstrapWebsite';
import { createEditWebsiteWorkflow, type EditWebsiteWorkflow } from '~/lib/mastra/workflows/editWebsite';

export interface MastraCore {
  mutationStrategy: FileMutationStrategy;
  bootstrapWebsite: BootstrapWebsiteWorkflow;
  editWebsite: EditWebsiteWorkflow;
}

export function createMastraCore(strategy: FileMutationStrategy = getDefaultFileMutationStrategy()): MastraCore {
  return {
    mutationStrategy: strategy,
    bootstrapWebsite: createBootstrapWebsiteWorkflow(strategy),
    editWebsite: createEditWebsiteWorkflow(strategy),
  };
}

