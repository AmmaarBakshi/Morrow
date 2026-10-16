# Morrow

**Automated email marketing, contact intelligence and relationship management for software teams.**

Morrow remembers the birthdays, follow-ups, anniversaries and announcements so your team
doesn't have to — and sends the right message at the right time, exactly once, only to people
who should receive it.

- **Contacts** with birthdays (month/day, year optional), work anniversaries, custom fields,
  tags, notes, consent history and CSV import/export.
- **Segments** built from nested rules, with a live audience preview.
- **Templates** in a safe Mustache-like language with snippets, versions, test sends and
  sandboxed desktop/mobile previews.
- **Automations** triggered by calendar dates, events, inactivity, schedules or segment entry,
  with waits, if/else branches, tasks, a dry run and an optional human-review mode.
- **Campaigns** with preflight checks, scheduling and per-recipient results.
- **Analytics** that only count what your provider reports — acceptance is never delivery,
  and opens are labelled as estimates.
- **Multi-workspace**, role-based access (owner, admin, manager, analyst), API keys, an audit
  log, and a `morrow` CLI for both operators and API users.

Optional AI assistance (Anthropic or any OpenAI-compatible API) drafts templates and summarises
results; it is never on the sending path.

## Quick start

Requires Node.js 22.12 or newer.

```sh
npm install
npm run morrow -- init      # writes .env with a fresh secret key and migrates the database
npm run db:seed             # optional: demo workspace with 40 example.com contacts
npm run dev                 # API on :4400, web app with reload on :5173
```

Open <http://localhost:5173>. With the demo seed, sign in as `demo@morrow.local` /
`morrow-demo-password`; otherwise the first visit walks you through creating an account.

By default e-mail goes to the built-in development inbox (`MORROW_EMAIL_PROVIDER=fake`): nothing
leaves your machine. Configure SMTP, Resend or Postmark in `.env` or per workspace under
**Settings → Sending**.

## Running in production

```sh
MORROW_SECRET_KEY=$(openssl rand -base64 32) docker compose up -d
```

This runs Morrow with PostgreSQL on port 4400. Put an HTTPS reverse proxy in front, set
`MORROW_PUBLIC_URL` to the public address (it appears in unsubscribe and tracking links) and
configure a real provider. `docker compose --profile split up -d --scale worker=3` runs the
worker separately from the API. Every setting is documented in [.env.example](.env.example).

Without Docker: `npm run build`, then `npx morrow start` runs everything in one process (or
`morrow server`, `morrow worker` and `morrow scheduler` separately). `morrow doctor` checks
configuration, database, migrations, queue and scheduler; `morrow dns check <domain>` verifies
SPF, DKIM, DMARC and MX records for a sending domain.

SQLite (`DATABASE_URL=sqlite:./data/morrow.db`) is fine for a single machine; PostgreSQL is
recommended for anything shared.

## Development

| Command             | What it does                                                   |
| ------------------- | -------------------------------------------------------------- |
| `npm run dev`       | API, worker and scheduler with reload, plus the Vite dev server |
| `npm test`          | Test suite on SQLite                                           |
| `npm run test:pg`   | Same suite on PostgreSQL (embedded PGlite, no server needed)   |
| `npm run typecheck` | TypeScript across all packages and the web app                 |
| `npm run build`     | Production bundles for web, server and CLI                     |
| `npm run morrow --` | Run the CLI from source, e.g. `npm run morrow -- contacts list` |

The repository is an npm workspace:

```
packages/core     pure domain logic (templates, calendar math, consent, schemas)
packages/db       Kysely schema and migrations for SQLite and PostgreSQL
packages/email    provider-independent delivery (SMTP, Resend, Postmark, dev inbox)
packages/ai       optional AI assistance behind a provider interface
packages/engine   services, durable job queue, worker, scheduler, automation executor
packages/sdk      typed HTTP client
apps/server       Hono API, unsubscribe/tracking endpoints, webhooks, static web hosting
apps/web          React single-page app
apps/cli          the `morrow` command
```

[docs/architecture.md](docs/architecture.md) explains the design: exactly-once sending, the
database-backed queue, the scheduler's catch-up rules, consent and suppression, and security.

## License

MIT, as declared in `package.json`.
