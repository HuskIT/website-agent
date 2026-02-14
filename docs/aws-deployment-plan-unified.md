# Unified AWS Deployment Plan — Website Agent + Crawler

> Supersedes `aws-deployment-plan.md` — covers both HuskIT services in a single AWS infrastructure.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [AWS Architecture](#2-aws-architecture)
3. [Cost Estimate](#3-cost-estimate)
4. [Phase 0: Fix Crawler Dockerfile](#4-phase-0-fix-crawler-dockerfile)
5. [Phase 1: Migrate Website Agent to Node.js Server](#5-phase-1-migrate-website-agent-to-nodejs-server)
6. [Phase 2: AWS Infrastructure Setup](#6-phase-2-aws-infrastructure-setup)
7. [Phase 3: Deploy Both Services](#7-phase-3-deploy-both-services)
8. [Phase 4: CI/CD Pipeline](#8-phase-4-cicd-pipeline)
9. [Security Considerations](#9-security-considerations)
10. [Monitoring & Maintenance](#10-monitoring--maintenance)
11. [Scaling Strategy](#11-scaling-strategy)
12. [Deployment Checklist](#12-deployment-checklist)

---

## 1. System Overview

### Two Services

| | Website Agent | Crawler |
|---|---|---|
| **Repo** | `HuskIT/website-agent` | `HuskIT/crawler` |
| **Stack** | Remix 2.15 + Vite, Node.js 22, React 18 | FastAPI + Uvicorn, Python 3.12, Playwright/Chromium |
| **Port** | 5171 | 4999 |
| **Image Size** | ~800 MB | ~2–2.5 GB (Chromium) |
| **Task Size** | 1 vCPU / 2 GB | 2 vCPU / 4 GB |
| **Exposure** | Public (CloudFront → ALB) | Internal only (VPC private) |
| **Database** | Supabase (PostgreSQL, external) | MongoDB Atlas (external) |
| **External APIs** | 19+ LLM providers, Vercel, GitHub, R2 | SerpAPI, Google Vision, Gemini, Apify, Groq |
| **Communication** | Calls crawler via `CRAWLER_API_URL` | Receives HTTP requests from website-agent |

### How They Connect

```
User → CloudFront → ALB → Website Agent (ECS)
                              │
                              │ HTTP (VPC internal)
                              ▼
                        Crawler (ECS)
                              │
                    ┌─────────┼──────────┐
                    ▼         ▼          ▼
              MongoDB    SerpAPI    Google APIs
              Atlas      (ext)     Vision/Gemini
```

---

## 2. AWS Architecture

### Architecture Diagram

```
                         ┌──────────────┐
                         │  Route 53    │
                         │  DNS         │
                         └──────┬───────┘
                                │
                         ┌──────▼───────┐
                         │  CloudFront  │
                         │  (Global)    │
                         └──┬───────┬───┘
                            │       │
                   ┌────────▼──┐ ┌──▼──────────────┐
                   │ S3 Bucket │ │ ALB (public)     │
                   │ (static)  │ │ idle=300s        │
                   └───────────┘ └──┬───────────────┘
                                    │
                          ┌─────────▼─────────┐
                          │ ECS Cluster        │
                          │ (huskit-prod)      │
                          │                    │
                          │  ┌──────────────┐  │
                          │  │ Website Agent │  │ ← public via ALB
                          │  │ 1vCPU / 2GB  │  │
                          │  │ 2 tasks       │  │
                          │  └──────┬───────┘  │
                          │         │          │
                          │         │ :4999    │
                          │         ▼          │
                          │  ┌──────────────┐  │
                          │  │ Crawler      │  │ ← internal only
                          │  │ 2vCPU / 4GB  │  │
                          │  │ 1 task       │  │
                          │  └──────────────┘  │
                          └────────────────────┘
                                    │
                  ┌─────────────────┼─────────────────┐
                  ▼                 ▼                  ▼
            Supabase         MongoDB Atlas       External APIs
            (PostgreSQL)     (crawler_db)        (LLM, SerpAPI,
                                                  Vision, etc.)
```

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **ALB sharing** | Website Agent only | Crawler is internal-only; no second ALB needed ($25-60/mo saved) |
| **Service discovery** | AWS Cloud Map | Cheapest internal DNS; crawler registered as `crawler.internal` |
| **ECS cluster** | Shared | Same logical cluster, separate services for independent scaling |
| **NAT Gateway** | None | Tasks in public subnets with public IPs; saves ~$35/mo |
| **Crawler access** | Security group rules | Only website-agent SG can reach crawler SG on port 4999 |

### AWS Services

| Service | Purpose | Used By |
|---------|---------|---------|
| **ECS Fargate** | Container runtime | Both services |
| **ECR** | Docker image registry (2 repos) | Both services |
| **ALB** | Public load balancer (300s idle for SSE) | Website Agent only |
| **CloudFront** | Global CDN + TLS | Website Agent static + SSR |
| **S3** | Static asset hosting | Website Agent client bundle |
| **Cloud Map** | Service discovery (`crawler.internal`) | Crawler registration |
| **Route 53** | DNS | Public domain |
| **ACM** | TLS certificates | ALB + CloudFront |
| **Secrets Manager** | API keys + credentials | Both services |
| **CloudWatch** | Logs + metrics + alarms | Both services |
| **WAF** | Web Application Firewall | CloudFront |

---

## 3. Cost Estimate

### Monthly Breakdown (eu-central-1)

| Component | Low | High | Notes |
|-----------|-----|------|-------|
| **Website Agent Fargate** (1vCPU/2GB × 2 tasks) | $70 | $180 | 24/7 |
| **Crawler Fargate** (2vCPU/4GB × 1 task) | $120 | $200 | 24/7; scales to 2-4 during bursts |
| **ALB** | $25 | $60 | Includes LCUs for SSE connections |
| **CloudFront** | $20 | $100 | Depends on traffic volume; Asia egress costs more |
| **S3** (static assets) | $2 | $10 | Storage + requests |
| **ECR** (2 repos) | $5 | $15 | ~3 GB total images |
| **Secrets Manager** | $5 | $20 | ~20 secrets |
| **CloudWatch** | $10 | $50 | Logs + metrics |
| **Cloud Map** | $0.50 | $2 | DNS queries |
| **WAF** | $10 | $30 | Managed rules |
| **Total** | **$268** | **$667** | |
| **Realistic target** | | **$300–$450** | With optimization |

### Cost Optimization Levers

- **Fargate Spot for Crawler**: 50-70% savings on compute; tasks can be interrupted (acceptable for non-critical crawls)
- **Scale crawler to 0 overnight**: Scheduled scaling if no after-hours crawls needed
- **Aggressive static caching**: Reduces CloudFront origin requests
- **Log retention**: Set to 14-30 days instead of default
- **Reserved capacity**: Consider Savings Plans once usage stabilizes

---

## 4. Phase 0: Fix Crawler Dockerfile

The crawler has several issues that must be fixed before AWS deployment.

### 4.1 Fixed Dockerfile for Crawler

Create this as the production Dockerfile in `HuskIT/crawler`:

```dockerfile
# ---- build stage ----
FROM python:3.12-slim AS builder

WORKDIR /app

# Install system dependencies for Playwright/Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install missing dependencies (not in requirements.txt but used in code)
RUN pip install --no-cache-dir openai Pillow aiohttp

# Install Playwright/Chromium browser (MUST be RUN, not CMD)
RUN crawl4ai-setup

# Copy application code
COPY . .

# ---- production stage ----
FROM python:3.12-slim AS production

WORKDIR /app

# Install runtime system dependencies for Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libatspi2.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libwayland-client0 \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Copy installed packages and browser from builder
COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin
COPY --from=builder /root/.cache /root/.cache
COPY --from=builder /app /app

ENV PYTHONUNBUFFERED=1
ENV PORT=4999

EXPOSE 4999

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:4999/health || exit 1

# Override app.py's host binding — use 0.0.0.0 and disable reload
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "4999", "--workers", "1", "--timeout-keep-alive", "300"]
```

### 4.2 Required Code Changes in Crawler

**app.py** — Fix the `__main__` block (for local dev, production uses CMD):

```python
if __name__ == "__main__":
    import os
    uvicorn.run(
        "app:app",
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "4999")),
        reload=os.getenv("NODE_ENV", "development") == "development",
    )
```

**requirements.txt** — Add missing dependencies:

```
openai>=1.0.0
Pillow>=10.0.0
aiohttp>=3.9.0
```

---

## 5. Phase 1: Migrate Website Agent to Node.js Server

> See the original `aws-deployment-plan.md` Phase 0 for full details. Summary below.

### 5.1 Create `server.ts`

```typescript
import { createRequestHandler } from '@remix-run/express';
import compression from 'compression';
import express from 'express';
import morgan from 'morgan';

const app = express();
app.set('trust proxy', true);

app.use(compression({
  filter: (req, res) => {
    if (res.getHeader('Content-Type')?.toString().includes('text/event-stream')) {
      return false;
    }
    return compression.filter(req, res);
  },
}));

app.disable('x-powered-by');

// COEP/COOP for WebContainer
app.use((req, res, next) => {
  if (!req.path.startsWith('/webcontainer/vercel-preview')) {
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use('/assets', express.static('build/client/assets', { immutable: true, maxAge: '1y' }));
app.use(express.static('build/client', { maxAge: '1h' }));

app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use(morgan('short'));

const build = await import('./build/server/index.js');
app.all('*', createRequestHandler({ build }));

const PORT = parseInt(process.env.PORT || '5171', 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
```

### 5.2 Update Website Agent Dockerfile

```dockerfile
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV HUSKY=0 CI=true
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml* ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm run build

FROM build AS prod-deps
RUN pnpm prune --prod --ignore-scripts

FROM node:22-bookworm-slim AS production
WORKDIR /app
ENV NODE_ENV=production PORT=5171 HOST=0.0.0.0
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
COPY --from=prod-deps /app/build /app/build
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/package.json /app/package.json
COPY --from=build /app/server.js /app/server.js
EXPOSE 5171
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD curl -fsS http://localhost:5171/healthz || exit 1
CMD ["node", "server.js"]
```

---

## 6. Phase 2: AWS Infrastructure Setup

### 6.1 Prerequisites

```bash
# Install AWS CLI
brew install awscli

# Configure
aws configure
# Region: eu-central-1
# Output: json

# Verify
aws sts get-caller-identity
```

### 6.2 Create ECR Repositories (both services)

```bash
# Website Agent
aws ecr create-repository \
  --repository-name huskit/website-agent \
  --region eu-central-1 \
  --image-scanning-configuration scanOnPush=true

# Crawler
aws ecr create-repository \
  --repository-name huskit/crawler \
  --region eu-central-1 \
  --image-scanning-configuration scanOnPush=true

# Save URIs
WEB_ECR=$(aws ecr describe-repositories --repository-names huskit/website-agent \
  --query 'repositories[0].repositoryUri' --output text)
CRAWLER_ECR=$(aws ecr describe-repositories --repository-names huskit/crawler \
  --query 'repositories[0].repositoryUri' --output text)
```

### 6.3 Create VPC + Subnets

```bash
# Create VPC
VPC_ID=$(aws ec2 create-vpc \
  --cidr-block 10.0.0.0/16 \
  --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=huskit-prod}]' \
  --query 'Vpc.VpcId' --output text)

aws ec2 modify-vpc-attribute --vpc-id $VPC_ID --enable-dns-hostnames
aws ec2 modify-vpc-attribute --vpc-id $VPC_ID --enable-dns-support

# Internet Gateway
IGW_ID=$(aws ec2 create-internet-gateway \
  --tag-specifications 'ResourceType=internet-gateway,Tags=[{Key=Name,Value=huskit-igw}]' \
  --query 'InternetGateway.InternetGatewayId' --output text)
aws ec2 attach-internet-gateway --vpc-id $VPC_ID --internet-gateway-id $IGW_ID

# Public subnets (2 AZs)
SUBNET_A=$(aws ec2 create-subnet \
  --vpc-id $VPC_ID --cidr-block 10.0.1.0/24 \
  --availability-zone eu-central-1a \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=huskit-public-a}]' \
  --query 'Subnet.SubnetId' --output text)

SUBNET_B=$(aws ec2 create-subnet \
  --vpc-id $VPC_ID --cidr-block 10.0.2.0/24 \
  --availability-zone eu-central-1b \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=huskit-public-b}]' \
  --query 'Subnet.SubnetId' --output text)

aws ec2 modify-subnet-attribute --subnet-id $SUBNET_A --map-public-ip-on-launch
aws ec2 modify-subnet-attribute --subnet-id $SUBNET_B --map-public-ip-on-launch

# Route table
RT_ID=$(aws ec2 create-route-table \
  --vpc-id $VPC_ID \
  --tag-specifications 'ResourceType=route-table,Tags=[{Key=Name,Value=huskit-public-rt}]' \
  --query 'RouteTable.RouteTableId' --output text)

aws ec2 create-route --route-table-id $RT_ID --destination-cidr-block 0.0.0.0/0 --gateway-id $IGW_ID
aws ec2 associate-route-table --subnet-id $SUBNET_A --route-table-id $RT_ID
aws ec2 associate-route-table --subnet-id $SUBNET_B --route-table-id $RT_ID
```

### 6.4 Create Security Groups

```bash
# ALB Security Group (public HTTPS)
ALB_SG=$(aws ec2 create-security-group \
  --group-name huskit-alb-sg \
  --description "Public ALB - HTTPS only" \
  --vpc-id $VPC_ID \
  --query 'GroupId' --output text)

aws ec2 authorize-security-group-ingress --group-id $ALB_SG \
  --protocol tcp --port 443 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id $ALB_SG \
  --protocol tcp --port 80 --cidr 0.0.0.0/0

# Website Agent Security Group
WEB_SG=$(aws ec2 create-security-group \
  --group-name huskit-web-sg \
  --description "Website Agent tasks" \
  --vpc-id $VPC_ID \
  --query 'GroupId' --output text)

# Allow ALB → Website Agent on port 5171
aws ec2 authorize-security-group-ingress --group-id $WEB_SG \
  --protocol tcp --port 5171 --source-group $ALB_SG

# Crawler Security Group (internal only)
CRAWLER_SG=$(aws ec2 create-security-group \
  --group-name huskit-crawler-sg \
  --description "Crawler tasks - internal only" \
  --vpc-id $VPC_ID \
  --query 'GroupId' --output text)

# Allow ONLY Website Agent → Crawler on port 4999
aws ec2 authorize-security-group-ingress --group-id $CRAWLER_SG \
  --protocol tcp --port 4999 --source-group $WEB_SG
```

### 6.5 Create Service Discovery (Cloud Map)

```bash
# Create private DNS namespace
NAMESPACE_ID=$(aws servicediscovery create-private-dns-namespace \
  --name internal \
  --vpc $VPC_ID \
  --region eu-central-1 \
  --query 'OperationId' --output text)

# Wait for operation to complete, then get namespace ID
# aws servicediscovery get-operation --operation-id $NAMESPACE_ID

# Create service registration for crawler
DISCOVERY_SERVICE=$(aws servicediscovery create-service \
  --name crawler \
  --namespace-id $NAMESPACE_ID \
  --dns-config 'NamespaceId='$NAMESPACE_ID',DnsRecords=[{Type=A,TTL=10}]' \
  --health-check-custom-config FailureThreshold=1 \
  --query 'Service.Id' --output text)
```

The crawler will be reachable at: `http://crawler.internal:4999`

### 6.6 Create S3 Bucket for Static Assets

```bash
aws s3 mb s3://huskit-static-assets-prod --region eu-central-1

aws s3api put-public-access-block \
  --bucket huskit-static-assets-prod \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

### 6.7 Create Secrets

```bash
# Website Agent secrets
aws secretsmanager create-secret \
  --name huskit/prod/website-agent \
  --region eu-central-1 \
  --secret-string '{
    "DATABASE_URL": "postgresql://...",
    "SUPABASE_URL": "https://xxx.supabase.co",
    "SUPABASE_SERVICE_KEY": "...",
    "OPENAI_API_KEY": "sk-...",
    "ANTHROPIC_API_KEY": "sk-ant-...",
    "GOOGLE_GENERATIVE_AI_API_KEY": "...",
    "OPEN_ROUTER_API_KEY": "sk-or-...",
    "R2_ENDPOINT": "https://xxx.r2.cloudflarestorage.com",
    "R2_ACCESS_KEY": "...",
    "R2_SECRET_KEY": "...",
    "R2_BUCKET": "site-snapshots",
    "GOOGLE_PLACES_API_KEY": "...",
    "VERCEL_TOKEN": "...",
    "VERCEL_TEAM_ID": "...",
    "VERCEL_PROJECT_ID": "...",
    "LANGFUSE_SECRET_KEY": "sk-lf-...",
    "LANGFUSE_PUBLIC_KEY": "pk-lf-...",
    "BETTER_AUTH_SECRET": "..."
  }'

# Crawler secrets
aws secretsmanager create-secret \
  --name huskit/prod/crawler \
  --region eu-central-1 \
  --secret-string '{
    "SERPAPI_API_KEY": "...",
    "GOOGLE_VISION_API_KEY": "...",
    "GOOGLE_GEMINI_API_KEY": "...",
    "MONGODB_URI": "mongodb+srv://...",
    "APIFY_API_TOKEN": "...",
    "GROQ_API_KEY": "...",
    "DEEPSEEK_API_KEY": "..."
  }'
```

### 6.8 Create ECS Cluster

```bash
aws ecs create-cluster --cluster-name huskit-prod

# CloudWatch Log Groups
aws logs create-log-group --log-group-name /ecs/huskit-website-agent
aws logs put-retention-policy --log-group-name /ecs/huskit-website-agent --retention-in-days 30

aws logs create-log-group --log-group-name /ecs/huskit-crawler
aws logs put-retention-policy --log-group-name /ecs/huskit-crawler --retention-in-days 30
```

### 6.9 Create IAM Roles

**ECS Execution Role** (shared — pulls images, reads secrets):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": [
        "arn:aws:logs:eu-central-1:ACCOUNT_ID:log-group:/ecs/huskit-*:*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/*"
    }
  ]
}
```

**Trust policy** for both roles:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "ecs-tasks.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

### 6.10 Create ALB

```bash
# Create ALB
ALB_ARN=$(aws elbv2 create-load-balancer \
  --name huskit-alb \
  --subnets $SUBNET_A $SUBNET_B \
  --security-groups $ALB_SG \
  --scheme internet-facing \
  --type application \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text)

# Set 300s idle timeout for SSE streaming
aws elbv2 modify-load-balancer-attributes \
  --load-balancer-arn $ALB_ARN \
  --attributes Key=idle_timeout.timeout_seconds,Value=300

# Target group for Website Agent
TG_ARN=$(aws elbv2 create-target-group \
  --name huskit-web-tg \
  --protocol HTTP --port 5171 \
  --vpc-id $VPC_ID \
  --target-type ip \
  --health-check-path /healthz \
  --health-check-interval-seconds 30 \
  --health-check-timeout-seconds 10 \
  --healthy-threshold-count 2 \
  --unhealthy-threshold-count 3 \
  --query 'TargetGroups[0].TargetGroupArn' --output text)

# HTTPS listener (requires ACM cert)
aws elbv2 create-listener \
  --load-balancer-arn $ALB_ARN \
  --protocol HTTPS --port 443 \
  --certificates CertificateArn=arn:aws:acm:eu-central-1:ACCOUNT_ID:certificate/CERT_ID \
  --default-actions Type=forward,TargetGroupArn=$TG_ARN

# HTTP → HTTPS redirect
aws elbv2 create-listener \
  --load-balancer-arn $ALB_ARN \
  --protocol HTTP --port 80 \
  --default-actions Type=redirect,RedirectConfig='{Protocol=HTTPS,Port=443,StatusCode=HTTP_301}'
```

---

## 7. Phase 3: Deploy Both Services

### 7.1 Website Agent Task Definition

Save as `task-def-website-agent.json`:

```json
{
  "family": "huskit-website-agent",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "1024",
  "memory": "2048",
  "executionRoleArn": "arn:aws:iam::ACCOUNT_ID:role/huskit-ecs-execution-role",
  "taskRoleArn": "arn:aws:iam::ACCOUNT_ID:role/huskit-ecs-task-role",
  "containerDefinitions": [
    {
      "name": "website-agent",
      "image": "ACCOUNT_ID.dkr.ecr.eu-central-1.amazonaws.com/huskit/website-agent:latest",
      "portMappings": [{ "containerPort": 5171, "protocol": "tcp" }],
      "essential": true,
      "environment": [
        { "name": "NODE_ENV", "value": "production" },
        { "name": "PORT", "value": "5171" },
        { "name": "HOST", "value": "0.0.0.0" },
        { "name": "VITE_LOG_LEVEL", "value": "info" },
        { "name": "CRAWLER_API_URL", "value": "http://crawler.internal:4999" },
        { "name": "SANDBOX_VERCEL_ENABLED", "value": "true" },
        { "name": "SANDBOX_PROVIDER_DEFAULT", "value": "vercel" },
        { "name": "LANGFUSE_ENABLED", "value": "true" }
      ],
      "secrets": [
        { "name": "DATABASE_URL", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/website-agent:DATABASE_URL::" },
        { "name": "SUPABASE_URL", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/website-agent:SUPABASE_URL::" },
        { "name": "SUPABASE_SERVICE_KEY", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/website-agent:SUPABASE_SERVICE_KEY::" },
        { "name": "OPENAI_API_KEY", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/website-agent:OPENAI_API_KEY::" },
        { "name": "ANTHROPIC_API_KEY", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/website-agent:ANTHROPIC_API_KEY::" },
        { "name": "GOOGLE_GENERATIVE_AI_API_KEY", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/website-agent:GOOGLE_GENERATIVE_AI_API_KEY::" },
        { "name": "OPEN_ROUTER_API_KEY", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/website-agent:OPEN_ROUTER_API_KEY::" },
        { "name": "R2_ENDPOINT", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/website-agent:R2_ENDPOINT::" },
        { "name": "R2_ACCESS_KEY", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/website-agent:R2_ACCESS_KEY::" },
        { "name": "R2_SECRET_KEY", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/website-agent:R2_SECRET_KEY::" },
        { "name": "R2_BUCKET", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/website-agent:R2_BUCKET::" },
        { "name": "VERCEL_TOKEN", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/website-agent:VERCEL_TOKEN::" },
        { "name": "VERCEL_TEAM_ID", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/website-agent:VERCEL_TEAM_ID::" },
        { "name": "VERCEL_PROJECT_ID", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/website-agent:VERCEL_PROJECT_ID::" },
        { "name": "BETTER_AUTH_SECRET", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/website-agent:BETTER_AUTH_SECRET::" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/huskit-website-agent",
          "awslogs-region": "eu-central-1",
          "awslogs-stream-prefix": "ecs"
        }
      },
      "healthCheck": {
        "command": ["CMD-SHELL", "curl -f http://localhost:5171/healthz || exit 1"],
        "interval": 15,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 30
      }
    }
  ]
}
```

### 7.2 Crawler Task Definition

Save as `task-def-crawler.json`:

```json
{
  "family": "huskit-crawler",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "2048",
  "memory": "4096",
  "ephemeralStorage": { "sizeInGiB": 30 },
  "executionRoleArn": "arn:aws:iam::ACCOUNT_ID:role/huskit-ecs-execution-role",
  "taskRoleArn": "arn:aws:iam::ACCOUNT_ID:role/huskit-ecs-task-role",
  "containerDefinitions": [
    {
      "name": "crawler",
      "image": "ACCOUNT_ID.dkr.ecr.eu-central-1.amazonaws.com/huskit/crawler:latest",
      "portMappings": [{ "containerPort": 4999, "protocol": "tcp" }],
      "essential": true,
      "environment": [
        { "name": "PYTHONUNBUFFERED", "value": "1" },
        { "name": "PORT", "value": "4999" },
        { "name": "MONGODB_DATABASE", "value": "crawler_db" },
        { "name": "CRAWL4AI_HEADLESS", "value": "True" },
        { "name": "CRAWL4AI_TIMEOUT", "value": "30" }
      ],
      "secrets": [
        { "name": "SERPAPI_API_KEY", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/crawler:SERPAPI_API_KEY::" },
        { "name": "GOOGLE_VISION_API_KEY", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/crawler:GOOGLE_VISION_API_KEY::" },
        { "name": "GOOGLE_GEMINI_API_KEY", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/crawler:GOOGLE_GEMINI_API_KEY::" },
        { "name": "MONGODB_URI", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/crawler:MONGODB_URI::" },
        { "name": "APIFY_API_TOKEN", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/crawler:APIFY_API_TOKEN::" },
        { "name": "GROQ_API_KEY", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/crawler:GROQ_API_KEY::" },
        { "name": "DEEPSEEK_API_KEY", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/crawler:DEEPSEEK_API_KEY::" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/huskit-crawler",
          "awslogs-region": "eu-central-1",
          "awslogs-stream-prefix": "ecs"
        }
      },
      "healthCheck": {
        "command": ["CMD-SHELL", "curl -f http://localhost:4999/health || exit 1"],
        "interval": 30,
        "timeout": 10,
        "retries": 3,
        "startPeriod": 45
      }
    }
  ]
}
```

### 7.3 Create ECS Services

```bash
# Register task definitions
aws ecs register-task-definition --cli-input-json file://task-def-website-agent.json
aws ecs register-task-definition --cli-input-json file://task-def-crawler.json

# Create Website Agent service (public via ALB)
aws ecs create-service \
  --cluster huskit-prod \
  --service-name website-agent \
  --task-definition huskit-website-agent \
  --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_A,$SUBNET_B],securityGroups=[$WEB_SG],assignPublicIp=ENABLED}" \
  --load-balancers "targetGroupArn=$TG_ARN,containerName=website-agent,containerPort=5171" \
  --deployment-configuration "minimumHealthyPercent=100,maximumPercent=200"

# Create Crawler service (internal only, with service discovery)
aws ecs create-service \
  --cluster huskit-prod \
  --service-name crawler \
  --task-definition huskit-crawler \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_A,$SUBNET_B],securityGroups=[$CRAWLER_SG],assignPublicIp=ENABLED}" \
  --service-registries "registryArn=$DISCOVERY_SERVICE_ARN" \
  --deployment-configuration "minimumHealthyPercent=0,maximumPercent=200"
```

### 7.4 CloudFront Distribution

```bash
# Create CloudFront distribution
# Origin 1: S3 bucket (static assets)
# Origin 2: ALB (SSR + API)
# Behaviors:
#   /assets/* → S3, immutable cache
#   /api/*   → ALB, no cache, all headers forwarded
#   /*       → ALB, no cache (SSR HTML)

aws cloudfront create-distribution --distribution-config file://cloudfront-config.json
```

---

## 8. Phase 4: CI/CD Pipeline

### GitHub Actions — Website Agent

Create `.github/workflows/deploy-website-agent.yml`:

```yaml
name: Deploy Website Agent

on:
  push:
    branches: [main]
    paths-ignore:
      - 'docs/**'
      - '*.md'

permissions:
  id-token: write
  contents: read

env:
  AWS_REGION: eu-central-1
  ECR_REPOSITORY: huskit/website-agent
  ECS_CLUSTER: huskit-prod
  ECS_SERVICE: website-agent
  S3_BUCKET: huskit-static-assets-prod

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm run typecheck
      - run: pnpm run test

  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::ACCOUNT_ID:role/github-actions-deploy
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to ECR
        id: ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build & push Docker image
        run: |
          docker build -t ${{ steps.ecr.outputs.registry }}/${{ env.ECR_REPOSITORY }}:${{ github.sha }} \
                        -t ${{ steps.ecr.outputs.registry }}/${{ env.ECR_REPOSITORY }}:latest \
                        --target production .
          docker push ${{ steps.ecr.outputs.registry }}/${{ env.ECR_REPOSITORY }}:${{ github.sha }}
          docker push ${{ steps.ecr.outputs.registry }}/${{ env.ECR_REPOSITORY }}:latest

      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm run build

      - name: Sync static assets to S3
        run: |
          aws s3 sync build/client/assets s3://$S3_BUCKET/assets/ \
            --cache-control "public,max-age=31536000,immutable" --delete
          aws s3 sync build/client s3://$S3_BUCKET/ \
            --cache-control "public,max-age=3600" --exclude "assets/*" --delete

      - name: Deploy to ECS
        run: |
          TASK_DEF=$(aws ecs describe-task-definition --task-definition huskit-website-agent --query 'taskDefinition' --output json)
          NEW_TASK_DEF=$(echo $TASK_DEF | jq \
            --arg IMAGE "${{ steps.ecr.outputs.registry }}/${{ env.ECR_REPOSITORY }}:${{ github.sha }}" \
            '.containerDefinitions[0].image = $IMAGE |
             del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy)')
          NEW_REV=$(aws ecs register-task-definition --cli-input-json "$NEW_TASK_DEF" --query 'taskDefinition.taskDefinitionArn' --output text)
          aws ecs update-service --cluster $ECS_CLUSTER --service $ECS_SERVICE --task-definition $NEW_REV --force-new-deployment
          aws ecs wait services-stable --cluster $ECS_CLUSTER --services $ECS_SERVICE
```

### GitHub Actions — Crawler

Create in the `HuskIT/crawler` repo as `.github/workflows/deploy.yml`:

```yaml
name: Deploy Crawler

on:
  push:
    branches: [main]

permissions:
  id-token: write
  contents: read

env:
  AWS_REGION: eu-central-1
  ECR_REPOSITORY: huskit/crawler
  ECS_CLUSTER: huskit-prod
  ECS_SERVICE: crawler

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::ACCOUNT_ID:role/github-actions-deploy
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to ECR
        id: ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build & push Docker image
        run: |
          docker build -t ${{ steps.ecr.outputs.registry }}/${{ env.ECR_REPOSITORY }}:${{ github.sha }} \
                        -t ${{ steps.ecr.outputs.registry }}/${{ env.ECR_REPOSITORY }}:latest \
                        --target production .
          docker push ${{ steps.ecr.outputs.registry }}/${{ env.ECR_REPOSITORY }}:${{ github.sha }}
          docker push ${{ steps.ecr.outputs.registry }}/${{ env.ECR_REPOSITORY }}:latest

      - name: Deploy to ECS
        run: |
          TASK_DEF=$(aws ecs describe-task-definition --task-definition huskit-crawler --query 'taskDefinition' --output json)
          NEW_TASK_DEF=$(echo $TASK_DEF | jq \
            --arg IMAGE "${{ steps.ecr.outputs.registry }}/${{ env.ECR_REPOSITORY }}:${{ github.sha }}" \
            '.containerDefinitions[0].image = $IMAGE |
             del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy)')
          NEW_REV=$(aws ecs register-task-definition --cli-input-json "$NEW_TASK_DEF" --query 'taskDefinition.taskDefinitionArn' --output text)
          aws ecs update-service --cluster $ECS_CLUSTER --service $ECS_SERVICE --task-definition $NEW_REV --force-new-deployment
          aws ecs wait services-stable --cluster $ECS_CLUSTER --services $ECS_SERVICE
```

---

## 9. Security Considerations

### Network Isolation

```
Internet → CloudFront → ALB (sg-alb) → Website Agent (sg-web) → Crawler (sg-crawler)
                                                                       ↓
                                                                  [No public access]
```

- Crawler has **zero public exposure** — only reachable from website-agent via VPC
- Security group chain enforces: Internet → ALB → Web → Crawler (no shortcuts)

### Secrets

| Category | Store | Notes |
|----------|-------|-------|
| LLM API keys | Secrets Manager | Per-service secrets (separate ARNs) |
| Database credentials | Secrets Manager | Supabase + MongoDB Atlas |
| VITE_* variables | Environment vars | Non-secret only (bundled into client) |
| GitHub deploy | OIDC (no keys stored) | IAM role assumed via GitHub identity |

### WAF Rules (CloudFront)

- AWS Managed Rules: Common Rule Set + Known Bad Inputs
- Rate limiting: `/api/*` at 100 req/5min per IP
- Auth endpoints: `/api/auth/*` at 20 req/5min per IP

### Application Security

- COEP/COOP headers for WebContainer (Express middleware)
- No secrets in VITE_* prefixed environment variables
- ECR image scanning on every push
- CloudWatch log sanitization (no API keys in logs)

---

## 10. Monitoring & Maintenance

### CloudWatch Alarms

| Alarm | Metric | Threshold |
|-------|--------|-----------|
| Web 5xx errors | ALB HTTPCode_Target_5XX_Count | > 10/min for 5 min |
| Web latency | ALB TargetResponseTime p95 | > 2s for 5 min |
| Web unhealthy | ALB HealthyHostCount | < 2 for 2 min |
| Web CPU | ECS CPUUtilization (website-agent) | > 80% for 10 min |
| Crawler CPU | ECS CPUUtilization (crawler) | > 70% for 5 min |
| Crawler memory | ECS MemoryUtilization (crawler) | > 85% for 5 min |
| Crawler unhealthy | ECS RunningTaskCount (crawler) | < 1 for 2 min |

### Auto-Scaling

```bash
# Website Agent: scale 2-6 tasks on CPU
aws application-autoscaling register-scalable-target \
  --service-namespace ecs \
  --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/huskit-prod/website-agent \
  --min-capacity 2 --max-capacity 6

aws application-autoscaling put-scaling-policy \
  --service-namespace ecs \
  --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/huskit-prod/website-agent \
  --policy-name web-cpu-tracking \
  --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration '{
    "TargetValue": 70,
    "PredefinedMetricSpecification": {"PredefinedMetricType": "ECSServiceAverageCPUUtilization"},
    "ScaleInCooldown": 300, "ScaleOutCooldown": 60
  }'

# Crawler: scale 1-3 tasks on CPU (heavier tasks, lower max)
aws application-autoscaling register-scalable-target \
  --service-namespace ecs \
  --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/huskit-prod/crawler \
  --min-capacity 1 --max-capacity 3

aws application-autoscaling put-scaling-policy \
  --service-namespace ecs \
  --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/huskit-prod/crawler \
  --policy-name crawler-cpu-tracking \
  --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration '{
    "TargetValue": 60,
    "PredefinedMetricSpecification": {"PredefinedMetricType": "ECSServiceAverageCPUUtilization"},
    "ScaleInCooldown": 300, "ScaleOutCooldown": 120
  }'
```

### Cost Budget

```bash
aws budgets create-budget --account-id ACCOUNT_ID --budget '{
  "BudgetName": "huskit-monthly",
  "BudgetLimit": {"Amount": "500", "Unit": "USD"},
  "TimeUnit": "MONTHLY",
  "BudgetType": "COST"
}' --notifications-with-subscribers '[
  {"Notification": {"NotificationType": "ACTUAL", "ComparisonOperator": "GREATER_THAN", "Threshold": 80, "ThresholdType": "PERCENTAGE"},
   "Subscribers": [{"SubscriptionType": "EMAIL", "Address": "team@huskit.com"}]}
]'
```

---

## 11. Scaling Strategy

### Current State (100 users)

| Service | Tasks | Size | Monthly Cost |
|---------|-------|------|-------------|
| Website Agent | 2 | 1 vCPU / 2 GB | ~$140 |
| Crawler | 1 | 2 vCPU / 4 GB | ~$150 |

### Growth (10k users, 6 months)

| Service | Tasks | Size | Monthly Cost |
|---------|-------|------|-------------|
| Website Agent | 3-6 | 1 vCPU / 2 GB | ~$210-$420 |
| Crawler | 1-3 | 2 vCPU / 4 GB | ~$150-$450 |

### Future Optimization (if budget pressure)

1. **Fargate Spot for Crawler**: 50-70% savings; acceptable since crawl interruptions can retry
2. **Scheduled scaling**: Scale crawler to 0 during off-hours if no overnight crawls needed
3. **Async queue pattern**: Move to SQS → Worker if crawler needs scale-to-zero or burst beyond 3 tasks
4. **ARM64 (Graviton)**: Switch to ARM task definitions for ~20% cost savings (requires ARM Docker builds)

---

## 12. Deployment Checklist

### Pre-flight

- [ ] Fix crawler Dockerfile (RUN crawl4ai-setup, WORKDIR, 0.0.0.0 binding)
- [ ] Add missing Python dependencies (openai, Pillow, aiohttp)
- [ ] Create website-agent `server.ts` (Express, replace Wrangler)
- [ ] Update website-agent Dockerfile (node server.js CMD)
- [ ] Test both Docker images locally

### AWS Setup

- [ ] Configure AWS CLI with credentials
- [ ] Create 2 ECR repositories (website-agent, crawler)
- [ ] Create VPC + 2 public subnets + Internet Gateway
- [ ] Create 3 security groups (ALB, web, crawler)
- [ ] Create Cloud Map private namespace (`internal`)
- [ ] Create Cloud Map service registration (`crawler.internal`)
- [ ] Create S3 bucket for static assets
- [ ] Create secrets in Secrets Manager (2 secrets)
- [ ] Create ECS cluster
- [ ] Create CloudWatch log groups (2)
- [ ] Create IAM roles (execution + task + GitHub OIDC)
- [ ] Create ACM certificate (regional for ALB + us-east-1 for CloudFront)
- [ ] Create ALB with 300s idle timeout
- [ ] Create target group for website-agent

### Deploy

- [ ] Push website-agent image to ECR
- [ ] Push crawler image to ECR
- [ ] Register both task definitions
- [ ] Create website-agent ECS service (with ALB)
- [ ] Create crawler ECS service (with service discovery)
- [ ] Create CloudFront distribution
- [ ] Configure Route 53 DNS
- [ ] Set up WAF rules

### Post-Deploy

- [ ] Set up auto-scaling for both services
- [ ] Create CloudWatch alarms
- [ ] Set up AWS Budget alerts
- [ ] Set up GitHub Actions CI/CD for both repos

### Validation

- [ ] Website loads with COEP/COOP headers
- [ ] WebContainer initializes and runs code
- [ ] SSE streaming works >30s for LLM responses
- [ ] Auth flow (sign up, login, logout) works
- [ ] Crawler endpoint reachable from website-agent (`curl http://crawler.internal:4999/health`)
- [ ] Crawler NOT reachable from public internet
- [ ] Full crawl pipeline works end-to-end
- [ ] CloudFront serves static assets with correct cache headers
