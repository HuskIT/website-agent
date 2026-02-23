import { LLMManager } from '~/lib/modules/llm/manager';
import type { IProviderSetting, ProviderInfo } from '~/types/model';
import { DEFAULT_PROVIDER_NAME } from '~/utils/defaults';

export interface ResolveMastraAgentModelInput {
  model: string;
  provider: ProviderInfo;
  env?: Env;
  apiKeys?: Record<string, string>;
  providerSettings?: Record<string, IProviderSetting>;
}

export function resolveMastraAgentModel(input: ResolveMastraAgentModelInput): unknown {
  const env = input.env ?? (process.env as unknown as Env);
  const manager = LLMManager.getInstance(env as unknown as Record<string, string>, {
    defaultProvider: DEFAULT_PROVIDER_NAME,
  });
  const providerName = input.provider?.name?.trim() || DEFAULT_PROVIDER_NAME;
  const provider = manager.getProvider(providerName) ?? manager.getDefaultProvider();

  return provider.getModelInstance({
    model: input.model,
    serverEnv: env,
    apiKeys: input.apiKeys,
    providerSettings: input.providerSettings,
  });
}
