/**
 * Zod Schemas for Sandbox API Routes
 * Feature: 001-sandbox-providers
 *
 * Defines request/response schemas for server-side Vercel Sandbox proxy routes.
 * All routes require authentication and project ownership verification.
 */

import { z } from 'zod';
import { DEFAULT_SANDBOX_TIMEOUT_MS, MIN_SANDBOX_TIMEOUT_MS, MAX_SANDBOX_TIMEOUT_MS } from './constants';

/*
 * =============================================================================
 * Common Schemas
 * =============================================================================
 */

export const ErrorResponseSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  details: z.unknown().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/*
 * =============================================================================
 * POST /api/sandbox/create
 * Creates a new Vercel Sandbox session for a project
 * =============================================================================
 */

export const CreateSandboxRequestSchema = z.object({
  projectId: z.string().uuid(),
  snapshotId: z.string().optional(), // Restore from this snapshot
  runtime: z.enum(['node22', 'node24', 'python3.13']).default('node22'),
  ports: z.array(z.number().int().min(1).max(65535)).default([3000, 5173]),
  timeout: z.number().int().min(MIN_SANDBOX_TIMEOUT_MS).max(MAX_SANDBOX_TIMEOUT_MS).default(DEFAULT_SANDBOX_TIMEOUT_MS),
});
export type CreateSandboxRequest = z.infer<typeof CreateSandboxRequestSchema>;

export const CreateSandboxResponseSchema = z.object({
  sandboxId: z.string(),
  status: z.enum(['pending', 'running']),
  previewUrls: z.record(z.number(), z.string().url()),
  timeout: z.number(),
  createdAt: z.string().datetime(),
});
export type CreateSandboxResponse = z.infer<typeof CreateSandboxResponseSchema>;

/*
 * =============================================================================
 * POST /api/sandbox/reconnect
 * Reconnect to an existing sandbox session
 * =============================================================================
 */

export const ReconnectSandboxRequestSchema = z.object({
  projectId: z.string().uuid(),
  sandboxId: z.string(),
  ports: z.array(z.number().int().min(1).max(65535)).default([3000, 5173]),
});
export type ReconnectSandboxRequest = z.infer<typeof ReconnectSandboxRequestSchema>;

export const ReconnectSandboxResponseSchema = z.object({
  success: z.boolean().optional(),
  status: z.enum(['pending', 'running', 'stopping', 'stopped', 'failed', 'not_found']),
  sandboxId: z.string().optional(),
  previewUrls: z.record(z.number(), z.string().url()).optional(),
  timeout: z.number().optional(),
  connectedAt: z.string().datetime().optional(),
});
export type ReconnectSandboxResponse = z.infer<typeof ReconnectSandboxResponseSchema>;

/*
 * =============================================================================
 * POST /api/sandbox/files
 * Write files to sandbox (batch operation)
 * =============================================================================
 */

export const WriteFilesRequestSchema = z.object({
  projectId: z.string().uuid(),
  sandboxId: z.string(),
  files: z.array(
    z.object({
      path: z.string().min(1),
      content: z.string(), // Base64 encoded for binary files
      encoding: z.enum(['utf8', 'base64']).default('utf8'),
    }),
  ),
});
export type WriteFilesRequest = z.infer<typeof WriteFilesRequestSchema>;

export const WriteFilesResponseSchema = z.object({
  success: z.boolean(),
  filesWritten: z.number(),
});
export type WriteFilesResponse = z.infer<typeof WriteFilesResponseSchema>;

/*
 * =============================================================================
 * GET /api/sandbox/files/:path
 * Read a single file from sandbox
 * =============================================================================
 */

export const ReadFileRequestSchema = z.object({
  projectId: z.string().uuid(),
  sandboxId: z.string(),
  path: z.string().min(1),
});
export type ReadFileRequest = z.infer<typeof ReadFileRequestSchema>;

export const ReadFileResponseSchema = z.object({
  content: z.string().nullable(), // null if file doesn't exist
  encoding: z.enum(['utf8', 'base64']),
  exists: z.boolean(),
});
export type ReadFileResponse = z.infer<typeof ReadFileResponseSchema>;

/*
 * =============================================================================
 * POST /api/sandbox/command
 * Execute a command (SSE streaming response)
 * =============================================================================
 */

export const RunCommandRequestSchema = z.object({
  projectId: z.string().uuid(),
  sandboxId: z.string(),
  cmd: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeout: z.number().int().min(1000).max(600000).optional(), // 1s - 10min
  sudo: z.boolean().default(false),
});
export type RunCommandRequest = z.infer<typeof RunCommandRequestSchema>;

// SSE Event types for command streaming
export const CommandSSEEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('output'),
    stream: z.enum(['stdout', 'stderr']),
    data: z.string(),
  }),
  z.object({
    type: z.literal('exit'),
    exitCode: z.number(),
  }),
  z.object({
    type: z.literal('error'),
    message: z.string(),
  }),
]);
export type CommandSSEEvent = z.infer<typeof CommandSSEEventSchema>;

/*
 * =============================================================================
 * POST /api/sandbox/snapshot
 * Create a snapshot of the sandbox
 * =============================================================================
 */

export const CreateSnapshotRequestSchema = z.object({
  projectId: z.string().uuid(),
  sandboxId: z.string(),
  summary: z.string().max(1000).optional(),
});
export type CreateSnapshotRequest = z.infer<typeof CreateSnapshotRequestSchema>;

export const CreateSnapshotResponseSchema = z.object({
  snapshotId: z.string(),
  vercelSnapshotId: z.string().nullable(), // Vercel's snapshot ID
  sizeBytes: z.number(),
  filesCount: z.number(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(), // Vercel snapshots expire in 7 days
});
export type CreateSnapshotResponse = z.infer<typeof CreateSnapshotResponseSchema>;

/*
 * =============================================================================
 * POST /api/sandbox/snapshot/:id/restore
 * Restore sandbox from a snapshot
 * =============================================================================
 */

export const RestoreSnapshotRequestSchema = z.object({
  projectId: z.string().uuid(),
  snapshotId: z.string(),
  useVercelSnapshot: z.boolean().default(true), // Try Vercel snapshot first
});
export type RestoreSnapshotRequest = z.infer<typeof RestoreSnapshotRequestSchema>;

export const RestoreSnapshotResponseSchema = z.object({
  success: z.boolean(),
  sandboxId: z.string(),
  restoredFrom: z.enum(['vercel_snapshot', 'files_backup']),
  previewUrls: z.record(z.number(), z.string().url()),
});
export type RestoreSnapshotResponse = z.infer<typeof RestoreSnapshotResponseSchema>;

/*
 * =============================================================================
 * GET /api/sandbox/status
 * Get current sandbox status
 * =============================================================================
 */

export const GetSandboxStatusRequestSchema = z.object({
  projectId: z.string().uuid(),
  sandboxId: z.string(),
});
export type GetSandboxStatusRequest = z.infer<typeof GetSandboxStatusRequestSchema>;

export const GetSandboxStatusResponseSchema = z.object({
  sandboxId: z.string(),
  status: z.enum(['pending', 'running', 'stopping', 'stopped', 'failed', 'snapshotting']),
  timeout: z.number(),
  expiresAt: z.string().datetime().optional(),
});
export type GetSandboxStatusResponse = z.infer<typeof GetSandboxStatusResponseSchema>;

/*
 * =============================================================================
 * POST /api/sandbox/extend
 * Extend sandbox timeout
 * =============================================================================
 */

export const ExtendTimeoutRequestSchema = z.object({
  projectId: z.string().uuid(),
  sandboxId: z.string(),
  duration: z.number().int().min(60000).max(3600000), // 1min - 1hr extension
});
export type ExtendTimeoutRequest = z.infer<typeof ExtendTimeoutRequestSchema>;

export const ExtendTimeoutResponseSchema = z.object({
  success: z.boolean(),
  newTimeout: z.number(), // New total remaining timeout
  expiresAt: z.string().datetime(),
});
export type ExtendTimeoutResponse = z.infer<typeof ExtendTimeoutResponseSchema>;

/*
 * =============================================================================
 * POST /api/sandbox/stop
 * Stop the sandbox (triggers auto-snapshot)
 * =============================================================================
 */

export const StopSandboxRequestSchema = z.object({
  projectId: z.string().uuid(),
  sandboxId: z.string(),
  createSnapshot: z.boolean().default(true),
});
export type StopSandboxRequest = z.infer<typeof StopSandboxRequestSchema>;

export const StopSandboxResponseSchema = z.object({
  success: z.boolean(),
  snapshotId: z.string().nullable(), // null if createSnapshot was false
});
export type StopSandboxResponse = z.infer<typeof StopSandboxResponseSchema>;

/*
 * =============================================================================
 * User Preference Routes
 * =============================================================================
 */

// PATCH /api/user/sandbox-preference
export const UpdateSandboxPreferenceRequestSchema = z.object({
  preferredProvider: z.enum(['webcontainer', 'vercel']),
});
export type UpdateSandboxPreferenceRequest = z.infer<typeof UpdateSandboxPreferenceRequestSchema>;

export const UpdateSandboxPreferenceResponseSchema = z.object({
  success: z.boolean(),
  preferredProvider: z.enum(['webcontainer', 'vercel']),
});
export type UpdateSandboxPreferenceResponse = z.infer<typeof UpdateSandboxPreferenceResponseSchema>;
