# Setting up Morrow

This guide takes you from a fresh clone to a running workspace, first on your
own machine and then on a server. Everything here was run against the code in
this repository.

## Requirements

- **Node.js 22.12 or newer** (`node --version`). Node 24 also works.
- npm 10+ (bundled with Node).
- For production: **PostgreSQL 14+** (recommended) or a persistent disk for SQLite.
- A C/C++ toolchain only if `better-sqlite3` has no prebuilt binary for your
  platform (rare on Windows/macOS/Linux x64 and arm64).

## 1. Install

```bash
git clone https://github.com/AmmaarBakshi/Morrow.git
cd Morrow
npm install
```

## 2. Configure

```bash
npm run morrow -- init
```

`morrow init` writes a `.env` with a freshly generated `MORROW_SECRET_KEY`,
creates `./data/` and applies the database migrations. It refuses to overwrite
an existing `.env` (pass `--force` to rotate everything). Every variable is
documented in [`.env.example`](../.env.example) and in
[configuration.md](configuration.md).

By default Morrow uses **SQLite** (`sqlite:./data/morrow.db`) and the
**development inbox** e-mail provider (`MORROW_EMAIL_PROVIDER=fake`): messages
are stored inside Morrow and never leave your machine.

## 3. Try it with demo data

```bash
npm run morrow -- seed --demo
npm run dev
```

- API + worker + scheduler: <http://localhost:4400>
- Web app (Vite, hot reload): <http://localhost:5173>

Sign in as `demo@morrow.local` / `morrow-demo-password`. The demo workspace has
40 contacts (all `@example.com`), birthdays spread over the coming weeks, three
segments, the starter templates, and the **Birthday greetings** automation
active in *review mode* — greetings queue up under **Approvals** instead of
being sent.

To start empty instead, skip the seed and open <http://localhost:5173>: the
first account you create becomes the owner of the first workspace.

## 4. Check the installation

```bash
npm run morrow -- doctor
```

`doctor` checks Node, configuration, the secret key, the database, pending
migrations, the queue and whether the scheduler has run. It exits non-zero if
anything fails.

## 5. Production build

```bash
npm run build          # web app, server bundle and CLI bundle
MORROW_ENV=production node apps/cli/dist/bin.js start
```

`start` runs the HTTP server, a worker and the scheduler in one process,
applies migrations on boot and serves the built web app from `apps/web/dist`.
Before going live, read [deployment.md](deployment.md): production requires
an `https://` `MORROW_PUBLIC_URL`, a real secret key, a real e-mail provider and
a verified sender.

## First steps in a new workspace

1. **Settings → Sending**: connect an e-mail provider (SMTP, Resend or
   Postmark), add a sender address and verify it. Run the DNS check and fix
   SPF/DKIM/DMARC — see [providers.md](providers.md).
2. **Settings → Workspace**: set the time zone, company name, postal address
   (required in marketing footers) and the consent policy.
3. **Contacts → Import CSV**, or add people by hand. Record where consent came
   from.
4. **Templates**: review the starter templates and publish your own.
5. **Automations → Birthday greetings**: dry-run it for tomorrow's date, then
   activate it in review mode. Once you trust it, an admin can approve
   automatic delivery.

## Running tests

```bash
npm test               # whole suite on SQLite (in-memory)
npm run test:pg        # whole suite on PostgreSQL (embedded PGlite, no server needed)
npm run typecheck
```

No test sends real e-mail: tests use the in-process fake provider and a manual
clock.
