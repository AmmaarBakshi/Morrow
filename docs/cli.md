# The `morrow` CLI

One binary operates an installation **and** drives a workspace from the
terminal. Inside this repository run it with `npm run morrow -- <command>`;
after `npm run build` it is `node apps/cli/dist/bin.js` (or `morrow` in the
Docker image).

Global flags: `--json` (one JSON document on stdout, diagnostics on stderr),
`--profile <name>`, `--url <server>`, `--token <api key or session token>`.
Exit codes: `0` success, `1` failure, `2` could not reach the server. Set
`MORROW_DEBUG=1` for stack traces.

## Operating an installation

These talk to the database directly (`DATABASE_URL`, or `--database`), and read
`./.env` automatically.

```bash
morrow init                     # .env with a new secret key, data dir, migrations
morrow migrate                  # apply pending migrations   (--status, --down in dev)
morrow seed --demo              # demo workspace, example.com contacts, nothing sent
morrow start                    # server + worker + scheduler (--roles, --port, --no-web)
morrow server | worker | scheduler
morrow user create --email ops@cyphen.dev --name "Ops" --workspace "Cyphen"
morrow user reset-password --email ops@cyphen.dev
morrow doctor                   # config, secret, database, migrations, queue, scheduler
morrow dns check cyphen.dev     # SPF, DKIM, DMARC, MX
```

`user create` and `reset-password` print a generated password once when you
don't pass `--password`.

## Working with a workspace

Sign in once; credentials are stored in `~/.config/morrow/config.json`
(`%APPDATA%\morrow\config.json` on Windows, owner-only permissions, override with
`MORROW_CONFIG`). Or set `MORROW_URL` and `MORROW_API_KEY` for CI.

```bash
morrow --url https://morrow.example.com login --api-key mrw_…
morrow --url https://morrow.example.com login --email you@cyphen.dev   # prompts for the password
morrow whoami
morrow profiles
```

### Contacts and events

```bash
morrow contacts list --tag vip --type client
morrow contacts get con_…
morrow contacts add --email ravi@example.com --first-name Ravi --birthday 03-07 \
  --type developer --tag rust --consent granted --consent-source "DevConf sign-up"
morrow contacts update con_… --company "Northwind"
morrow contacts consent con_… withdrawn --source "Asked by phone"
morrow contacts import people.csv --tag devconf --consent granted --consent-source "DevConf 2026"   # previews, then asks
morrow contacts export -o contacts.csv

morrow events send proposal.sent --email lead@example.com --prop proposal_name="Atlas redesign" --dedupe proposal-42
morrow birthdays upcoming --days 14 --anniversaries
```

### Automations and approvals

```bash
morrow automations list
morrow automations show aut_…
morrow automations dry-run aut_… --at 2026-11-02T03:30:00Z --show-email
morrow automations activate aut_…          # review mode
morrow automations activate aut_… --auto   # send without review (admin)
morrow automations run aut_… --segment seg_…
morrow automations runs aut_…
morrow approvals list
morrow approvals approve msg_… msg_…
```

### Campaigns, templates and segments

```bash
morrow segments list
morrow segments preview seg_…
morrow templates list
morrow templates render tpl_… --contact con_… --html preview.html
morrow templates test tpl_…
morrow campaigns create --name "November update" --segment seg_… --template tpl_…
morrow campaigns preflight cmp_…
morrow campaigns launch cmp_…              # preflight, then confirm
morrow campaigns schedule cmp_… --at 2026-11-03T10:00:00+05:30
morrow campaigns show cmp_…
```

### Insights and operations

```bash
morrow analytics --from 2026-10-01 --to 2026-10-31
morrow analytics --campaigns
morrow calendar
morrow tasks list --mine
morrow health
morrow queue list --status dead
morrow queue retry job_…
morrow api-keys create "Cyphen website" --role manager --expires 365
```

Anything destructive or that sends e-mail asks for confirmation; pass `--yes`
in scripts. Without a terminal and without `--yes`, nothing is sent.
