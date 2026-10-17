# HTTP API

Everything the web app does goes through this API, so anything you can click
you can also script. The base path is `/api/v1`. Requests and responses are
JSON (CSV uploads may be sent as `text/csv`).

The typed TypeScript client in [`packages/sdk`](../packages/sdk) wraps every
endpoint below — prefer it from Node, Deno, Bun or the browser:

```ts
import { MorrowClient } from '@morrow/sdk';

const morrow = new MorrowClient({ baseUrl: 'https://morrow.example.com', token: process.env.MORROW_API_KEY });
await morrow.contacts.create({ email: 'ravi@example.com', firstName: 'Ravi', birthday: { month: 3, day: 7 }, consentStatus: 'granted', consentSource: 'Signed up at DevConf' });
await morrow.events.record({ email: 'ravi@example.com', name: 'project.completed', properties: { project_name: 'Orbit' }, dedupeKey: 'orbit-done' });
```

## Authentication

| Method | How | Use it for |
| --- | --- | --- |
| **API key** | `Authorization: Bearer mrw_<prefix>_<secret>` | Integrations, scripts, other products (e.g. Cyphen services). Created in Settings → API keys or `morrow api-keys create`. Bound to one workspace and one role; never more powerful than its creator. |
| **Session token** | `POST /auth/login` with `"issueToken": true`, then `Authorization: Bearer <token>` | The CLI signing in as a person. |
| **Session cookie** | `POST /auth/login` sets an `HttpOnly`, `SameSite=Lax` cookie | The web app. Every `POST/PUT/PATCH/DELETE` must send the `X-CSRF-Token` header from the session. |

Bodies on write requests must be `application/json` (or `text/csv` for
`POST /imports`), which blocks cross-site form posts. A session may act in a
different workspace it belongs to with `X-Morrow-Workspace: <workspace id>`.

## Conventions

- IDs are prefixed strings: `con_…`, `tpl_…`, `aut_…`, `cmp_…`, `msg_…`.
- Timestamps are ISO-8601 UTC. Calendar dates (`birthday`, analytics `from`/`to`)
  are `YYYY-MM-DD` in the **workspace time zone**.
- Lists return `{ items: [...] }`; paged lists add `total`, `page`, `pageSize`
  (`?page=2&pageSize=100`, max 200).
- Errors use one envelope and meaningful status codes:

```json
{ "error": { "code": "validation_error", "message": "email: Enter a valid e-mail address.",
             "details": { "issues": [{ "path": "email", "message": "Enter a valid e-mail address." }] },
             "requestId": "Zr2k9…" } }
```

| Status | `code` |
| --- | --- |
| 400 | `bad_request` (malformed JSON, wrong content type) |
| 401 | `unauthorized` |
| 403 | `forbidden` (role lacks the permission, or CSRF failed) |
| 404 | `not_found` (also for other workspaces' records) |
| 409 | `conflict` |
| 412 | `precondition_failed` (e.g. activating an automation with problems) |
| 413 | `payload_too_large` (2 MB JSON, 30 MB CSV) |
| 422 | `validation_error` with field `issues` |
| 429 | `rate_limited` with `Retry-After` |

## Endpoints

### Auth — `/auth`

| | |
| --- | --- |
| `GET /auth/setup` | Version, whether any account exists, whether sign-up is open (public). |
| `POST /auth/signup` | Create an account and workspace. |
| `POST /auth/login` | Sign in (`issueToken: true` for a bearer token). |
| `POST /auth/logout` | End the session. |
| `GET /auth/session` | Current user, workspace, role, permissions and CSRF token. |
| `GET /auth/whoami` | Works for sessions and API keys. |
| `POST /auth/switch-workspace` · `POST /auth/workspaces` | Switch or create workspaces. |
| `POST /auth/password` | Change password (signs out other sessions). |
| `GET /auth/invitations/:token` · `POST /auth/invitations/:token/accept` | Inspect and accept invitations. |

### Workspace

`GET|PATCH|DELETE /workspace` · `GET /dashboard?from&to` ·
`GET /members` · `PATCH|DELETE /members/:id` ·
`GET|POST /invitations` · `DELETE /invitations/:id` ·
`GET|POST /api-keys` · `DELETE /api-keys/:id` ·
`GET /audit?action&entityType&entityId&before&limit`

### Contacts

| | |
| --- | --- |
| `GET /contacts` | `q, status, relationshipType, tag, consent, segmentId, hasBirthday, sort, dir, page, pageSize` |
| `POST /contacts/search` | Same, plus `criteria` in the segment rule language. |
| `POST /contacts` · `GET|PATCH /contacts/:id` | Create, read, update. |
| `POST /contacts/:id/archive` · `/restore` | Archive keeps history and stops all sending. |
| `POST /contacts/:id/erase` | Body `{"confirm":"erase"}`. Permanently removes personal data; the address stays suppressed. |
| `POST /contacts/bulk` | `archive`, `restore`, `add_tag`, `remove_tag` for up to 1000 IDs. |
| `GET|PUT /contacts/:id/consent` | Consent history / record a change with its source. |
| `GET|POST /contacts/:id/notes` · `DELETE /contacts/:id/notes/:noteId` | Notes. |
| `GET /contacts/:id/timeline` | E-mails, events, notes, consent, tasks and automation steps. |
| `GET /contacts/export` | Streamed CSV (formula-injection safe, audited). |
| `GET /occasions/upcoming?days&kinds` | Birthdays and work anniversaries in the workspace zone. |
| `POST /events` | Record a custom event (`name`, `contactId` or `email`, `properties`, `dedupeKey`, optional `contact` to create). Triggers event automations. |
| `GET|POST /tags` · `PATCH|DELETE /tags/:id` | Tags. |
| `GET|POST /fields` · `PATCH|DELETE /fields/:id` | Custom fields (`text`, `number`, `date`, `boolean`, `select`, `url`). |

### Segments and imports

`GET|POST /segments` · `POST /segments/preview` · `GET|PATCH|DELETE /segments/:id` · `POST /segments/:id/refresh`

`GET /imports` · `POST /imports` (JSON `{filename, csv}` or `text/csv` with `?filename=`) ·
`GET /imports/:id` · `POST /imports/:id/preview` · `POST /imports/:id/commit`
(`mapping` is one target per column; `triggerAutomations` defaults to false).

### Templates

`GET|POST /templates` · `GET|PATCH /templates/:id` · `POST /templates/:id/publish` ·
`GET /templates/:id/versions` · `POST /templates/:id/versions/:versionId/restore` ·
`POST /templates/:id/duplicate|archive|restore` ·
`POST /templates/:id/render` (`which`, `versionId`, `contactId`) ·
`POST /templates/render` (unsaved content) ·
`POST /templates/:id/test` (workspace members only) ·
`GET /variables` · `GET|POST /snippets` · `PATCH|DELETE /snippets/:id`

### Automations

`GET|POST /automations` · `POST /automations/validate` · `GET|PATCH /automations/:id` ·
`POST /automations/:id/activate` (`deliveryMode`: `review` | `auto`) ·
`POST /automations/:id/delivery-mode` · `/pause` · `/resume` · `/archive` · `/restore` · `/duplicate` ·
`POST /automations/:id/dry-run` (`at`, `contactIds`, `limit`, unsaved `definition`) ·
`POST /automations/:id/run` (manual: `contactIds` or `segmentId`) ·
`GET /automations/:id/runs` · `GET /automation-runs/:runId` · `POST /automation-runs/:runId/cancel`

### Campaigns, messages and approvals

`GET|POST /campaigns` · `GET|PATCH|DELETE /campaigns/:id` · `POST /campaigns/:id/duplicate` ·
`GET /campaigns/:id/preflight` · `POST /campaigns/:id/test` ·
`POST /campaigns/:id/schedule` (`scheduledAt` must be in the future) ·
`POST /campaigns/:id/launch` · `/approve` · `/reject` · `/pause` · `/resume` · `/cancel` ·
`GET /campaigns/:id/recipients?status=sent|failed|skipped|pending` · `POST /campaigns/:id/summary` (AI)

`GET /messages` · `GET /messages/:id` · `POST /messages/:id/cancel` ·
`GET /approvals` · `POST /approvals/approve` · `POST /approvals/reject`

### Insights

`GET /analytics/overview|timeseries|campaigns|automations|failures?from&to` ·
`GET /analytics/export` (CSV) · `GET /calendar?from&to` ·
`GET|POST /tasks` · `GET|PATCH|DELETE /tasks/:id` ·
`GET /notifications` · `POST /notifications/read`

### Sending, AI and system

`GET|POST /senders` · `PATCH|DELETE /senders/:id` · `POST /senders/:id/send-verification` ·
`POST /senders/:id/mark-verified` · `GET /senders/:id/dns` ·
`GET /integrations/providers` · `GET|PUT|DELETE /integrations/email` · `POST /integrations/email/test` ·
`GET|PUT /integrations/ai` · `POST /ai/draft|rewrite|adapt|subjects` ·
`GET|POST /suppressions` · `POST /suppressions/:id/lift` ·
`GET /system/health` · `GET /system/jobs` · `POST /system/jobs/:id/retry|cancel`

## Public endpoints (no authentication)

| | |
| --- | --- |
| `GET /u/:token` · `POST /u/:token` | Unsubscribe page; `List-Unsubscribe=One-Click` POST (RFC 8058); resubscribe. |
| `GET /t/o/:token` · `GET /t/c/:token` | Open pixel and click redirect (signed tokens only). |
| `GET /verify-sender/:token` | Sender verification link. |
| `POST /webhooks/:provider/:integrationId` | Provider events (signature or Basic auth verified). |
| `GET /healthz` · `GET /readyz` · `GET /metrics` | Operations — see [deployment.md](deployment.md). |

## Rate limits

Sign-in: 10 attempts per 15 minutes per IP and address. Sign-up and invitation
acceptance: 10 per hour per IP. API: 1,200 requests per minute per user or key.
Test sends, AI calls, exports and DNS checks: 30 per minute. Limits are per
server process.
