# Automations

An automation is **trigger → optional entry conditions → steps**. Definitions are
versioned: saving creates a new version, and contacts already in a run finish
on the version they started with.

## Triggers

| Trigger | Fires when |
| --- | --- |
| Calendar date | A contact's birthday, work anniversary or custom date field comes round — at a local send time, optionally days before/after, in the workspace's or each contact's time zone. |
| Contact created / updated | A contact is added, or specific fields change. |
| Segment entered | A contact starts matching a segment. |
| Consent changed | Consent moves to one of the chosen statuses. |
| Tag added | A tag is applied. |
| Custom event | `POST /api/v1/events` (or the SDK / `morrow events send`) records e.g. `proposal.sent`. Event properties are available in templates as `{{event.<name>}}`. |
| Inactivity | No interaction for N days. |
| Schedule | Once, daily, weekly or monthly at a local time, for a segment or everyone. |
| Manual | Started by a person or the API for chosen contacts or a segment. |

## Steps

Send e-mail · Wait (minutes/hours/days) · Add/remove tag · Update field ·
Create follow-up task · Notify the team · Branch (if/else on any segment rule,
including "did they reply/click/open" and "did event X happen") · End.

## Delivery modes

- **Review** (default for every new automation): each e-mail is prepared — fully
  rendered, eligibility checked — and waits in **Approvals** until a person
  approves it.
- **Automatic**: sends without review. Only owners and admins can approve it,
  the approval is audited, and **any edit returns the automation to review mode**.

## The birthday flow, end to end

1. You add Ravi with birthday 7 March (year optional) and consent `granted`.
2. **Birthday greetings** is active: send at 09:00, workspace zone Asia/Kolkata.
3. Every scheduler tick, Morrow looks at each time zone in use. Once it is
   09:00 on 7 March in Kolkata, it finds contacts whose birthday is today there.
4. It creates a run keyed `birthday:2027-03-07`. That key is unique per
   automation and contact, so a second tick, a second scheduler or a restart
   cannot start another run for the same birthday.
5. The run renders the published template version (with fallbacks, e.g. "Hi
   there" when a first name is missing) and checks eligibility: active contact,
   a valid address, not suppressed, consent allows a relationship e-mail, within
   frequency caps.
6. In review mode the message waits in Approvals; in automatic mode it is queued.
   Either way the message has an idempotency key
   (`auto:<automation>:<contact>:birthday:2027-03-07:<step>`), unique per workspace.
7. A worker claims the send job, re-checks eligibility (an unsubscribe a minute
   ago still wins), moves the message `queued → sending` atomically and hands
   it to the provider with the unsubscribe headers.
8. Provider webhooks then mark it delivered, bounced or complained. Bounces and
   complaints suppress the address immediately.

### Leap years

A 29 February birthday follows the automation's policy in non-leap years:
celebrate on **28 February** (default), on **1 March**, or **only in leap years**.

### Downtime

Morrow keeps a per-zone cursor of the last local date it evaluated. If it was
down, the next tick catches up dates within the automation's **catch-up window**
(1 day by default, up to 7). Older occasions are recorded as *missed* in the
logs rather than greeting people days late.

### Testing safely

- **Dry run** (builder, `POST /automations/:id/dry-run`, `morrow automations
  dry-run`) simulates any moment — including unsaved edits — and shows who
  qualifies, why others don't, and each rendered e-mail. It writes nothing.
- The development inbox provider keeps every e-mail inside Morrow.
- Review mode means nothing goes out without a person approving it.

## Exactly once, in short

| Layer | Prevents |
| --- | --- |
| Unique run per automation + contact + occasion | Two runs for the same birthday |
| Unique message idempotency key per workspace | Two messages for the same step |
| Unique job dedupe key `send:<message>` | Two delivery jobs for one message |
| Atomic `queued → sending` claim | Two workers sending the same message |
| Provider idempotency keys (Resend) or the *uncertain* state | A crash between "provider accepted" and "saved" causing a resend |

Each layer alone stops a duplicate; together they survive crashes, retries and
several schedulers or workers running at once.
