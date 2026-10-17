# Deploying Morrow

Morrow is one Node.js application with three roles that coordinate only
through the database:

- **server** — the HTTP API, the web app, unsubscribe/tracking pages and
  provider webhooks;
- **worker** — sends e-mail, runs automation steps, processes webhooks and
  imports (run as many as you like);
- **scheduler** — evaluates birthdays, schedules, waits and scheduled
  campaigns, and does maintenance (run one; extra ones stand by — a lease in the
  database keeps a single leader, and duplicate work is harmless anyway).

A single process can run all three (`morrow start`), which is the right choice
for most installations.

## Checklist before going live

- [ ] `MORROW_ENV=production`
- [ ] `MORROW_SECRET_KEY` set to a long random value and **backed up** (losing it
      loses stored provider credentials and breaks old links)
- [ ] `MORROW_PUBLIC_URL=https://…` reachable from the internet
- [ ] PostgreSQL (or SQLite on a persistent, backed-up disk)
- [ ] An e-mail provider configured, a verified sender, SPF/DKIM/DMARC passing
      (`morrow dns check <domain>`)
- [ ] Provider webhooks pointing at Morrow (Resend/Postmark)
- [ ] Workspace postal address set (Settings → Workspace)
- [ ] `morrow doctor` passes
- [ ] Backups scheduled and a restore tested

## Docker Compose (PostgreSQL)

```bash
export MORROW_SECRET_KEY="$(openssl rand -base64 32)"
export MORROW_PUBLIC_URL="https://morrow.example.com"
docker compose up -d --build
docker compose logs -f morrow
```

The image runs as a non-root user, applies migrations on start, exposes port
4400 and has a health check on `/healthz`. The compose file starts with the
development inbox so you can try it safely; set `MORROW_EMAIL_PROVIDER` and the
provider variables (or configure the provider per workspace) before sending for
real.

To scale background work separately:

```bash
docker compose --profile split up -d --scale worker=3
```

## Docker (single container, SQLite)

```bash
docker build -t morrow .
docker run -d --name morrow -p 4400:4400 \
  -v morrow-data:/app/data \
  -e MORROW_SECRET_KEY="…" \
  -e MORROW_PUBLIC_URL="https://morrow.example.com" \
  -e MORROW_EMAIL_PROVIDER=resend -e RESEND_API_KEY=… -e RESEND_WEBHOOK_SECRET=… \
  morrow
```

## Bare metal / VM

```bash
npm ci && npm run build
MORROW_ENV=production node apps/cli/dist/bin.js start
```

Run it under a supervisor (systemd, PM2) and send `SIGTERM` to stop: Morrow
stops accepting requests, lets running jobs finish (up to 30 s) and releases
their leases so another worker can resume immediately.

Example systemd unit:

```ini
[Unit]
Description=Morrow
After=network-online.target postgresql.service

[Service]
WorkingDirectory=/opt/morrow
EnvironmentFile=/opt/morrow/.env
ExecStart=/usr/bin/node apps/cli/dist/bin.js start
Restart=always
User=morrow
KillSignal=SIGTERM
TimeoutStopSec=45

[Install]
WantedBy=multi-user.target
```

## Reverse proxy and HTTPS

Put Morrow behind a TLS-terminating proxy and set `MORROW_TRUST_PROXY=true`.
With Caddy:

```
morrow.example.com {
  reverse_proxy 127.0.0.1:4400
}
```

Morrow sets HSTS, CSP and the other security headers itself.

## Splitting roles

```bash
morrow server      # behind the load balancer, any number
morrow worker      # any number, anywhere with database access
morrow scheduler   # one (more are safe but idle)
```

All instances need the same `DATABASE_URL`, `MORROW_SECRET_KEY` and
`MORROW_PUBLIC_URL`. Use PostgreSQL when running more than one process:
workers claim jobs with `FOR UPDATE SKIP LOCKED`. SQLite serialises writes and
is meant for a single process.

Rate limiting is in memory per server process; with several API nodes, also
rate-limit at the load balancer.

## Monitoring

| Endpoint | Purpose |
| --- | --- |
| `GET /healthz` | Liveness: the process is up. |
| `GET /readyz` | Readiness: database reachable, queue healthy; `503` otherwise. Includes whether the scheduler is ticking. |
| `GET /metrics` | Prometheus text: jobs by type/status, queue lag, stuck jobs, messages in the last 24 h by status, seconds since the last scheduler tick, worker counters. Requires `Authorization: Bearer $MORROW_METRICS_TOKEN` in production. |

Useful alerts: queue lag above a few minutes, any `dead` jobs, the scheduler not
ticking for 5 minutes, a jump in bounces or complaints.

Logs are structured JSON on stdout (pretty in development). E-mail addresses
are masked and tokens, secrets and message bodies are never logged. Each
request carries an `X-Request-Id`, also included in API error responses.

## Upgrades and migrations

Migrations run automatically on `morrow start` (and with `morrow migrate`).
They are forward-only in production; `morrow migrate --status` lists what has
been applied. Upgrade by deploying the new version and restarting; workers that
are stopped mid-job release their leases so nothing is lost.

## Backups

- **PostgreSQL:** `pg_dump --format=custom morrow > morrow-$(date +%F).dump`
  nightly, plus point-in-time recovery if your host offers it. Restore with
  `pg_restore --clean --dbname=morrow morrow-YYYY-MM-DD.dump`.
- **SQLite:** `sqlite3 data/morrow.db ".backup 'morrow-$(date +%F).db'"` — safe
  while Morrow is running. Copying the file directly while running is not.
- Back up `MORROW_SECRET_KEY` separately and securely. A database backup without
  it cannot decrypt stored provider credentials (re-enter them) and links in
  e-mail already sent will stop working.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Birthdays did not go out | Is the scheduler running (`morrow doctor`, Settings → System)? Is the automation active? In review mode, greetings wait under **Approvals**. Dry-run the automation for that date to see why each contact was skipped. |
| "No consent for this kind of e-mail" | The contact's consent status doesn't allow that category. Record consent, or change the workspace consent policy if your jurisdiction allows it. |
| Messages stuck in *queued* | No worker running, or the queue is lagging — see Settings → System and `/metrics`. |
| Messages marked *uncertain* | A worker stopped after the provider accepted the message but before Morrow saved the result, with a provider that cannot de-duplicate. Check the provider's log before re-sending. |
| Delivery rate shows "—" | The provider doesn't report deliveries (SMTP) or webhooks aren't configured. |
| Unsubscribe links are broken | `MORROW_PUBLIC_URL` is wrong or not reachable, or `MORROW_SECRET_KEY` changed. |
| `Missing or invalid CSRF token` | The page is stale after a sign-in elsewhere; reload. |
| 429 responses | Rate limits: sign-in attempts are limited per IP and address; API keys per key. |
