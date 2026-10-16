import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { WorkspaceSettings as Settings } from '@morrow/core';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Card, CardHeader, Notice } from '../../components/ui/display';
import { Checkbox, Field, Input, Select } from '../../components/ui/field';
import { api } from '../../lib/api';
import { useAction } from '../../lib/hooks';
import { useSession, useWorkspace } from '../../lib/session';

const ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    return ['UTC', 'Asia/Kolkata', 'Europe/London', 'America/New_York'];
  }
})();

export function WorkspaceSettings() {
  const { workspace } = useWorkspace();
  const { can, signOut } = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(workspace.name);
  const [timezone, setTimezone] = useState(workspace.timezone);
  const [s, setS] = useState<Settings>(workspace.settings);
  const [vars, setVars] = useState<Array<[string, string]>>(Object.entries(workspace.settings.variables));
  const [deleting, setDeleting] = useState(false);
  const [confirmSlug, setConfirmSlug] = useState('');
  const editable = can('workspace:manage');

  const save = useAction(
    () => api.workspace.update({ name, timezone, settings: { ...s, variables: Object.fromEntries(vars.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v])) } }),
    { success: 'Settings saved', onSuccess: () => qc.invalidateQueries({ queryKey: ['session'] }) },
  );
  const remove = useAction(() => api.workspace.delete(confirmSlug), {
    success: 'Workspace deleted',
    onSuccess: async () => {
      await signOut();
      navigate('/login');
    },
  });
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((cur) => ({ ...cur, [k]: v }));

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader title="Workspace" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">{(id) => <Input id={id} value={name} disabled={!editable} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Time zone" hint="Birthdays, schedules and analytics days follow this zone.">
            {(id) => (
              <Select id={id} value={timezone} disabled={!editable} onChange={(e) => setTimezone(e.target.value)}>
                {ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
              </Select>
            )}
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader title="Brand and footer" description="Used in templates ({{company_name}}, {{brand_color}}) and the legally required marketing footer." />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Company name">{(id) => <Input id={id} value={s.companyName} disabled={!editable} onChange={(e) => set('companyName', e.target.value)} />}</Field>
          <Field label="Website">{(id) => <Input id={id} value={s.websiteUrl} disabled={!editable} onChange={(e) => set('websiteUrl', e.target.value)} placeholder="https://cyphen.dev" />}</Field>
          <Field label="Postal address" hint="Required in marketing e-mail in many countries." className="sm:col-span-2">{(id) => <Input id={id} value={s.companyAddress} disabled={!editable} onChange={(e) => set('companyAddress', e.target.value)} />}</Field>
          <Field label="Logo URL">{(id) => <Input id={id} value={s.logoUrl} disabled={!editable} onChange={(e) => set('logoUrl', e.target.value)} placeholder="https://…/logo.png" />}</Field>
          <Field label="Brand colour">
            {(id) => (
              <div className="flex gap-2">
                <input type="color" aria-label="Pick brand colour" value={s.brandColor} disabled={!editable} onChange={(e) => set('brandColor', e.target.value)} className="h-9 w-12 cursor-pointer rounded-lg border border-line-strong bg-surface p-1" />
                <Input id={id} value={s.brandColor} disabled={!editable} onChange={(e) => set('brandColor', e.target.value)} />
              </div>
            )}
          </Field>
          <Field label="Greeting when a first name is missing" hint={`“Hi ${s.fallbackFirstName || 'there'},”`}>{(id) => <Input id={id} value={s.fallbackFirstName} disabled={!editable} onChange={(e) => set('fallbackFirstName', e.target.value)} />}</Field>
          <Field label="Import date order">
            {(id) => (
              <Select id={id} value={s.dateOrder} disabled={!editable} onChange={(e) => set('dateOrder', e.target.value as Settings['dateOrder'])}>
                <option value="DMY">Day / month / year</option>
                <option value="MDY">Month / day / year</option>
                <option value="YMD">Year / month / day</option>
              </Select>
            )}
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader title="Workspace variables" description="Reusable values for templates, e.g. {{collaboration_url}} or {{latest_project_name}}. Lowercase letters, numbers and _." />
        <div className="flex flex-col gap-2">
          {vars.map(([k, v], i) => (
            <div key={i} className="flex gap-2">
              <Input className="w-56 font-mono text-xs" aria-label="Variable name" value={k} disabled={!editable} onChange={(e) => setVars(vars.map((x, j) => (j === i ? [e.target.value.toLowerCase(), x[1]] : x)))} placeholder="collaboration_url" />
              <Input className="min-w-0 flex-1" aria-label="Value" value={v} disabled={!editable} onChange={(e) => setVars(vars.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} />
              {editable ? <button type="button" className="px-1 text-muted hover:text-bad" aria-label="Remove variable" onClick={() => setVars(vars.filter((_, j) => j !== i))}><Trash2 className="size-4" /></button> : null}
            </div>
          ))}
          {editable ? <Button size="sm" variant="ghost" className="self-start" icon={<Plus className="size-3.5" />} onClick={() => setVars([...vars, ['', '']])}>Add variable</Button> : null}
        </div>
      </Card>

      <Card>
        <CardHeader title="Consent and sending rules" description="Morrow enforces these on every send. Transactional e-mail is never blocked by marketing consent." />
        <div className="flex flex-col gap-4">
          <Checkbox label="Allow implied consent for marketing" description="Only if your jurisdiction allows it (e.g. existing customers in some regions)." checked={s.consent.allowImpliedForMarketing} disabled={!editable} onChange={(e) => set('consent', { ...s.consent, allowImpliedForMarketing: e.target.checked })} />
          <Checkbox label="Allow relationship e-mail when consent is unknown" description="Birthday and follow-up notes to people you work with whose consent was never recorded." checked={s.consent.allowUnknownForRelationship} disabled={!editable} onChange={(e) => set('consent', { ...s.consent, allowUnknownForRelationship: e.target.checked })} />
          <Checkbox label="Campaigns need a second person to approve" checked={s.sending.requireCampaignApproval} disabled={!editable} onChange={(e) => set('sending', { ...s.sending, requireCampaignApproval: e.target.checked })} />
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Max per contact per day" hint="Marketing + relationship. 0 = no cap.">{(id) => <Input id={id} type="number" min={0} value={s.sending.dailyCapPerContact} disabled={!editable} onChange={(e) => set('sending', { ...s.sending, dailyCapPerContact: Number(e.target.value) })} />}</Field>
            <Field label="Max per contact per week">{(id) => <Input id={id} type="number" min={0} value={s.sending.weeklyCapPerContact} disabled={!editable} onChange={(e) => set('sending', { ...s.sending, weeklyCapPerContact: Number(e.target.value) })} />}</Field>
            <Field label="Sending speed (per second)">{(id) => <Input id={id} type="number" min={0.1} step={0.1} value={s.sending.ratePerSecond} disabled={!editable} onChange={(e) => set('sending', { ...s.sending, ratePerSecond: Number(e.target.value) })} />}</Field>
          </div>
          <div className="flex flex-wrap gap-6">
            <Checkbox label="Track clicks" checked={s.tracking.clicks} disabled={!editable} onChange={(e) => set('tracking', { ...s.tracking, clicks: e.target.checked })} />
            <Checkbox label="Track opens (estimate)" checked={s.tracking.opens} disabled={!editable} onChange={(e) => set('tracking', { ...s.tracking, opens: e.target.checked })} />
            <Checkbox label="Treat Gmail dots and +tags as the same address" checked={s.dedupe.gmailCanonical} disabled={!editable} onChange={(e) => set('dedupe', { gmailCanonical: e.target.checked })} />
          </div>
          <Field label="Keep message bodies for (days)" hint="Afterwards bodies are cleared; delivery history stays.">{(id) => <Input id={id} className="w-32" type="number" min={7} value={s.retention.messageBodyDays} disabled={!editable} onChange={(e) => set('retention', { messageBodyDays: Number(e.target.value) })} />}</Field>
        </div>
      </Card>

      {editable ? (
        <div className="flex justify-end">
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save settings</Button>
        </div>
      ) : (
        <Notice>Only administrators can change workspace settings.</Notice>
      )}

      {can('workspace:delete') ? (
        <Card className="border-bad/40">
          <CardHeader title="Delete workspace" description="Removes every contact, template, automation, campaign and message in this workspace. This cannot be undone." action={<Button variant="danger" onClick={() => setDeleting(true)}>Delete…</Button>} />
        </Card>
      ) : null}
      <Dialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title="Delete this workspace?"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(false)}>Cancel</Button>
            <Button variant="danger" disabled={confirmSlug !== workspace.slug} loading={remove.isPending} onClick={() => remove.mutate(undefined)}>Delete forever</Button>
          </>
        }
      >
        <Field label={<>Type <code className="font-mono">{workspace.slug}</code> to confirm</>}>{(id) => <Input id={id} value={confirmSlug} onChange={(e) => setConfirmSlug(e.target.value)} autoComplete="off" />}</Field>
      </Dialog>
    </div>
  );
}
