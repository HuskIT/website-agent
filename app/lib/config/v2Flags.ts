export interface V2Flags {
  mastraEnabled: boolean;
  waitingInsightsEnabled: boolean;
  workspaceEnabled: boolean;
  memoryEnabled: boolean;
}

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  return value.toLowerCase() === 'true';
}

export function getV2Flags(): V2Flags {
  return {
    mastraEnabled: parseBooleanEnv(process.env.V2_MASTRA_ENABLED, false),
    waitingInsightsEnabled: parseBooleanEnv(process.env.V2_WAITING_INSIGHTS_ENABLED, false),
    workspaceEnabled: parseBooleanEnv(process.env.V2_WORKSPACE_ENABLED, false),
    memoryEnabled: parseBooleanEnv(process.env.V2_MEMORY_ENABLED, false),
  };
}
