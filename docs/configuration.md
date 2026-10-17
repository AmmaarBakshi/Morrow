# Configuration

Morrow reads its configuration from environment variables (or a `.env` file in
the working directory, loaded by the `morrow` CLI). [`.env.example`](../.env.example)
lists every variable with comments; this page explains the important ones and
the rules Morrow enforces.

## Required in production

| Variable | Rule |
| --- | --- |
| `MORROW_ENV=production` | Turns on the production checks below. `NODE_ENV=production` also works. |
| `MORROW_SECRET_KEY` | At least 32 random characters, not the development default. Encrypts provider credentials (AES-256-GCM) and signs unsubscribe, tracking and verification links. **Rotating it invalidates stored provider secrets and every link already sent.** Generate one with `morrow init` or `openssl rand -base64 32`. |
| `MORROW_PUBLIC_URL` | Must be `https://…` in production. It appears in every unsubscribe and tracking link, so recipients must be able to reach it. |
| `DATABASE_URL` | `postgres://user:pass@host:5432/morrow` (recommended) or `sqlite:/path/morrow.db` on a persistent disk. |

Morrow refuses to start in production when these rules are broken, with a
message explaining what to fix.

## Runtime

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `4400` / `0.0.0.0` | HTTP listener. |
| `MORROW_ROLES` | `server,worker,scheduler` | Processes run by `apps/server` `main`. The CLI uses `morrow start --roles …`. |
| `MORROW_APP_URL` | `MORROW_PUBLIC_URL` | Where people open the web app (links in notifications, invitations). Also decides whether the session cookie is `Secure`. |
| `MORROW_TRUST_PROXY` | `false` | Use `X-Forwarded-For` for client IPs (rate limits, audit). Only behind a proxy you control. |
| `MORROW_METRICS_TOKEN` | — | Bearer token for `/metrics`. Without it `/metrics` is disabled in production. |
| `MORROW_ALLOW_SIGNUP` | `true` in development, `false` in production | Whether anyone can create an account after the first one. Others join by invitation. |
| `MORROW_SESSION_TTL_DAYS` | `14` | Sliding session lifetime. |

## E-mail

| Variable | Meaning |
| --- | --- |
| `MORROW_EMAIL_PROVIDER` | `fake`, `smtp`, `resend` or `postmark`. The installation default; workspaces can set their own. Defaults to `fake` outside production and to none in production. |
| `MORROW_ALLOW_DEV_PROVIDER` | Allow the development inbox in production (demos only). |
| `MORROW_SYSTEM_FROM_EMAIL` / `MORROW_SYSTEM_FROM_NAME` | From address for invitations, sender verification and alerts. Without it Morrow uses the workspace's default verified sender. |
| `SMTP_*`, `RESEND_*`, `POSTMARK_*` | Provider credentials — see [providers.md](providers.md). |

## AI assistance (optional)

| Variable | Meaning |
| --- | --- |
| `MORROW_AI_PROVIDER` | `anthropic` to enable AI drafting for every workspace. Leave unset to disable; workspaces can still add their own key in Settings → AI. |
| `MORROW_AI_MODEL` | Model override. Defaults to `claude-opus-5-5`. |
| `ANTHROPIC_API_KEY` | API key for the installation-wide provider. |

AI only produces drafts. It receives instructions and template text, never
contact records, and nothing it writes is sent without a person saving and
publishing it.

## Tuning

| Variable | Default | Meaning |
| --- | --- | --- |
| `MORROW_WORKER_CONCURRENCY` | `4` | Jobs a worker runs at once. |
| `MORROW_WORKER_POLL_MS` | `1000` | How often an idle worker checks for work (writes also wake in-process workers immediately). |
| `MORROW_JOB_LEASE_MS` | `120000` | How long a claimed job is reserved before another worker may take it over. |
| `MORROW_SCHEDULER_INTERVAL_MS` | `30000` | Scheduler tick (birthdays, schedules, waits, scheduled campaigns, maintenance). |
| `MORROW_JOB_RETENTION_DAYS` | `30` | Succeeded jobs are pruned after this long. |

## Per-workspace settings

Everything that differs between companies lives in the workspace, not the
environment, and is edited in **Settings → Workspace**: time zone, company name
and postal address (used in the legally required marketing footer), brand
colour and logo, the greeting used when a first name is missing, workspace
template variables, the consent policy (implied consent for marketing, unknown
consent for relationship mail), daily and weekly frequency caps, sending speed,
campaign approval, open/click tracking, Gmail address canonicalisation and how
long message bodies are kept.
