# E-mail providers, senders and DNS

Morrow never sends mail itself: it hands each message to an **e-mail provider**
behind a common interface (`EmailProvider` in `packages/email`). You can set a
provider for the whole installation with environment variables, and each
workspace can override it in **Settings → Sending**. Workspace credentials are
encrypted at rest with `MORROW_SECRET_KEY` and are never returned by the API.

| Provider | Delivery / bounce events | Idempotent sends | Best for |
| --- | --- | --- | --- |
| **Development inbox** (`fake`) | simulated | yes | local development, demos, tests — nothing leaves Morrow |
| **SMTP** (`smtp`) | no (acceptance only) | no | any relay: Amazon SES SMTP, Mailgun, your own server |
| **Resend** (`resend`) | yes, signed webhooks | yes | the simplest production setup |
| **Postmark** (`postmark`) | yes, HTTP Basic webhooks | no | separate transactional and broadcast streams |

Analytics never treat "accepted by the provider" as "delivered". With SMTP,
delivery and bounce rates show as unavailable rather than as made-up numbers.

## Development inbox

`MORROW_EMAIL_PROVIDER=fake` (the default outside production). Messages are
stored and delivery, bounce and complaint events are simulated, so the whole
pipeline — analytics included — can be exercised safely. Addresses containing
`+bounce`, `+softbounce`, `+complaint`, `+reject`, `+fail` or `+flaky` trigger
the corresponding outcome. It is refused in production unless
`MORROW_ALLOW_DEV_PROVIDER=true`.

## SMTP

```env
MORROW_EMAIL_PROVIDER=smtp
SMTP_HOST=email-smtp.ap-south-1.amazonaws.com
SMTP_PORT=587
SMTP_SECURE=false        # true for implicit TLS on 465
SMTP_USERNAME=…
SMTP_PASSWORD=…
```

SMTP has no delivery webhooks: Morrow records acceptance by the relay. Handle
bounces at the relay (or use an API provider for full reporting).

## Resend

```env
MORROW_EMAIL_PROVIDER=resend
RESEND_API_KEY=re_…
RESEND_WEBHOOK_SECRET=whsec_…
```

In Resend → Webhooks, add Morrow's webhook URL and subscribe to `sent`,
`delivered`, `delivery_delayed`, `bounced`, `complained`, `opened` and
`clicked`. Paste the signing secret into Morrow. Every webhook is verified with
its Svix signature before anything is recorded; forged calls get `401`.

Resend honours idempotency keys, so if a worker crashes after handing a message
over, Morrow can safely retry it without risking a duplicate.

## Postmark

```env
MORROW_EMAIL_PROVIDER=postmark
POSTMARK_SERVER_TOKEN=…
POSTMARK_TRANSACTIONAL_STREAM=outbound
POSTMARK_BROADCAST_STREAM=broadcast       # marketing goes here
POSTMARK_WEBHOOK_USERNAME=…
POSTMARK_WEBHOOK_PASSWORD=…
```

In Postmark → Webhooks, add Morrow's webhook URL with HTTP Basic
authentication (the username and password above) and enable Delivery, Bounce,
Spam Complaint, Open, Click and Subscription Change.

Postmark does not honour idempotency keys. If a worker dies after Postmark
accepted a message but before Morrow stored the result, Morrow marks the message
**uncertain** instead of re-sending, and it shows up in analytics and the
message log for a person to check.

## Webhook URLs

```
https://<MORROW_PUBLIC_URL>/webhooks/<provider>/<integration-id>   # workspace provider
https://<MORROW_PUBLIC_URL>/webhooks/<provider>/default            # installation provider
```

The exact URL for a workspace is shown in **Settings → Sending** once the
provider is saved. Webhooks are acknowledged immediately and processed by the
worker; repeated or out-of-order events are harmless (a late "accepted" never
overrides "delivered", and each provider event is stored once).

## Senders and verification

Every message goes out from a **verified sender**. Add one in **Settings →
Sending → Senders** (or `POST /api/v1/senders`). Morrow e-mails a verification
link to the address; clicking it verifies the sender. An admin can also mark a
sender verified after confirming the domain at the provider — the note is kept
in the audit log.

## DNS: SPF, DKIM and DMARC

Inboxes trust authenticated domains. For each sending domain:

- **SPF** — a TXT record on the domain that includes your provider, e.g.
  `v=spf1 include:amazonses.com ~all`. Only one SPF record per domain.
- **DKIM** — CNAME/TXT records your provider gives you (selectors such as
  `resend._domainkey`, `pm._domainkey`, `s1._domainkey`).
- **DMARC** — a TXT record at `_dmarc.<domain>`, e.g.
  `v=DMARC1; p=quarantine; rua=mailto:dmarc@<domain>`. Start with `p=none`
  while you watch reports, then tighten.
- **MX** — needed if people will reply to the sending address.

Check a domain from the web app (**DNS** next to a sender) or the CLI:

```bash
morrow dns check cyphen.dev
morrow dns check cyphen.dev --selector resend
```

The check looks up SPF, DMARC, MX and common DKIM selectors (`resend`, `pm`,
`google`, `default`, `selector1`, `selector2`, `s1`, `s2`, `k1`, `mail`, `dkim`,
`mandrill`, `smtp`) and explains anything missing.

## Unsubscribe and compliance

- Marketing and relationship e-mail always carries an unsubscribe link and the
  `List-Unsubscribe` / `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
  headers (RFC 8058), so Gmail and Yahoo show their native unsubscribe button.
- Unsubscribing is instant, needs no login, works with one click from the mail
  client, and also withdraws consent and cancels anything queued for that person.
- Templates without `{{unsubscribe_url}}` get a standard footer with the
  company name, postal address and unsubscribe link appended automatically.
- Hard bounces, spam complaints and invalid addresses suppress the address for
  **all** mail immediately (transactional included). Unsubscribes suppress
  marketing and relationship mail; receipts and account notices still arrive.

## Adding a provider

Implement `EmailProvider` (`send`, `verify`, optional `parseWebhook`, and a
`capabilities` descriptor), classify failures with `ProviderError`
(`transient` is retried with backoff, `permanent` never is), then call
`registerProvider({ name, label, fields, webhook, create })`. The settings
screen, CLI and API pick it up automatically.
