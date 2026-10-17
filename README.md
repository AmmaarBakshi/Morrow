# Morrow

**Automated e-mail, contact intelligence and relationship management for software teams.**

Morrow remembers the birthdays, anniversaries, follow-ups and announcements so
your team doesn't have to — and sends the right message at the right time,
**exactly once**, and **only to people who should receive it**.

- **Contacts that mean something** — clients, leads, developers, collaborators,
  subscribers; birthdays (year optional), work anniversaries, tags, custom
  fields, notes, a full activity timeline, consent history with sources, and a
  previewed CSV import that never corrupts existing data.
- **Automations** — a vertical builder for birthday greetings, anniversaries,
  welcomes, proposal follow-ups, re-engagement and anything driven by your own
  events (`project.completed`, `proposal.sent`). Waits, branches, tags, tasks and
  team notifications. Dry-run any moment before going live. New automations
  start in review mode.
- **Campaigns** — pick a segment and a published template, see a preflight of
  exactly who gets it and why others don't, test, schedule or send, pause and
  cancel safely.
- **Template studio** — personalisation with safe fallbacks, snippets, a live
  sandboxed preview as any contact, version history, test sends, and optional
  AI drafting.
- **Honest analytics** — delivery, bounces, complaints, clicks and unsubscribes
  by local day in your time zone; opens clearly labelled as estimates; no
  pretending that "accepted" means "delivered".
- **Built-in compliance** — consent per message category, one-click unsubscribe
  (RFC 8058), suppression lists, postal-address footers, frequency caps, an audit
  log and right-to-erasure.
- **Provider-independent** — SMTP, Resend, Postmark or a development inbox,
  installation-wide or per workspace, with signed webhooks and DNS checks.
- **API, SDK and CLI first** — everything the web app does is available over a
  typed HTTP API, a TypeScript SDK and the `morrow` command line, so other
  products (Cyphen, your own) can drive it.

## Quick start

Requires Node.js 22.12+.

```bash
git clone https://github.com/AmmaarBakshi/Morrow.git
cd Morrow
npm install
npm run morrow -- init          # .env with a fresh secret, SQLite database, migrations
npm run morrow -- seed --demo   # optional demo workspace (example.com addresses only)
npm run dev                     # API on :4400, web app on :5173
```

Open <http://localhost:5173> and sign in as `demo@morrow.local` /
`morrow-demo-password`, or create the first account. Nothing leaves your
machine: the default provider is a development inbox.

With Docker and PostgreSQL:

```bash
MORROW_SECRET_KEY="$(openssl rand -base64 32)" docker compose up -d --build
```

## Documentation

| | |
| --- | --- |
| [Setup](docs/setup.md) | Install, configure, demo data, first steps, tests |
| [Configuration](docs/configuration.md) | Every environment variable and the production rules |
| [Providers & DNS](docs/providers.md) | SMTP, Resend, Postmark, webhooks, senders, SPF/DKIM/DMARC, unsubscribe |
| [Automations](docs/automations.md) | Triggers, steps, review mode, the birthday flow, exactly-once sending |
| [Deployment](docs/deployment.md) | Docker, roles, scaling, monitoring, backups, upgrades, troubleshooting |
| [HTTP API](docs/api.md) | Authentication, conventions, errors and every endpoint |
| [CLI](docs/cli.md) | Operating an installation and working with a workspace from the terminal |
| [Architecture](docs/architecture.md) | Packages, data model, queue, scheduler and the decisions behind them |

## Using Morrow from another product

```ts
import { MorrowClient } from '@morrow/sdk';

const morrow = new MorrowClient({ baseUrl: 'https://morrow.example.com', token: process.env.MORROW_API_KEY });

// A new user signed up in your product: create or update the contact…
await morrow.contacts.create({ email: user.email, firstName: user.firstName, relationshipType: 'subscriber', consentStatus: 'granted', consentSource: 'Product sign-up' });
// …and tell Morrow what happened. Event automations take it from there.
await morrow.events.record({ email: user.email, name: 'project.completed', properties: { project_name: project.name }, dedupeKey: `project-${project.id}` });
```

## Repository layout

```
packages/core     Pure domain logic (templates, calendars, segments, consent, permissions) — no I/O
packages/db       Kysely schema and migrations for SQLite and PostgreSQL
packages/email    Provider interface, SMTP / Resend / Postmark / development inbox, webhook verification
packages/ai       Optional AI drafting (Anthropic) behind a provider interface
packages/engine   Services, durable job queue, worker, scheduler, automation and campaign engines
packages/sdk      Typed HTTP client
apps/server       Hono HTTP API, public pages, webhooks, single-node runtime
apps/web          React web app
apps/cli          The `morrow` command line
```

## Development

```bash
npm run dev         # API with reload + Vite
npm test            # full test suite on SQLite
npm run test:pg     # the same suite on PostgreSQL (embedded, no server needed)
npm run typecheck
npm run build
```

Tests never send real e-mail. They run against in-memory databases with a
manual clock and an in-process fake provider, and cover the end-to-end
birthday flow, delivery retries and crash recovery, webhooks, consent and
suppression, segments, imports, campaigns, workspace isolation, permissions,
the HTTP API, the SDK and the CLI.

## License

MIT
