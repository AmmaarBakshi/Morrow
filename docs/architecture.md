# Morrow architecture

Morrow is a relationship-automation and email platform. A workspace configures
contacts, templates, segments, automations and campaigns once; Morrow then
evaluates events every day and sends the right message — reliably, exactly once,
and only to people who should receive it.

This document records the architecture and the decisions behind it.

## Goals that shaped the design

1. **Correctness over volume.** No duplicate sends, no sends to suppressed or
   non-consenting contacts, no fabricated statistics.
2. **Simplest reliable infrastructure.** One database is the system of record
   *and* the durable job queue. No Redis or message broker is required to run
   thousands of contacts; the design scales to Postgres + many workers.
3. **Modular by construction.** Pure domain logic, persistence, delivery
   providers, AI and transport (HTTP/CLI) are separate packages with one-way
   dependencies, so each can be reused (for example from another product such
   as Cyphen) or replaced.
4. **Multi-workspace.** One installation can serve several companies or
   products. Isolation is enforced in the service layer, never in the UI.

## Repository layout

```
packages/
  core/     Pure TypeScript domain logic. No I/O. Runs in Node and the browser.
            Template engine, HTML sanitiser, time-zone + calendar math,
            leap-day policy, recurrence, segment/automation schemas, consent
            policy, permissions, CSV parsing, e-mail normalisation, IDs.
  db/       Kysely schema types, migrations, dialect-portable connection
            factory (SQLite via better-sqlite3, PostgreSQL via pg).
  email/    Provider-independent delivery: EmailProvider interface, error
            classification, fake/dev provider, SMTP, Resend, Postmark,
            webhook signature verification.
  ai/       Optional AI assistance behind a provider interface (Anthropic
            today; others plug in through `AiProvider`). Never on the
            critical path: every feature works with AI disabled.
  engine/   Application services (contacts, segments, templates, automations,
            campaigns, analytics, …), the durable job queue, the worker, the
            scheduler and the automation executor.
  sdk/      Typed fetch-based HTTP client for the Morrow API.
apps/
  server/   Hono HTTP API, public unsubscribe/tracking endpoints, provider
            webhooks, static web hosting and the single-node runtime.
  web/      React + TanStack Query single-page application.
  cli/      `morrow` command-line interface (operations + API client).
```

Dependency direction (arrows mean "depends on"):

```
web ──► sdk ──► core
cli ──► sdk, engine, server
server ──► engine ──► db, email, ai ──► core
```

`core` never imports anything with side effects, which is why the same
template renderer powers server-side sending, CLI previews and browser previews.

## Data model

All primary keys are prefixed, time-sortable text IDs (`con_…`, `msg_…`), which
keeps them portable between SQLite and Postgres and readable in logs.

Timestamps are stored as ISO-8601 UTC strings (`2026-03-07T03:30:00.000Z`).
The fixed format sorts lexicographically, so range queries and indexes behave
identically on both databases. Calendar logic (birthdays, schedules, analytics
day buckets) is always computed with explicit IANA time zones.

Birthdays store `birthday_month` + `birthday_day` (+ optional `birth_year`), and
a derived `birthday_md` integer (`MMDD`) that is indexed. A month/day birthday is
never confused with a full birth date, and the birth year is never required.

Custom fields use definition + value tables (`custom_fields`,
`contact_field_values`) so new fields never need schema migrations. Segment
queries filter them with indexed `EXISTS` sub-queries.

Key tables: `workspaces`, `users`, `memberships`, `sessions`, `api_keys`,
`contacts`, `contact_notes`, `contact_events`, `tags`, `contact_tags`,
`custom_fields`, `contact_field_values`, `segments`, `segment_memberships`,
`consent_events`, `suppressions`, `snippets`, `templates`, `template_versions`,
`senders`, `integrations`, `automations`, `automation_versions`,
`automation_runs`, `automation_run_steps`, `campaigns`, `campaign_recipients`,
`messages`, `message_events`, `webhook_events`, `jobs`, `tasks`,
`notifications`, `audit_logs`, `imports`, `scheduler_state`.

## Exactly-once sending

Duplicate prevention is layered; any single layer is enough to stop a
duplicate, together they survive crashes, double scheduler runs and retries.

1. **Automation runs** are unique on `(automation_id, contact_id, event_key)`.
   A birthday event key is `birthday:2027-03-07` (the local occasion date), so
   evaluating the same day twice cannot start a second run.
2. **Messages** are unique on `(workspace_id, idempotency_key)`. The key is
   derived from the intended send action:
   `auto:<automation>:<contact>:<event_key>:<step>` or
   `campaign:<campaign>:<contact>`.
3. **Jobs** are unique on `dedupe_key` (`send:<message_id>`), so enqueueing
   the same delivery twice is a no-op.
4. **Atomic state transitions.** A worker moves a message `queued → sending`
   with a conditional `UPDATE … WHERE status = 'queued'`; only one worker can
   win. If a worker dies after the provider accepted a message but before the
   result was stored, the message is left in `sending`. On recovery Morrow
   re-sends only when the provider honours idempotency keys (Resend);
   otherwise it marks the message `uncertain` and asks a human, rather than
   risk a duplicate.

## Durable queue and worker

The `jobs` table is the queue. Workers claim batches with a lease
(`locked_until`). On Postgres the claim uses `FOR UPDATE SKIP LOCKED`; on
SQLite writes are serialised so a single conditional update is atomic.

* Retryable failures back off exponentially with jitter up to `max_attempts`,
  then move to `dead` (the dead-letter state). Dead jobs are logged, counted in
  `/metrics` and listed in Settings → System, where they can be retried.
* Permanent failures (invalid address, hard bounce, provider rejection) are
  never retried.
* Expired leases are reclaimed, so killing a worker never loses work.
* Concurrency and provider rate limits are bounded per worker.

## Scheduler

The scheduler is a loop that runs every `MORROW_SCHEDULER_INTERVAL_MS`. It:

* evaluates calendar automations (birthdays, anniversaries, custom dates) per
  time zone, after the configured local send time;
* fires recurring and one-off scheduled automations;
* evaluates inactivity and segment-entry triggers;
* launches scheduled campaigns;
* reclaims stuck jobs and prunes expired sessions.

Progress is stored in `scheduler_state` cursors (for example the last local
date evaluated for a given automation and time zone). After downtime the
scheduler catches up missed dates inside an explicit, per-automation catch-up
window (`catchUpDays`, default 1) and logs anything older as *missed* — it
never silently ignores downtime and never floods contacts with stale greetings.

A lease in `scheduler_state` keeps only one active scheduler leader; even if two
run, the idempotency layers above make the duplicate harmless.

## Eligibility, consent and suppression

Every message has a category:

| Category        | Consent required                         | Unsubscribe link |
| --------------- | ---------------------------------------- | ---------------- |
| `transactional` | none (still blocked by hard suppression) | optional         |
| `relationship`  | `granted` or `implied` (also `unknown` if the workspace allows it) | required |
| `marketing`     | `granted` (or `implied` if the workspace explicitly allows it) | required |

Eligibility is evaluated when a message is created **and again at the final
sending stage**, so a contact who unsubscribes from one workflow cannot receive
a queued email from another. The central `suppressions` table covers
unsubscribes, hard bounces, complaints, invalid addresses and manual blocks.

## Templates

The template language is a small, safe Mustache-like dialect implemented in
`core`: escaped variables with filters (`{{first_name | default: "there"}}`),
`{{#if}}`/`{{#unless}}`/`{{else}}` blocks with simple comparisons, partials for
reusable snippets (`{{> footer}}`) and comments. There is deliberately no
"raw" output: contact data can never become executable HTML. URL-context
variables are checked for safe schemes. Author HTML is sanitised on save and
previews render inside sandboxed iframes.

## Providers

`EmailProvider` exposes `send`, `verify`, `parseWebhook` and a capability
descriptor (delivery events, open/click tracking, idempotency, webhooks).
Provider events flow through one ingestion path that is idempotent
(`provider_event_id` uniqueness) and order-independent (status precedence:
a late `accepted` never overrides `delivered`; `bounced`/`complained` win).
Analytics never treat provider acceptance as delivery.

## Security

* Sessions are random tokens stored hashed; cookies are `HttpOnly`,
  `SameSite=Lax`; mutating cookie requests require a CSRF token.
* API keys are workspace-scoped, role-scoped and stored hashed.
* Roles: `owner`, `admin`, `manager` (campaign manager), `analyst`
  (read-only). Permissions are checked in services, so HTTP, CLI and jobs share
  the same rules.
* Provider secrets are encrypted at rest with AES-256-GCM using
  `MORROW_SECRET_KEY` and are never returned by the API.
* Logs redact e-mail addresses, tokens and message bodies.

## Why not …

* **Redis/BullMQ** — another stateful service to run and back up, with no
  benefit at this scale. The queue interface allows swapping later.
* **An ORM** — Kysely gives typed SQL that runs unchanged on SQLite and
  Postgres, with explicit control over locking and conflict handling.
* **A visual canvas with free-form nodes** — Morrow's builder is a vertical
  flow (trigger → conditions → steps, with branches) where every node maps to
  executable logic. No decorative nodes.
