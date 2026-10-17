# Implementation report

Status of Morrow as built in this repository, written against the original
build specification. Everything listed as implemented is in the code and
covered by the tests or checks named here; limitations are listed plainly.

## What is implemented

**Contacts and relationship data** — create/edit/archive/erase, relationship
types, birthdays with optional year, work anniversaries, tags, custom fields
(text, number, date, boolean, select, URL), notes, consent with source and full
history, suppression state, last interaction/e-mail, an activity timeline,
search and filters, bulk actions, a streamed formula-safe CSV export, and a CSV
import with column mapping, date-order handling, duplicate strategies
(fill blanks / overwrite / skip), a dry-run preview and a final report.
Duplicate detection uses normalised addresses (optional Gmail canonicalisation).

**Segments** — a typed rule language (fields, dates, tags, custom fields,
suppression, other segments, engagement incl. replies, birthdays, custom events)
with nested any/all groups, compiled to SQL and evaluated in the database, with
loop protection for nested segments and a live preview.

**Templates** — a safe Mustache-like engine (escaped output only, URL-context
checks, filters such as `default`, conditionals, snippets), an HTML sanitiser,
versioning with immutable published versions, restore, previews as any contact
in a sandboxed iframe, plain-text generation, test sends restricted to
workspace members, an automatic compliance footer and `List-Unsubscribe`
one-click headers.

**Automations** — ten trigger types (calendar dates incl. custom date fields,
contact created/updated, segment entered, consent changed, tag added, custom
events, inactivity, schedules, manual), nine step types (send, wait, add tag,
remove tag, update field, task, notify, if/else branch, end), entry
conditions, cooldown/re-entry/max-run rules, versioned definitions, review vs
automatic delivery (automatic needs an admin, is audited and resets on edit),
dry runs at any moment with unsaved definitions, manual runs, run history and
cancellation.

**The birthday flow** — per-time-zone evaluation at a local send time,
workspace or contact time zones, day offsets, leap-day policies (28 Feb / 1 Mar /
leap years only), a bounded catch-up window after downtime with older dates
reported as missed, and exactly-once guarantees (unique run per occasion,
unique message idempotency key, unique send job, atomic claim, provider
idempotency or the *uncertain* state after a crash).

**Campaigns** — draft → preflight (audience, exclusions by exclusive reason,
missing personalisation, blockers, warnings) → test → schedule or send, optional
second-person approval, paced dispatch, pause/resume/cancel (reporting what
was already sent), per-recipient live status, and statistics.

**Delivery** — provider-independent `EmailProvider` with SMTP, Resend,
Postmark and a development inbox; installation-wide or per-workspace
configuration with encrypted credentials; transient/permanent error
classification; retries with exponential backoff and jitter; dead-lettering;
signed webhook ingestion that is idempotent and order-independent; bounce and
complaint suppression; eligibility re-checked at the moment of sending;
frequency caps; a per-workspace sending speed (token bucket per worker process); sender verification and DNS checks.

**Analytics** — sent, delivered, bounced (hard/soft), complaints,
unsubscribes, clicks and estimated opens, by local day in the workspace time
zone, per campaign and automation, failure reasons and a CSV export. Delivery
rates are shown as unavailable when the provider cannot report them.

**AI (optional)** — drafting, rewriting, adapting for a segment, subject lines
and campaign summaries through a provider interface (Anthropic implemented,
model `claude-opus-5-5`, structured output, refusal fallbacks enabled via
`fallbacks: 'default'`). It never receives contact records and only ever
produces drafts. Every feature works with AI turned off.

**Workspaces and security** — multiple workspaces per installation, roles
(owner/admin/manager/analyst) enforced in the service layer, invitations,
scrypt password hashing, hashed session tokens with sliding expiry, CSRF
tokens, API keys (hashed, role-capped, expiring, revocable), AES-256-GCM secret
encryption, HMAC-signed public links, rate limits, security headers and CSP,
JSON-only API bodies, request IDs, log redaction and an audit log.

**Surfaces** — a Hono HTTP API (`/api/v1`, documented in `docs/api.md`), public
unsubscribe/tracking/verification pages and webhooks, `/healthz`, `/readyz`,
Prometheus `/metrics`; a typed TypeScript SDK; the `morrow` CLI (operations
and workspace commands with `--json`); and a React web app (overview, contacts,
import wizard, segment builder, template studio, automation builder with dry
runs, campaigns, calendar, analytics with accessible charts, approvals, tasks
and all settings) in light and dark themes, usable on phones.

**Operations** — single-process or split roles (server / worker / scheduler)
coordinating only through the database; SQLite or PostgreSQL; migrations on
start; graceful shutdown that releases job leases; a demo seed; `morrow doctor`;
Dockerfile, docker-compose with PostgreSQL, and GitHub Actions CI.

## Architecture decisions

- **One database as system of record and durable queue.** No Redis or broker:
  jobs are leased rows (`FOR UPDATE SKIP LOCKED` on PostgreSQL), which keeps
  operations simple and makes enqueueing transactional with the data it
  belongs to.
- **Portable schema.** Prefixed time-sortable text IDs, ISO-8601 UTC strings,
  integer booleans and JSON text run unchanged on SQLite and PostgreSQL; the
  whole test suite runs on both.
- **Pure core.** Templates, calendars, segment rules, consent and permissions
  live in a side-effect-free package used by the server, the CLI and the browser,
  so a preview and a real send render identically.
- **Layered exactly-once delivery** rather than a single guard — see
  `docs/automations.md`.
- **Permissions in services, not routes**, so the API, CLI, jobs and any future
  transport share one set of rules.
- **Review mode by default** for automations, and preflight + confirmation for
  campaigns: Morrow should never surprise anyone's inbox.
- **Typed packages with one-way dependencies** (`core ← db/email/ai ← engine ←
  server/cli`, `web → sdk → core`), so parts can be reused from other products.

## Test results

Last full run (2026-10-17):

| Check | Result |
| --- | --- |
| `npm run typecheck` (packages, server, CLI and web) | passed |
| `npx vitest run` on SQLite | **21 files, 245 tests, all passed** |
| `npm run test:pg` (PostgreSQL via embedded PGlite) | **21 files, 245 tests, all passed.** Each worker holds its own in-memory database, so on a machine with little free memory limit the workers: `npm run test:pg -- --maxWorkers=2`. |
| Production build | web app (Vite), server and CLI bundles (tsup) built successfully earlier the same day; the built server and CLI were smoke-tested end to end (migrate, demo seed, `doctor`, sign-in and API queries over a real port). |
| UI check | every main page rendered in headless Chrome in light and dark themes and at phone width with no console errors or failed requests; layout issues found this way were fixed. |

The suites cover: template rendering, escaping, sanitising and validation;
time zones, calendars, leap days and recurrence; CSV parsing and import
planning; consent and permission rules; migrations on both databases; provider
error classification and webhook verification; the durable queue (leases,
retries, dead-lettering, dedupe); the end-to-end birthday automation (time
zones, catch-up, leap years, no duplicates across ticks and restarts, review
mode); delivery retries, crash recovery and the *uncertain* state, bounces,
complaints and one-click unsubscribe; contacts, segments and imports; event
triggers, waits, branches, versioning, pause/resume and dry runs; campaign
preflight, approvals, scheduling (including rejecting past times),
pause/cancel and per-recipient status; workspace isolation, sessions, API keys,
invitations and roles; the HTTP API (auth, CSRF, rate limits, errors, exports,
uploads, public pages, webhooks, static hosting); the SDK against the real API;
and the CLI (profiles, workspace commands, operator commands, exit codes).

## Setup

See `README.md` and `docs/setup.md`. In short: `npm install`,
`npm run morrow -- init`, optionally `npm run morrow -- seed --demo`, then
`npm run dev`; or `docker compose up -d --build` with `MORROW_SECRET_KEY` set.

## Known limitations

- **Live providers are not exercised in tests.** SMTP, Resend and Postmark are
  tested against stubbed transports and recorded payloads; no test sends real
  e-mail by design. Run a test send against your account before going live.
- **The AI provider is tested with stubs**, not against the live Anthropic API.
- **The web app has no automated browser tests.** It was type-checked, built and
  rendered page by page in headless Chrome (light, dark and phone widths) with no
  console errors; the behaviour behind it is covered by the API, SDK and CLI
  tests.
- **Replies are not detected automatically.** There is no inbound mail
  processing; the "replied" engagement rule counts `email.replied` events that
  you record through the API (for example from a help-desk or inbox webhook).
- **Rate limits and the sending-speed limit are per process.** With several API
  nodes, also rate-limit at the load balancer; with several workers, the
  workspace sending speed applies to each worker.
- **SQLite is single-process.** Use PostgreSQL when running more than one
  process or machine.
- **Provider-native suppression sync** (pulling bounce lists from a provider's
  dashboard) is not implemented; Morrow relies on webhooks.
- **Open rates are estimates** by nature (privacy proxies, image blocking) and
  are labelled as such.
