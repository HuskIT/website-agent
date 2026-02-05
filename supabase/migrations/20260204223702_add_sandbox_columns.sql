-- Migration: Add sandbox provider support columns
-- Feature: 001-sandbox-providers
-- Date: 2026-02-04

-- Add sandbox session tracking to projects
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS sandbox_id TEXT,
  ADD COLUMN IF NOT EXISTS sandbox_provider VARCHAR(20) DEFAULT 'vercel',
  ADD COLUMN IF NOT EXISTS sandbox_expires_at TIMESTAMPTZ;

-- Add provider preference to users
ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS preferred_sandbox_provider VARCHAR(20) DEFAULT 'vercel';

-- Add Vercel snapshot reference to project_snapshots
ALTER TABLE project_snapshots
  ADD COLUMN IF NOT EXISTS vercel_snapshot_id TEXT;

-- Index for quick sandbox lookup
CREATE INDEX IF NOT EXISTS idx_projects_sandbox_id
  ON projects(sandbox_id)
  WHERE sandbox_id IS NOT NULL;

-- Check constraints
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_sandbox_provider'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT chk_sandbox_provider
      CHECK (sandbox_provider IN ('webcontainer', 'vercel'));
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_user_sandbox_provider'
  ) THEN
    ALTER TABLE "user"
      ADD CONSTRAINT chk_user_sandbox_provider
      CHECK (preferred_sandbox_provider IN ('webcontainer', 'vercel'));
  END IF;
END
$$;

-- Comments
COMMENT ON COLUMN projects.sandbox_id IS 'Active Vercel Sandbox session ID';
COMMENT ON COLUMN projects.sandbox_provider IS 'Current sandbox provider for this project';
COMMENT ON COLUMN projects.sandbox_expires_at IS 'When the active sandbox session expires';
COMMENT ON COLUMN "user".preferred_sandbox_provider IS 'User preference for sandbox provider';
COMMENT ON COLUMN project_snapshots.vercel_snapshot_id IS 'Vercel Sandbox snapshot ID for fast restore';
