# AWS Deployment Plan — HuskIT Website Agent

## 1. Current Setup Analysis

| Aspect | Current State |
|--------|--------------|
| **Framework** | Remix 2.15 + Vite, React 18, TypeScript strict |
| **Runtime** | Wrangler/Cloudflare Pages dev proxy (local), Docker (Node.js 22, port 5171) |
| **Database** | Supabase (PostgreSQL) + Drizzle ORM, Better Auth for authentication, RLS |
| **Storage** | Cloudflare R2 (S3-compatible) for site snapshots |
| **AI/LLM** | 19+ providers via Vercel AI SDK — SSE streaming responses (30s+) |
| **Browser Runtime** | WebContainer API (requires COEP/COOP headers for SharedArrayBuffer) |
| **Sandbox** | Vercel Sandbox for cloud-based code execution |
| **External APIs** | Crawler API, Google Places, Langfuse, GitHub/Vercel/Netlify integrations |

### Key Constraints
- WebContainer requires `Cross-Origin-Embedder-Policy: require-corp` + `Cross-Origin-Opener-Policy: same-origin`
- SSE streaming for LLM responses — long-lived connections (30s+)
- Production Docker currently runs Wrangler (`pnpm run dockerstart`) — needs migration to Node.js server
- Many LLM provider API keys must be securely managed

---

## 2. Recommended AWS Architecture

### Region Strategy
- **Primary region:** `eu-central-1` (Frankfurt) — central EU, good Asia latency via CloudFront
- **Global reach:** CloudFront edge caching + TLS termination (EU + Asia PoPs)
- **Availability:** Multi-AZ within single region (99.9% uptime target)

### Architecture Diagram

```
                    ┌─────────────────────┐
                    │     Route 53        │
                    │  app.huskit.com     │
                    └─────────┬───────────┘
                              │
                    ┌─────────▼───────────┐
                    │     CloudFront      │
                    │   (Global CDN)      │
                    │                     │
                    │  Behaviors:         │
                    │  /build/* → S3      │
                    │  /api/*   → ALB     │
                    │  /*       → ALB     │
                    └──┬──────────┬───────┘
                       │          │
              ┌────────▼──┐  ┌───▼──────────────┐
              │  S3 Bucket │  │  ALB (HTTPS)     │
              │  (static   │  │  idle timeout:   │
              │   assets)  │  │  300s (for SSE)  │
              └────────────┘  └───┬──────────────┘
                                  │
                       ┌──────────▼──────────┐
                       │   ECS Fargate       │
                       │   (2+ tasks,        │
                       │    multi-AZ)        │
                       │                     │
                       │   Node.js Server    │
                       │   Remix SSR + API   │
                       └──────────┬──────────┘
                                  │
                    ┌─────────────┼─────────────┐
                    │             │             │
              ┌─────▼────┐ ┌─────▼────┐ ┌──────▼─────┐
              │ Supabase │ │ R2/S3    │ │ LLM APIs   │
              │ (DB)     │ │ (storage)│ │ (external) │
              └──────────┘ └──────────┘ └────────────┘
```

### AWS Services Required

| Service | Purpose | Estimated Monthly Cost |
|---------|---------|----------------------|
| **ECS Fargate** | SSR container runtime (2 tasks, 1 vCPU / 2GB each) | $70–$180 |
| **ALB** | Load balancer with SSE support (300s idle timeout) | $25–$60 |
| **CloudFront** | Global CDN, TLS termination, static asset caching | $20–$150 |
| **S3** | Static asset hosting (build/client) | $5–$20 |
| **ECR** | Docker image registry | $5–$10 |
| **Route 53** | DNS management | $1–$5 |
| **ACM** | TLS certificates (free) | $0 |
| **Secrets Manager** | API keys + credentials | $5–$30 |
| **CloudWatch** | Logs + metrics + alarms | $10–$80 |
| **WAF** | Web Application Firewall on CloudFront | $10–$30 |
| **Total** | | **$150–$350 initial, $300–$500 at 10k users** |

---

## 3. Detailed Deployment Steps

### Phase 0: Migrate from Wrangler to Node.js Server (CRITICAL)

The production Docker currently runs `wrangler pages dev` — this is a development server. We must switch to a proper Node.js server.

#### Step 0.1: Install Node.js adapter dependencies

```bash
pnpm add @remix-run/express express compression morgan
pnpm add -D @types/express @types/compression @types/morgan
```

#### Step 0.2: Create production server entry

Create `server.ts` at the project root:

```typescript
// server.ts — Production Node.js server for Remix SSR
import { createRequestHandler } from '@remix-run/express';
import compression from 'compression';
import express from 'express';
import morgan from 'morgan';

const app = express();

// Trust proxy (required behind ALB/CloudFront)
app.set('trust proxy', true);

// Compression for non-streaming responses
app.use(compression({
  filter: (req, res) => {
    // Don't compress SSE streams
    if (res.getHeader('Content-Type')?.toString().includes('text/event-stream')) {
      return false;
    }
    return compression.filter(req, res);
  },
}));

// Security headers
app.disable('x-powered-by');

// COEP/COOP headers for WebContainer (SharedArrayBuffer)
app.use((req, res, next) => {
  // Skip COEP for Vercel Sandbox proxy route
  if (!req.path.startsWith('/webcontainer/vercel-preview')) {
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  }

  // Additional security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// Static assets — immutable hashed files (1 year cache)
app.use(
  '/assets',
  express.static('build/client/assets', {
    immutable: true,
    maxAge: '1y',
  }),
);

// Static assets — non-hashed files (1 hour cache)
app.use(express.static('build/client', { maxAge: '1h' }));

// Health check endpoint for ALB
app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Request logging
app.use(morgan('short'));

// Remix SSR handler
const build = await import('./build/server/index.js');
app.all('*', createRequestHandler({ build }));

// Start server
const PORT = parseInt(process.env.PORT || '5171', 10);
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});
```

#### Step 0.3: Update Dockerfile for Node.js production

```dockerfile
# ---- build stage ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV HUSKY=0 CI=true

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
RUN apt-get update && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml* ./
RUN pnpm fetch

COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm run build

# ---- production dependencies ----
FROM build AS prod-deps
RUN pnpm prune --prod --ignore-scripts

# ---- production ----
FROM node:22-bookworm-slim AS production
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5171
ENV HOST=0.0.0.0

RUN apt-get update && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

# Copy built app and production deps
COPY --from=prod-deps /app/build /app/build
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/package.json /app/package.json
COPY --from=build /app/server.js /app/server.js

EXPOSE 5171

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD curl -fsS http://localhost:5171/healthz || exit 1

CMD ["node", "server.js"]
```

#### Step 0.4: Update package.json scripts

```json
{
  "scripts": {
    "start:prod": "node server.js",
    "build:server-entry": "esbuild server.ts --bundle --platform=node --format=esm --outfile=server.js --external:./build/* --external:express --external:compression --external:morgan"
  }
}
```

#### Step 0.5: Update vite.config.ts for Node adapter

In `vite.config.ts`, update the Remix plugin config to use Node server build:

```typescript
remixVitePlugin({
  future: {
    v3_fetcherPersist: true,
    v3_relativeSplatPath: true,
    v3_throwAbortReason: true,
    v3_lazyRouteDiscovery: true,
  },
  // Output server build for Node.js (not Cloudflare)
  // serverModuleFormat: 'esm', // already default in Remix 2.15
}),
```

---

### Phase 1: AWS Infrastructure Setup

#### Step 1.1: Install and configure AWS CLI

```bash
# Install AWS CLI
brew install awscli

# Configure credentials
aws configure
# Enter: Access Key ID, Secret Access Key, Region (eu-central-1), Output (json)

# Verify
aws sts get-caller-identity
```

#### Step 1.2: Create ECR repository

```bash
# Create ECR repository for Docker images
aws ecr create-repository \
  --repository-name huskit/website-agent \
  --region eu-central-1 \
  --image-scanning-configuration scanOnPush=true \
  --encryption-configuration encryptionType=AES256

# Get the repository URI (save this)
ECR_URI=$(aws ecr describe-repositories \
  --repository-names huskit/website-agent \
  --query 'repositories[0].repositoryUri' --output text)
echo "ECR URI: $ECR_URI"
```

#### Step 1.3: Create VPC with public subnets (2 AZs)

```bash
# Create VPC
VPC_ID=$(aws ec2 create-vpc \
  --cidr-block 10.0.0.0/16 \
  --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=huskit-prod}]' \
  --query 'Vpc.VpcId' --output text)

# Enable DNS hostname
aws ec2 modify-vpc-attribute --vpc-id $VPC_ID --enable-dns-hostnames

# Create Internet Gateway
IGW_ID=$(aws ec2 create-internet-gateway \
  --tag-specifications 'ResourceType=internet-gateway,Tags=[{Key=Name,Value=huskit-igw}]' \
  --query 'InternetGateway.InternetGatewayId' --output text)
aws ec2 attach-internet-gateway --vpc-id $VPC_ID --internet-gateway-id $IGW_ID

# Create public subnets in 2 AZs
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

# Enable auto-assign public IPs
aws ec2 modify-subnet-attribute --subnet-id $SUBNET_A --map-public-ip-on-launch
aws ec2 modify-subnet-attribute --subnet-id $SUBNET_B --map-public-ip-on-launch

# Create route table and add internet route
RT_ID=$(aws ec2 create-route-table \
  --vpc-id $VPC_ID \
  --tag-specifications 'ResourceType=route-table,Tags=[{Key=Name,Value=huskit-public-rt}]' \
  --query 'RouteTable.RouteTableId' --output text)

aws ec2 create-route --route-table-id $RT_ID --destination-cidr-block 0.0.0.0/0 --gateway-id $IGW_ID
aws ec2 associate-route-table --subnet-id $SUBNET_A --route-table-id $RT_ID
aws ec2 associate-route-table --subnet-id $SUBNET_B --route-table-id $RT_ID
```

#### Step 1.4: Create security groups

```bash
# ALB Security Group
ALB_SG=$(aws ec2 create-security-group \
  --group-name huskit-alb-sg \
  --description "ALB security group" \
  --vpc-id $VPC_ID \
  --query 'GroupId' --output text)

aws ec2 authorize-security-group-ingress --group-id $ALB_SG \
  --protocol tcp --port 443 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id $ALB_SG \
  --protocol tcp --port 80 --cidr 0.0.0.0/0

# ECS Tasks Security Group
ECS_SG=$(aws ec2 create-security-group \
  --group-name huskit-ecs-sg \
  --description "ECS tasks security group" \
  --vpc-id $VPC_ID \
  --query 'GroupId' --output text)

aws ec2 authorize-security-group-ingress --group-id $ECS_SG \
  --protocol tcp --port 5171 --source-group $ALB_SG
```

#### Step 1.5: Create S3 bucket for static assets

```bash
aws s3 mb s3://huskit-static-assets-prod --region eu-central-1

# Block public access (CloudFront OAC will handle access)
aws s3api put-public-access-block \
  --bucket huskit-static-assets-prod \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

#### Step 1.6: Create secrets in AWS Secrets Manager

```bash
# Create a single JSON secret with all sensitive values
aws secretsmanager create-secret \
  --name huskit/prod/app-secrets \
  --region eu-central-1 \
  --secret-string '{
    "DATABASE_URL": "postgresql://...",
    "SUPABASE_URL": "https://xxx.supabase.co",
    "SUPABASE_SERVICE_KEY": "eyJ...",
    "OPENAI_API_KEY": "sk-...",
    "ANTHROPIC_API_KEY": "sk-ant-...",
    "GOOGLE_GENERATIVE_AI_API_KEY": "...",
    "OPEN_ROUTER_API_KEY": "sk-or-...",
    "R2_ENDPOINT": "https://xxx.r2.cloudflarestorage.com",
    "R2_ACCESS_KEY": "...",
    "R2_SECRET_KEY": "...",
    "R2_BUCKET": "site-snapshots",
    "GOOGLE_PLACES_API_KEY": "...",
    "CRAWLER_API_URL": "https://...",
    "VERCEL_TOKEN": "...",
    "VERCEL_TEAM_ID": "...",
    "VERCEL_PROJECT_ID": "...",
    "LANGFUSE_SECRET_KEY": "sk-lf-...",
    "LANGFUSE_PUBLIC_KEY": "pk-lf-...",
    "BETTER_AUTH_SECRET": "..."
  }'
```

#### Step 1.7: Create ECS cluster, task definition, and service

```bash
# Create ECS Cluster
aws ecs create-cluster --cluster-name huskit-prod

# Create CloudWatch Log Group
aws logs create-log-group --log-group-name /ecs/huskit-website-agent
aws logs put-retention-policy --log-group-name /ecs/huskit-website-agent --retention-in-days 30

# Create IAM roles (see iam-roles.json below)
# Then create task definition and service
```

**Task Definition (task-definition.json):**

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
      "portMappings": [
        {
          "containerPort": 5171,
          "hostPort": 5171,
          "protocol": "tcp"
        }
      ],
      "essential": true,
      "environment": [
        { "name": "NODE_ENV", "value": "production" },
        { "name": "PORT", "value": "5171" },
        { "name": "HOST", "value": "0.0.0.0" },
        { "name": "VITE_LOG_LEVEL", "value": "info" },
        { "name": "LANGFUSE_ENABLED", "value": "true" },
        { "name": "SANDBOX_VERCEL_ENABLED", "value": "true" },
        { "name": "SANDBOX_PROVIDER_DEFAULT", "value": "vercel" }
      ],
      "secrets": [
        { "name": "DATABASE_URL", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/app-secrets:DATABASE_URL::" },
        { "name": "SUPABASE_URL", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/app-secrets:SUPABASE_URL::" },
        { "name": "SUPABASE_SERVICE_KEY", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/app-secrets:SUPABASE_SERVICE_KEY::" },
        { "name": "OPENAI_API_KEY", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/app-secrets:OPENAI_API_KEY::" },
        { "name": "ANTHROPIC_API_KEY", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/app-secrets:ANTHROPIC_API_KEY::" },
        { "name": "GOOGLE_GENERATIVE_AI_API_KEY", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/app-secrets:GOOGLE_GENERATIVE_AI_API_KEY::" },
        { "name": "OPEN_ROUTER_API_KEY", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/app-secrets:OPEN_ROUTER_API_KEY::" },
        { "name": "R2_ENDPOINT", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/app-secrets:R2_ENDPOINT::" },
        { "name": "R2_ACCESS_KEY", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/app-secrets:R2_ACCESS_KEY::" },
        { "name": "R2_SECRET_KEY", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/app-secrets:R2_SECRET_KEY::" },
        { "name": "R2_BUCKET", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/app-secrets:R2_BUCKET::" },
        { "name": "VERCEL_TOKEN", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/app-secrets:VERCEL_TOKEN::" },
        { "name": "VERCEL_TEAM_ID", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/app-secrets:VERCEL_TEAM_ID::" },
        { "name": "VERCEL_PROJECT_ID", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/app-secrets:VERCEL_PROJECT_ID::" },
        { "name": "BETTER_AUTH_SECRET", "valueFrom": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/app-secrets:BETTER_AUTH_SECRET::" }
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

#### Step 1.8: Create ALB with SSE-compatible settings

```bash
# Create ALB
ALB_ARN=$(aws elbv2 create-load-balancer \
  --name huskit-alb \
  --subnets $SUBNET_A $SUBNET_B \
  --security-groups $ALB_SG \
  --scheme internet-facing \
  --type application \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text)

# Set idle timeout to 300s for SSE streams
aws elbv2 modify-load-balancer-attributes \
  --load-balancer-arn $ALB_ARN \
  --attributes Key=idle_timeout.timeout_seconds,Value=300

# Create target group
TG_ARN=$(aws elbv2 create-target-group \
  --name huskit-tg \
  --protocol HTTP \
  --port 5171 \
  --vpc-id $VPC_ID \
  --target-type ip \
  --health-check-path /healthz \
  --health-check-interval-seconds 30 \
  --health-check-timeout-seconds 10 \
  --healthy-threshold-count 2 \
  --unhealthy-threshold-count 3 \
  --query 'TargetGroups[0].TargetGroupArn' --output text)

# Create HTTPS listener (requires ACM cert)
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

#### Step 1.9: Create ECS service

```bash
# Register task definition
aws ecs register-task-definition --cli-input-json file://task-definition.json

# Create ECS service
aws ecs create-service \
  --cluster huskit-prod \
  --service-name website-agent \
  --task-definition huskit-website-agent \
  --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_A,$SUBNET_B],securityGroups=[$ECS_SG],assignPublicIp=ENABLED}" \
  --load-balancers "targetGroupArn=$TG_ARN,containerName=website-agent,containerPort=5171" \
  --deployment-configuration "minimumHealthyPercent=100,maximumPercent=200" \
  --enable-ecs-managed-tags
```

#### Step 1.10: CloudFront distribution

```bash
# Create Origin Access Control for S3
aws cloudfront create-origin-access-control \
  --origin-access-control-config '{
    "Name": "huskit-s3-oac",
    "OriginAccessControlOriginType": "s3",
    "SigningBehavior": "always",
    "SigningProtocol": "sigv4"
  }'

# Create CloudFront distribution (use JSON config)
# See cloudfront-distribution.json below
aws cloudfront create-distribution --distribution-config file://cloudfront-distribution.json
```

---

### Phase 2: CI/CD Pipeline (GitHub Actions)

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to AWS

on:
  push:
    branches: [main]

permissions:
  id-token: write   # For OIDC
  contents: read

env:
  AWS_REGION: eu-central-1
  ECR_REPOSITORY: huskit/website-agent
  ECS_CLUSTER: huskit-prod
  ECS_SERVICE: website-agent
  S3_BUCKET: huskit-static-assets-prod
  CLOUDFRONT_DISTRIBUTION_ID: EXXXXXXXXX

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm run typecheck
      - run: pnpm run test

  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # Authenticate via OIDC (no long-lived keys)
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::ACCOUNT_ID:role/github-actions-deploy
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      # Build and push Docker image
      - name: Build, tag, and push image
        env:
          ECR_REGISTRY: ${{ steps.login-ecr.outputs.registry }}
          IMAGE_TAG: ${{ github.sha }}
        run: |
          docker build -t $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG \
                        -t $ECR_REGISTRY/$ECR_REPOSITORY:latest \
                        --target production .
          docker push $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG
          docker push $ECR_REGISTRY/$ECR_REPOSITORY:latest

      # Upload static assets to S3
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm run build

      - name: Sync static assets to S3
        run: |
          # Hashed assets — immutable, 1 year cache
          aws s3 sync build/client/assets s3://$S3_BUCKET/assets/ \
            --cache-control "public,max-age=31536000,immutable" \
            --delete

          # Non-hashed files — 1 hour cache
          aws s3 sync build/client s3://$S3_BUCKET/ \
            --cache-control "public,max-age=3600" \
            --exclude "assets/*" \
            --delete

      # Deploy new ECS task
      - name: Update ECS service
        env:
          ECR_REGISTRY: ${{ steps.login-ecr.outputs.registry }}
          IMAGE_TAG: ${{ github.sha }}
        run: |
          # Get current task definition
          TASK_DEF=$(aws ecs describe-task-definition \
            --task-definition huskit-website-agent \
            --query 'taskDefinition' --output json)

          # Update image in task definition
          NEW_TASK_DEF=$(echo $TASK_DEF | jq \
            --arg IMAGE "$ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG" \
            '.containerDefinitions[0].image = $IMAGE |
             del(.taskDefinitionArn, .revision, .status, .requiresAttributes,
                 .compatibilities, .registeredAt, .registeredBy)')

          # Register new task definition
          NEW_REVISION=$(aws ecs register-task-definition \
            --cli-input-json "$NEW_TASK_DEF" \
            --query 'taskDefinition.taskDefinitionArn' --output text)

          # Update service to use new revision
          aws ecs update-service \
            --cluster $ECS_CLUSTER \
            --service $ECS_SERVICE \
            --task-definition $NEW_REVISION \
            --force-new-deployment

      # Invalidate CloudFront cache for non-hashed files
      - name: Invalidate CloudFront
        run: |
          aws cloudfront create-invalidation \
            --distribution-id $CLOUDFRONT_DISTRIBUTION_ID \
            --paths "/*"

      # Wait for deployment to stabilize
      - name: Wait for ECS deployment
        run: |
          aws ecs wait services-stable \
            --cluster $ECS_CLUSTER \
            --services $ECS_SERVICE
```

---

## 4. Security Considerations

### Secrets Management
- **All API keys** stored in AWS Secrets Manager (never in env files or code)
- **VITE_* variables** are public (bundled into client) — only non-sensitive config
- **IAM roles** for ECS tasks — least privilege (only SecretsManager read + CloudWatch write)
- **GitHub OIDC** for CI/CD — no long-lived AWS access keys stored in GitHub

### Network Security
- **ALB**: HTTPS only, HTTP redirects to HTTPS
- **ECS Tasks**: Only accept traffic from ALB security group on port 5171
- **No NAT Gateway**: Tasks in public subnets with public IPs for outbound (LLM APIs, Supabase)
- **WAF on CloudFront**: AWS Managed Rules (Common, Known Bad Inputs) + rate limiting

### Application Security
- **COEP/COOP headers** enforced at application level (Express middleware)
- **Rate limiting** on `/api/*` endpoints (WAF + application-level)
- **Per-user SSE stream limits** to prevent abuse
- **ECR image scanning** on push
- **Better Auth** handles session security with HttpOnly cookies

### Data Security
- **TLS everywhere**: CloudFront → HTTPS, ALB → HTTPS, Supabase → SSL
- **Supabase RLS** policies enforce row-level access control
- **No secrets in VITE_* prefixed variables**
- **Log sanitization**: ensure no API keys in CloudWatch logs

---

## 5. Post-Deployment Monitoring & Maintenance

### CloudWatch Alarms (create via CLI or Console)

| Alarm | Metric | Threshold | Action |
|-------|--------|-----------|--------|
| High 5xx Rate | ALB HTTPCode_Target_5XX_Count | > 10/min for 5 min | SNS notification |
| High Latency | ALB TargetResponseTime p95 | > 2s for 5 min | SNS notification |
| Unhealthy Hosts | ALB HealthyHostCount | < 2 for 2 min | SNS notification |
| High CPU | ECS CPUUtilization | > 80% for 10 min | Auto-scale + SNS |
| High Memory | ECS MemoryUtilization | > 85% for 5 min | SNS notification |
| CloudFront Errors | 5xxErrorRate | > 5% for 5 min | SNS notification |

### Auto-Scaling Policy

```bash
# Register scalable target
aws application-autoscaling register-scalable-target \
  --service-namespace ecs \
  --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/huskit-prod/website-agent \
  --min-capacity 2 --max-capacity 8

# CPU-based scaling
aws application-autoscaling put-scaling-policy \
  --service-namespace ecs \
  --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/huskit-prod/website-agent \
  --policy-name cpu-tracking \
  --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration '{
    "TargetValue": 70,
    "PredefinedMetricSpecification": {
      "PredefinedMetricType": "ECSServiceAverageCPUUtilization"
    },
    "ScaleInCooldown": 300,
    "ScaleOutCooldown": 60
  }'
```

### Cost Controls

```bash
# Set monthly budget alert
aws budgets create-budget --account-id ACCOUNT_ID --budget '{
  "BudgetName": "huskit-monthly",
  "BudgetLimit": {"Amount": "500", "Unit": "USD"},
  "TimeUnit": "MONTHLY",
  "BudgetType": "COST"
}' --notifications-with-subscribers '[
  {
    "Notification": {
      "NotificationType": "ACTUAL",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 80,
      "ThresholdType": "PERCENTAGE"
    },
    "Subscribers": [{"SubscriptionType": "EMAIL", "Address": "team@huskit.com"}]
  }
]'
```

### Maintenance Tasks

| Task | Frequency | How |
|------|-----------|-----|
| Review CloudWatch logs for errors | Daily | CloudWatch Logs Insights queries |
| Check ECR image scan results | Each deploy | AWS Console or CLI |
| Rotate Secrets Manager secrets | Quarterly | Manual update + ECS redeploy |
| Review WAF logs for blocked requests | Weekly | CloudWatch Logs |
| Update Node.js base image | Monthly | Update Dockerfile + redeploy |
| Review cost breakdown | Monthly | AWS Cost Explorer |
| Test disaster recovery (redeploy from scratch) | Quarterly | Run CI/CD pipeline |

---

## 6. IAM Roles Reference

### ECS Execution Role (pulls images, reads secrets)

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
      "Action": [
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:eu-central-1:ACCOUNT_ID:log-group:/ecs/huskit-website-agent:*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue"
      ],
      "Resource": "arn:aws:secretsmanager:eu-central-1:ACCOUNT_ID:secret:huskit/prod/*"
    }
  ]
}
```

### GitHub Actions Deploy Role (OIDC)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ecr:GetAuthorizationToken"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:PutImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload"
      ],
      "Resource": "arn:aws:ecr:eu-central-1:ACCOUNT_ID:repository/huskit/website-agent"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecs:DescribeTaskDefinition",
        "ecs:RegisterTaskDefinition",
        "ecs:UpdateService",
        "ecs:DescribeServices"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["iam:PassRole"],
      "Resource": [
        "arn:aws:iam::ACCOUNT_ID:role/huskit-ecs-execution-role",
        "arn:aws:iam::ACCOUNT_ID:role/huskit-ecs-task-role"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::huskit-static-assets-prod",
        "arn:aws:s3:::huskit-static-assets-prod/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["cloudfront:CreateInvalidation"],
      "Resource": "arn:aws:cloudfront::ACCOUNT_ID:distribution/DISTRIBUTION_ID"
    }
  ]
}
```

---

## Quick Start Checklist

- [ ] **Phase 0**: Create `server.ts` (Node.js Express server replacing Wrangler)
- [ ] **Phase 0**: Update Dockerfile to use `node server.js` instead of Wrangler
- [ ] **Phase 0**: Test locally with `docker build` + `docker run`
- [ ] **Phase 1.1**: Install AWS CLI, configure credentials
- [ ] **Phase 1.2**: Create ECR repository
- [ ] **Phase 1.3**: Create VPC + subnets
- [ ] **Phase 1.4**: Create security groups
- [ ] **Phase 1.5**: Create S3 bucket for static assets
- [ ] **Phase 1.6**: Store secrets in Secrets Manager
- [ ] **Phase 1.7**: Create ECS cluster + task definition
- [ ] **Phase 1.8**: Create ALB with 300s idle timeout
- [ ] **Phase 1.9**: Create ECS service
- [ ] **Phase 1.10**: Create CloudFront distribution
- [ ] **Phase 1.11**: Configure Route 53 DNS
- [ ] **Phase 2**: Set up GitHub Actions CI/CD pipeline
- [ ] **Phase 3**: Configure CloudWatch alarms + auto-scaling
- [ ] **Phase 3**: Set up AWS Budgets cost alerts
- [ ] **Validate**: COEP/COOP headers on HTML responses
- [ ] **Validate**: SSE streams work >30s through ALB
- [ ] **Validate**: WebContainer loads and executes
- [ ] **Validate**: Auth flow works end-to-end
