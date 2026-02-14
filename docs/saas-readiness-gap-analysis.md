# SaaS Readiness Gap Analysis

> **Date**: 2026-02-13
> **Project**: website-agent (bolt.diy fork) — AI-powered website builder SaaS
> **Stack**: Remix 2.15 + Vite, Cloudflare Pages, Supabase/PostgreSQL, Vercel AI SDK

---

## What Already Exists

| Area | Status | Details |
|------|--------|---------|
| **Authentication** | ✅ Implemented | Better Auth with Google OAuth + email/password, session management, user/tenant schema |
| **Multi-tenancy** | ✅ Basic | `tenant_id` on users, RLS policies in Supabase, tenant isolation for crawler service |
| **Project CRUD** | ✅ Implemented | Projects service with Supabase, 10-project soft limit per user |
| **Deployment** | ✅ Implemented | Cloudflare Workers, Vercel, Netlify, AWS Amplify deploy integrations |
| **AI/LLM** | ✅ Implemented | 19+ LLM providers, Vercel AI SDK, WebContainer runtime, Langfuse telemetry |
| **Security** | ⚠️ Partial | Rate limiting (in-memory only), security headers, CSP, HSTS, `withSecurity` wrapper |
| **User Profile** | ✅ Basic | Profile tab (username, bio, avatar), settings tab (language, notifications, timezone) |
| **Notifications** | ⚠️ Partial | Internal log-based notification system (no email) |
| **Landing Page** | ✅ Basic | Homepage with Terms/Privacy links (but no actual pages) |
| **Onboarding** | ✅ Implemented | Conversational business data collection flow |
| **Infrastructure** | ⚠️ Partial | Terraform directory exists, Docker support, `wrangler.toml` for Cloudflare |
| **Data Export** | ✅ Basic | Chat export via IndexedDB (`ImportExportService`) |
| **Telemetry** | ✅ Implemented | Langfuse for LLM token usage tracking |

---

## 🔴 CRITICAL — Blocks Launch

### 1. Billing & Subscriptions

**Status**: Not implemented — no Stripe, no subscription tiers, no usage metering, no invoicing.

**What to build**:
- Stripe Checkout + Customer Portal integration
- Products/prices configuration (free, pro, enterprise tiers)
- Subscription state sync via Stripe webhooks
- Plan-driven entitlement checks in API routes and UI
- Usage metering for LLM tokens, crawler runs, deployments, storage, project count
- Overage rules and upgrade prompts
- Invoice management

**Effort**: L–XL (3–5 days)

**Key files to create**:
- `app/lib/services/billing.server.ts` — Stripe service layer
- `app/routes/api.billing.*.ts` — Billing API routes
- `app/lib/services/entitlements.server.ts` — Plan enforcement
- `supabase/migrations/YYYYMMDD_billing_schema.sql` — subscriptions, usage tables

---

### 2. Transactional Email Service

**Status**: Not implemented — no email provider configured. Better Auth has email/password enabled but no mailer.

**What to build**:
- Email provider integration (Resend, SendGrid, or Postmark)
- Email templates: welcome, email verification, password reset, sign-in alerts, billing receipts
- Domain verification (SPF/DKIM/DMARC)
- Unsubscribe groups (transactional vs marketing)
- Email sending pipeline with retry logic

**Effort**: M–L (1–3 days)

**Key files to create**:
- `app/lib/services/email.server.ts` — Email service abstraction
- `app/lib/email-templates/` — Template directory

---

### 3. Password Reset + Email Verification

**Status**: Not implemented — `emailAndPassword.enabled` is `true` in Better Auth config, but no reset/verify flows exist.

**What to build**:
- Better Auth password reset flow (token generation, expiry, rate limits)
- Email verification flow on signup
- UI routes: `/auth/forgot-password`, `/auth/reset-password`, `/auth/verify-email`
- Secure error handling (no account enumeration)
- Integration with email service (item #2)

**Effort**: M (1–2 days)

**Key files to create**:
- `app/routes/auth.forgot-password.tsx`
- `app/routes/auth.reset-password.tsx`
- `app/routes/auth.verify-email.tsx`

---

### 4. Background Jobs / Async Processing

**Status**: Not implemented — no job queue, no cron jobs. Long-running tasks (crawling, LLM generation, deployments) run inline.

**What to build**:
- Queue + worker model for long/fragile tasks
- Options: **Cloudflare Queues + Workers** or **Supabase Edge Functions + scheduled triggers**
- Job types: crawler runs, LLM generation, deployment builds, ZIP generation, webhook processing, cleanup tasks
- Retry/backoff logic, dead-letter handling
- Job status tracking and UI feedback

**Effort**: L (2–4 days)

**Key files to create**:
- `app/lib/services/queue.server.ts` — Job queue abstraction
- `app/lib/workers/` — Worker handlers

---

### 5. Distributed Rate Limiting

**Status**: ⚠️ In-memory `Map()` in `app/lib/security.ts` — resets per instance, ineffective under scaling or deploys.

**What to build**:
- Move to distributed store: Cloudflare Durable Objects/KV, or Upstash Redis
- Per-user + per-tenant rate limit keys
- Separate policies for high-risk endpoints (LLM, deploy, crawler)
- Signup/login throttling
- Bot protection (Cloudflare Turnstile, enforced server-side)
- Burst + sustained rate limit policies

**Effort**: M–L (1–3 days)

**Current code**: `app/lib/security.ts` lines 4–65

---

### 6. Production Error Monitoring + Tracing

**Status**: Not implemented — no Sentry or APM. Errors only in console logs.

**What to build**:
- Sentry (or equivalent) for Remix + Cloudflare Workers
- Source map uploads for readable stack traces
- Release tracking and alerting rules
- Performance tracing for slow endpoints and LLM calls
- Error grouping and assignment

**Effort**: S–M (0.5–2 days)

**Key files to modify**:
- `app/entry.server.tsx` — Server error boundary
- `app/entry.client.tsx` — Client error boundary
- `app/root.tsx` — Global error boundary

---

### 7. Persistent Audit Logging

**Status**: ⚠️ Auth events logged via `console.log` in `app/lib/auth/auth.server.ts` — not durable or queryable.

**What to build**:
- Append-only audit log table in Supabase
- Schema: actor, tenant, action, target, IP, user agent, request ID, before/after metadata
- Log events: auth (login/logout/signup), project CRUD, deployments, billing changes, permission changes, API key operations, data deletion
- Retention policy (configurable per tenant/plan)
- Admin viewer/export UI
- Request ID correlation across logs

**Effort**: M–L (2–4 days)

**Key files to create**:
- `supabase/migrations/YYYYMMDD_audit_log.sql`
- `app/lib/services/auditLog.server.ts`

---

### 8. Legal Pages (Terms of Service + Privacy Policy)

**Status**: ⚠️ Links exist in login/signup/landing pages but point to `#` — no actual content.

**What to build**:
- `/terms` route with Terms of Service content
- `/privacy` route with Privacy Policy content
- Cookie/telemetry consent banner (if required by jurisdiction)
- DPA (Data Processing Agreement) page for B2B
- Ensure links in auth pages point to real routes

**Effort**: S–M (0.5–2 days for implementation; content drafting is separate)

**Key files to create**:
- `app/routes/terms.tsx`
- `app/routes/privacy.tsx`

---

### 9. Backups & Disaster Recovery

**Status**: ⚠️ No automated backup strategy documented. Supabase migrations exist but no restore runbook.

**What to build**:
- Automated Supabase/PostgreSQL backups (enable PITR if available)
- Restore runbook with tested procedure
- Migration process gate in CI (Drizzle migrations tracked)
- R2/S3 backup for workspace archives
- Regular backup verification schedule

**Effort**: M (1–3 days)

---

### 10. CSP / Security Hardening

**Status**: ⚠️ CSP in `app/lib/security.ts` allows `unsafe-eval` and broad `unsafe-inline`.

**What to build**:
- Remove or scope `unsafe-eval` (may need nonce-based CSP)
- Minimize `unsafe-inline` usage
- Verify `connect-src` includes only required endpoints (Supabase, LLM providers, Langfuse, deploy APIs)
- Ensure no secrets reach client bundles
- Add Subresource Integrity (SRI) for external scripts
- Regular security header audit

**Effort**: M (1–2 days)

**Current code**: `app/lib/security.ts` lines 83–121

---

## 🟠 HIGH — Needed Within First Month

### 1. RBAC / Permissions Model

**Status**: Basic `role` field exists on user table but no proper role-based access control.

**What to build**:
- Tenant roles: owner, admin, member, viewer
- Permission checks in Remix loaders/actions/services
- Policy-based authorization (not just role checks)
- Least-privilege audit for admin Supabase client usage
- Permission tests

**Effort**: M (2–3 days)

---

### 2. Organization / Team Management

**Status**: Not implemented — no team invites, no shared workspaces.

**What to build**:
- Organizations/teams data model
- Invite flow (email + link)
- Member management (add/remove/change role)
- Seat-based billing integration
- Project sharing within org
- Ownership transfer
- Leave/remove member flows

**Effort**: L (3–5 days)

---

### 3. Admin Dashboard / Internal Ops

**Status**: Not implemented — no admin panel. Only a local AI provider status dashboard exists.

**What to build**:
- Admin-only area (feature-gated)
- User/tenant/project management views
- Impersonation capability (with full audit trail)
- Quota overrides and plan management
- Crawler/deploy job inspection
- Abuse tooling (ban/suspend users)
- Revenue and usage dashboards

**Effort**: M–L (2–5 days)

---

### 4. Usage Quotas Enforcement Tied to Plans

**Status**: ⚠️ Crawler quota exists (`QuotaState` in `crawlerAgent.schema.ts`) but no general quota system tied to subscription plans.

**What to build**:
- Centralized entitlements + quotas module
- Enforce limits on every costly path:
  - LLM calls (tokens per month, requests per minute)
  - Crawler runs/pages per month
  - Deployment attempts/build minutes
  - Storage (snapshot size/count)
  - Project count (currently hardcoded to 10)
- Usage tracking dashboard for users
- Upgrade prompts when approaching limits

**Effort**: M–L (2–4 days)

---

### 5. Webhook Handling Reliability

**Status**: Not implemented — no webhook processing infrastructure.

**What to build**:
- Stripe webhook handler with signature verification
- Deploy provider webhook handlers
- Idempotency keys and replay protection
- Persistent webhook event storage
- Retry/backoff via job queue (item #4)
- Dead-letter handling and alerting
- Webhook event viewer in admin dashboard

**Effort**: M (1–3 days)

---

### 6. Secrets Management + Environment Hygiene

**Status**: ⚠️ Uses env vars via `getEnvConfig()` but no unified validation or rotation process.

**What to build**:
- Unified env validation per environment (dev/staging/prod)
- Secret rotation process and documentation
- Least-privilege service keys
- Encrypt sensitive provider tokens at rest
- Audit access to secrets
- Environment parity checks in CI

**Effort**: M (1–2 days)

---

### 7. Customer Support Operations

**Status**: Not implemented — `api.bug-report.ts` exists but no ticketing or support widget.

**What to build**:
- Support email setup
- In-app contact form / "Report a Problem" flow
- Ticketing integration (Zendesk, Intercom, or HelpScout)
- Request ID correlation for support debugging
- FAQ / help center content
- Status page integration

**Effort**: S–M (0.5–2 days)

---

### 8. GDPR / Data Lifecycle

**Status**: Not implemented — no account deletion, no comprehensive data export.

**What to build**:
- Self-serve account deletion flow
- Tenant data deletion (cascade)
- "Delete project" hard-delete option
- Data export of full account data (not just chat)
- Retention windows configuration
- DPA (Data Processing Agreement) page
- Subprocessor list page
- Data deletion confirmation emails
- Right to be forgotten compliance

**Effort**: M–L (2–4 days)

---

### 9. CI/CD Validation + Environments

**Status**: ⚠️ GitHub Actions may exist but coverage unknown. No staging environment documented.

**What to build**:
- CI pipeline: typecheck → lint → test → build
- Preview deployments per PR
- Migration safety checks (no destructive changes without review)
- Secret scanning (GitHub secret scanning / gitleaks)
- Dependency audit (npm audit / Snyk)
- Release tagging and changelog generation
- Staging environment with production parity
- Deployment rollback procedure

**Effort**: M (1–3 days)

---

## 🟡 MEDIUM — Needed for Growth

### 1. Custom Domains for Generated Websites

**What to build**: Custom domain management, DNS instructions, SSL issuance/verification, domain limits by plan, subdomain provisioning.

**Effort**: L (3–5 days)

---

### 2. Public API + API Keys

**What to build**: API key issuing + revocation, scoped permissions, per-key quotas, API documentation, SDK or examples.

**Effort**: M–L (2–5 days)

---

### 3. Feature Flags / Gradual Rollout

**What to build**: Feature flags table (keyed by tenant/user), cached evaluation, admin UI for flag management. Use for billing rollouts, new providers, deployment features.

**Effort**: M (1–2 days)

---

### 4. Product Analytics

**What to build**: Event tracking for onboarding funnel, activation, retention. Dashboards via PostHog, Amplitude, or GA. Ensure privacy consent alignment.

**Effort**: M (1–3 days)

---

### 5. Content Moderation / AI Safety

**What to build**: Policy checks for blocked categories, prompt-injection defenses for crawler inputs, safe rendering rules, malware/phishing prevention for generated content, abuse reporting flow.

**Effort**: M–L (2–4 days)

---

### 6. SLOs + Incident Readiness

**What to build**: Uptime checks, on-call alerting (PagerDuty/Opsgenie), runbooks, public status page, incident templates, error budget targets.

**Effort**: M (1–3 days)

---

### 7. Performance + Cost Controls

**What to build**: Caching strategy (CDN, API responses), request coalescing, LLM timeouts and max generation sizes, circuit breakers per provider, cost dashboards per tenant, emergency "kill switch" for spend spikes.

**Effort**: M–L (2–4 days)

---

## 🟢 LOW — Nice-to-Have / Polish

| # | Gap | Description | Effort |
|---|-----|-------------|--------|
| 1 | **2FA/MFA** | TOTP/WebAuthn, recovery codes, step-up auth for billing/admin | M–L |
| 2 | **SSO/SAML** | Enterprise SAML/OIDC login, SCIM provisioning | XL |
| 3 | **Advanced Admin Tools** | Tenant-level data exports, bulk operations, automated refunds | M–L |
| 4 | **Localization / i18n** | Translate auth/onboarding/emails, locale-aware formatting | M |
| 5 | **Accessibility Audit** | WCAG compliance, keyboard navigation, ARIA coverage for onboarding/chat/editor | M |

---

## Code-Level Launch Risks

### Rate Limiting (CRITICAL)
- **File**: `app/lib/security.ts` lines 4–65
- **Issue**: In-memory `Map()` resets per instance and on every deploy. Ineffective for serverless multi-instance. Unbounded memory growth under attack.
- **Risk**: LLM cost exposure from unauthenticated abuse.

### CSP Policy (CRITICAL)
- **File**: `app/lib/security.ts` lines 83–121
- **Issue**: `script-src 'unsafe-inline' 'unsafe-eval'` is overly permissive. `connect-src` doesn't include all LLM provider endpoints.
- **Risk**: XSS vulnerability surface area.

### Audit Logging (CRITICAL)
- **File**: `app/lib/auth/auth.server.ts` lines 62–97
- **Issue**: Auth events logged via `console.log` — not durable, not queryable, no correlation IDs.
- **Risk**: No forensic capability for security incidents.

### Project Limits (HIGH)
- **File**: `app/lib/services/projects.server.ts` lines 88–98
- **Issue**: Hardcoded 10-project limit, not driven by plan/entitlement.
- **Risk**: Conflicts with monetization strategy; cannot differentiate free vs paid tiers.

---

## Recommended Launch Checklist (Minimum Viable SaaS)

```
Priority 1 (Week 1):
  ☐ Stripe subscriptions + webhook sync + entitlement enforcement
  ☐ Email provider + email verification + password reset
  ☐ Sentry error monitoring

Priority 2 (Week 2):
  ☐ Background job queue (Cloudflare Queues or equivalent)
  ☐ Distributed rate limiting (KV/Durable Objects/Upstash)
  ☐ Persistent audit log table + service
  ☐ Legal pages (Terms, Privacy)
  ☐ GDPR basics (account deletion, data export)
  ☐ CSP hardening
  ☐ Backup/restore runbook

Priority 3 (Month 1):
  ☐ RBAC + permissions
  ☐ Admin dashboard
  ☐ Usage quotas tied to plans
  ☐ CI/CD pipeline hardening
  ☐ Customer support integration
```

---

## Architecture Considerations

### Billing Architecture (Recommended)
```
User → Stripe Checkout → Subscription Created
                              ↓
                    Stripe Webhook → api.billing.webhook.ts
                              ↓
                    Sync to subscriptions table
                              ↓
                    Entitlements service checks on every API call
```

### Background Jobs Architecture (Recommended)
```
API Route → Enqueue Job → Cloudflare Queue
                              ↓
                    Worker Consumer → Process Job
                              ↓
                    Update Status → Notify User (SSE/email)
```

### Audit Log Schema (Recommended)
```sql
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id),
  actor_id UUID REFERENCES "user"(id),
  action TEXT NOT NULL,           -- 'project.create', 'auth.login', etc.
  target_type TEXT,               -- 'project', 'user', 'deployment'
  target_id TEXT,
  metadata JSONB DEFAULT '{}',    -- before/after, extra context
  ip_address INET,
  user_agent TEXT,
  request_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_audit_tenant ON audit_logs(tenant_id, created_at DESC);
CREATE INDEX idx_audit_actor ON audit_logs(actor_id, created_at DESC);
```
