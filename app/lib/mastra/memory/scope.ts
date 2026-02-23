export interface V2MemoryScope {
  resourceId: string;
  threadId: string;
}

export function buildBootstrapMemoryScope(projectId: string, sessionId: string): V2MemoryScope {
  return {
    resourceId: `project:${projectId}`,
    threadId: `bootstrap:${sessionId}`,
  };
}
