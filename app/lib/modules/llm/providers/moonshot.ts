import { BaseProvider } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';
import type { LanguageModelV1 } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

/*
 * Simple hash function that works in both browser and Node.js
 * Uses a fast non-cryptographic hash (djb2) - sufficient for device ID generation
 */
function simpleHash(str: string): string {
  let hash = 5381;

  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }

  // Convert to hex string and ensure it's 32 chars
  const hexHash = (hash >>> 0).toString(16);

  return hexHash.padStart(8, '0').repeat(4).slice(0, 32);
}

// Generate a stable device ID from API key
function getDeviceIdFromApiKey(apiKey: string): string {
  return simpleHash(apiKey);
}

export default class MoonshotProvider extends BaseProvider {
  name = 'Moonshot';
  getApiKeyLink = 'https://platform.moonshot.ai/console/api-keys';

  config = {
    apiTokenKey: 'MOONSHOT_API_KEY',
  };

  staticModels: ModelInfo[] = [
    {
      name: 'kimi-for-coding',
      label: 'Kimi for Coding',
      provider: 'Moonshot',
      maxTokenAllowed: 256000,
      maxCompletionTokens: 32000,
    },
  ];

  getModelInstance(options: {
    model: string;
    serverEnv: Env;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
  }): LanguageModelV1 {
    const { model, serverEnv, apiKeys, providerSettings } = options;

    const { apiKey } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: providerSettings?.[this.name],
      serverEnv: serverEnv as any,
      defaultBaseUrlKey: '',
      defaultApiTokenKey: 'MOONSHOT_API_KEY',
    });

    if (!apiKey) {
      throw new Error(`Missing API key for ${this.name} provider`);
    }

    const openai = createOpenAI({
      baseURL: 'https://api.kimi.com/coding/v1',
      apiKey,
      headers: {
        'User-Agent': 'KimiCLI/1.3',
        'X-Msh-Platform': 'kimi_cli',
        'X-Msh-Version': '1.3.0',
        'X-Msh-Device-Name': 'huskit-website-agent',
        'X-Msh-Device-Model': 'Node.js Server',
        'X-Msh-Os-Version': typeof process !== 'undefined' ? process.version : 'unknown',
        'X-Msh-Device-Id': getDeviceIdFromApiKey(apiKey),
      },
    });

    return openai(model);
  }
}
