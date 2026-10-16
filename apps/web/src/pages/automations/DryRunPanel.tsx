import { FlaskConical } from 'lucide-react';
import { useState } from 'react';
import type { AutomationDefinitionInput, DryRunResultDTO, DryRunStepDTO } from '@morrow/core';
import { EmailPreview } from '../../components/email/EmailPreview';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Badge, Card, CardHeader, Notice } from '../../components/ui/display';
import { Field, Input } from '../../components/ui/field';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/format';

const OUTCOME: Record<DryRunStepDTO['outcome'], { label: string; tone: 'good' | 'warn' | 'neutral' | 'bad' | 'accent' }> = {
  would_run: { label: 'runs', tone: 'good' },
  would_skip: { label: 'skipped', tone: 'warn' },
  would_wait: { label: 'waits', tone: 'accent' },
  would_end: { label: 'ends', tone: 'neutral' },
  blocked: { label: 'blocked', tone: 'bad' },
};

/** Simulate the automation (including unsaved edits) at any moment. Writes nothing, sends nothing. */
export function DryRunPanel({ automationId, definition, timezone }: { automationId: string; definition: AutomationDefinitionInput; timezone: string }) {
  const [at, setAt] = useState(() => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
  const [result, setResult] = useState<DryRunResultDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState<NonNullable<DryRunStepDTO['email']> | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.automations.dryRun(automationId, { at: new Date(at).toISOString(), definition, limit: 50 }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Dry run" description="See who would qualify and exactly what each step would do. Nothing is saved or sent." />
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Simulate at (your local time)" className="min-w-0 flex-1">
          {(id) => <Input id={id} type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />}
        </Field>
        <Button icon={<FlaskConical className="size-4" />} loading={busy} onClick={run}>
          Run simulation
        </Button>
      </div>
      {error ? <div className="mt-3"><Notice tone="bad">{error}</Notice></div> : null}
      {result ? (
        <div className="mt-4">
          <p className="text-sm">
            <strong>{result.qualified}</strong> of {result.candidates} candidate(s) qualify at {formatDateTime(result.simulatedAt, timezone)}.
            {result.truncated ? <span className="text-muted"> Showing the first {result.results.length}.</span> : null}
          </p>
          <ul className="mt-3 flex max-h-[28rem] flex-col gap-2 overflow-y-auto">
            {result.results.map((r) => (
              <li key={`${r.contact.id}-${r.eventKey}`} className="rounded-lg border border-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{r.contact.name}</span>
                  <span className="text-xs text-muted">{r.contact.email ?? 'no e-mail'}</span>
                  <Badge tone={r.qualified ? 'good' : 'neutral'}>{r.qualified ? 'qualifies' : 'does not qualify'}</Badge>
                  <span className="ml-auto font-mono text-[10px] text-muted">{r.eventKey}</span>
                </div>
                {r.reasons.length ? <p className="mt-1 text-xs text-muted">{r.reasons.join(' · ')}</p> : null}
                <ol className="mt-2 flex flex-col gap-1">
                  {r.steps.map((s, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-2 text-xs">
                      <Badge tone={OUTCOME[s.outcome].tone}>{OUTCOME[s.outcome].label}</Badge>
                      <span className="text-ink-2">{s.detail}</span>
                      {s.email ? (
                        <button className="text-accent-text hover:underline" onClick={() => setEmail(s.email!)}>
                          View e-mail
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </li>
            ))}
            {!result.results.length ? <li className="py-6 text-center text-sm text-muted">Nobody would be affected at that moment.</li> : null}
          </ul>
        </div>
      ) : null}
      <Dialog open={Boolean(email)} onClose={() => setEmail(null)} title="Simulated e-mail" description={email ? `To ${email.to} · ${email.category}` : undefined} size="xl">
        {email ? (
          <>
            {email.missing.length ? <div className="mb-3"><Notice tone="warn">Missing data: {email.missing.join(', ')} (fallbacks applied)</Notice></div> : null}
            <EmailPreview html={email.html} subject={email.subject} previewText={email.previewText} />
          </>
        ) : null}
      </Dialog>
    </Card>
  );
}
