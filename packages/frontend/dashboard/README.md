# FilePipeline Dashboard

This package is the React SPA used for ETL monitoring. It is deployed as static assets to S3 and served through CloudFront. Authentication is handled by Cognito Hosted UI (Authorization Code + PKCE), and API access is protected by API Gateway JWT authorizer.

## What Is Implemented

- Frontend SPA with React + Vite + TanStack Router + TanStack Query.
- Backend metrics endpoint through API Gateway + Lambda.
- Cognito User Pool authentication via Hosted UI.
- JWT-protected API calls from frontend.
- CloudFront distribution in front of a private S3 origin for dashboard assets.
- shadcn-style UI primitives and shared component variants under src/components/ui.
- Environment sync from CDK outputs into dashboard runtime env.
- Automated deploy scripts for infra and dashboard assets.

## High-Level Architecture

```text
User Browser
  -> CloudFront (dashboard path: /dashboard/)
  -> S3 processed bucket (private origin)

Login Flow
  Browser -> Cognito Hosted UI -> callback to dashboard URL
  Browser exchanges code with Cognito /oauth2/token (PKCE)
  Browser stores access/id/refresh tokens

API Flow
  Browser -> API Gateway HTTP API (/metrics) with Bearer token
  API Gateway JWT Authorizer validates Cognito token
  API Gateway -> Dashboard API Lambda -> response to frontend
```

## Authentication Flow

The login page collects email as login hint and redirects to Cognito Hosted UI.

1. Frontend builds authorize URL with:

- client_id
- response_type=code
- scope
- redirect_uri
- state
- code_challenge

2. Cognito authenticates user.
3. Cognito redirects back with code and state.
4. Frontend exchanges code for tokens at /oauth2/token.
5. Access token is attached to metrics API requests.
6. Refresh token flow is used when access token expires.

## CloudFront + S3 Model

- Production path uses CloudFront URL for dashboard access.
- S3 website mode is disabled by default (private bucket access).
- Deploy script preserves non-public bucket policy statements when disabling website/public access, so CloudFront access is not broken.

## UI Layer (shadcn)

The dashboard uses shadcn-style component primitives in src/components/ui and shared utility variants.

- Button variants and sizing via class-variance-authority in src/components/ui/button.tsx.
- Form field primitives in src/components/ui/field.tsx:
  - Field
  - FieldLabel
  - FieldDescription
- Input primitive in src/components/ui/input.tsx.
- Additional primitives used across pages:
  - badge.tsx
  - card.tsx
  - tabs.tsx
  - tooltip.tsx
  - skeleton.tsx

Guidelines used in this package:

- Reuse UI primitives from src/components/ui instead of raw HTML controls where a shared component exists.
- Keep page-level styling thin and place reusable style logic in component variants.
- Prefer composition of Field + Input + FieldDescription for form sections.

## Environment Variables

Use three env scopes with clear ownership.

### 1) Infra deploy-time env (repository root .env)

These values are consumed by CDK deploy.

- DASHBOARD_AUTH_CALLBACK_URLS
- DASHBOARD_AUTH_LOGOUT_URLS
- DASHBOARD_API_ALLOWED_ORIGINS
- DASHBOARD_SEED_USER_EMAIL
- DASHBOARD_SEED_USER_PASSWORD

Important: if Cognito callback/logout settings change, you must run infra deploy again.

### 2) Dashboard deploy/runtime env (packages/frontend/dashboard/.env)

Used by build/deploy scripts and production build injection.

- FRONTEND_BUCKET_NAME
- FRONTEND_BUCKET_PREFIX
- AWS_REGION
- FRONTEND_ENABLE_WEBSITE
- FRONTEND_DELETE_STALE (optional)
- VITE_BASE_PATH
- VITE_DASHBOARD_API_URL
- VITE_AWS_REGION
- VITE_COGNITO_DOMAIN
- VITE_COGNITO_CLIENT_ID
- VITE_COGNITO_SCOPE
- VITE_COGNITO_REDIRECT_URI
- VITE_COGNITO_LOGOUT_REDIRECT_URI

### 3) Local dev overrides (packages/frontend/dashboard/.env.local)

Used for local development only. Not committed (gitignored).

- Dev startup uses scripts/dev.ts, which loads .env.local first and injects it into process.env before spawning Vite, so these values take priority over the CloudFront ones in .env.
- Deploy build does not use .env.local for VITE values.

Required keys:

```bash
VITE_COGNITO_REDIRECT_URI=http://localhost:5173/
VITE_COGNITO_LOGOUT_REDIRECT_URI=http://localhost:5173/
```

Without this file, `bun run dev` falls back to the CloudFront redirect URIs in .env, which sends the OAuth callback to production instead of localhost (see troubleshooting below).

## Command Reference

From repository root:

```bash
bun run dev:dashboard
bun run build:dashboard
bun run deploy:aws
bun run deploy:aws:dashboard
bun run teardown:aws
```

From dashboard package (export `AWS_PROFILE` first if running `deploy:s3` directly — it's no longer sourced from `.env`):

```bash
bun run dev
bun run build
bun run build:deploy
bun run sync:env
AWS_PROFILE=filepipeline bun run deploy:s3
```

## Deployment Runbook

### 1) Deploy infrastructure

From root:

```bash
AWS_PROFILE=filepipeline bun run deploy:aws
```

This deploys/updates:

- Cognito user pool, app client, hosted domain
- API Gateway HTTP API + JWT authorizer
- Dashboard API Lambda
- CloudFront distribution for dashboard
- S3 bucket policy required for CloudFront access

### 2) Deploy dashboard assets

From root (recommended — sets `AWS_PROFILE` automatically):

```bash
bun run deploy:aws:dashboard
```

Or from the dashboard package directly:

```bash
AWS_PROFILE=filepipeline bun run deploy:s3
```

This runs:

1. sync:env (hydrates .env values from CDK outputs)
2. build:deploy (injects VITE values from .env for production build)
3. S3 upload of dist assets

### 3) Validate

- Open dashboard CloudFront URL from CDK outputs.
- Click Continue to Sign In and complete Hosted UI login.
- Confirm callback lands on dashboard URL (not localhost).
- Confirm metrics load after auth.

## Common Troubleshooting

### redirect_mismatch in Cognito

Cause:

- Cognito app client callback/logout URLs do not include the dashboard redirect URI being sent.

Fix:

1. Update root .env values:
   - DASHBOARD_AUTH_CALLBACK_URLS
   - DASHBOARD_AUTH_LOGOUT_URLS
2. Redeploy infra:
   - AWS_PROFILE=filepipeline bun run deploy:aws

### Redirect still points to localhost after deploy

Cause:

- Build consumed localhost values from .env.local.

Fix:

1. Ensure .env has CloudFront VITE_COGNITO_REDIRECT_URI and VITE_COGNITO_LOGOUT_REDIRECT_URI.
2. Run dashboard deploy:

- AWS_PROFILE=filepipeline bun run deploy:s3

### Login on localhost redirects straight to CloudFront /dashboard/login

Cause:

- .env.local is missing, so Vite falls back to the production VITE_COGNITO_REDIRECT_URI / VITE_COGNITO_LOGOUT_REDIRECT_URI in .env.
- The authorize request sent to Cognito requests a CloudFront redirect_uri even though you're on localhost. If Cognito already has an active Hosted UI session, it skips the password page and redirects straight to that CloudFront URL, which has no matching PKCE state/verifier (those were stored in localhost's sessionStorage), so it bounces to /dashboard/login.

Fix:

1. Create packages/frontend/dashboard/.env.local with:

```bash
VITE_COGNITO_REDIRECT_URI=http://localhost:5173/
VITE_COGNITO_LOGOUT_REDIRECT_URI=http://localhost:5173/
```

2. Restart `bun run dev` (or `bun run dev:dashboard` from root).
3. If Cognito still skips the password page, it's an existing Hosted UI SSO session — log out of the production dashboard first or use an incognito window.

### CloudFront section missing in deploy summary

Cause:

- Stale cdk-outputs.json.

Fix:

- deploy script now merges live CloudFormation outputs, so rerun deploy:aws.

## Security Notes

- Do not hardcode credentials or secrets in tracked files.
- Keep production auth origins/callbacks explicit and minimal.
- Prefer private S3 + CloudFront over public S3 website access.
- Use ap-southeast-1 for all resources in this project.
