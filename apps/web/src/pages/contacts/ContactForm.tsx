import { useState, type FormEvent } from 'react';
import { CONSENT_STATUSES, RELATIONSHIP_LABELS, RELATIONSHIP_TYPES, type ConsentStatus, type ContactCreateInput, type ContactDTO, type RelationshipType } from '@morrow/core';
import { Button } from '../../components/ui/button';
import { Notice } from '../../components/ui/display';
import { Field, Input, Select, Textarea } from '../../components/ui/field';
import { errorMessage } from '../../lib/api';
import { monthName } from '../../lib/format';

const CONSENT_HELP: Record<ConsentStatus, string> = {
  granted: 'They explicitly agreed to receive e-mail from you.',
  implied: 'An existing relationship (client, lead who asked for a proposal).',
  unknown: 'Not recorded — Morrow only sends relationship e-mail if your policy allows it.',
  withdrawn: 'They asked to stop. Only transactional e-mail is sent.',
};

export interface ContactFormValues {
  firstName: string;
  lastName: string;
  email: string;
  company: string;
  jobTitle: string;
  relationshipType: RelationshipType;
  bMonth: string;
  bDay: string;
  bYear: string;
  workAnniversary: string;
  tags: string;
  consentStatus: ConsentStatus;
  consentSource: string;
  timezone: string;
  language: string;
  note: string;
}

export function valuesFrom(c?: ContactDTO | null): ContactFormValues {
  return {
    firstName: c?.firstName ?? '',
    lastName: c?.lastName ?? '',
    email: c?.email ?? '',
    company: c?.company ?? '',
    jobTitle: c?.jobTitle ?? '',
    relationshipType: c?.relationshipType ?? 'subscriber',
    bMonth: c?.birthday ? String(c.birthday.month) : '',
    bDay: c?.birthday ? String(c.birthday.day) : '',
    bYear: c?.birthday?.year ? String(c.birthday.year) : '',
    workAnniversary: c?.workAnniversary ?? '',
    tags: c?.tags.map((t) => t.name).join(', ') ?? '',
    consentStatus: c?.consentStatus ?? 'unknown',
    consentSource: c?.consentSource ?? '',
    timezone: c?.timezone ?? '',
    language: c?.language ?? '',
    note: '',
  };
}

export function toInput(v: ContactFormValues, editing: boolean): ContactCreateInput {
  const input: ContactCreateInput = {
    firstName: v.firstName.trim() || null,
    lastName: v.lastName.trim() || null,
    email: v.email.trim() || null,
    company: v.company.trim() || null,
    jobTitle: v.jobTitle.trim() || null,
    relationshipType: v.relationshipType,
    birthday: v.bMonth && v.bDay ? { month: Number(v.bMonth), day: Number(v.bDay), year: v.bYear ? Number(v.bYear) : null } : null,
    workAnniversary: v.workAnniversary || null,
    tags: v.tags.split(',').map((t) => t.trim()).filter(Boolean),
    consentStatus: v.consentStatus,
    consentSource: v.consentSource.trim() || null,
    timezone: v.timezone.trim() || null,
    language: v.language.trim() || null,
  };
  if (!editing && v.note.trim()) input.note = v.note.trim();
  return input;
}

export function ContactForm({ initial, onSubmit, onCancel, submitLabel }: { initial?: ContactDTO | null; onSubmit(input: ContactCreateInput): Promise<unknown>; onCancel(): void; submitLabel: string }) {
  const [v, setV] = useState<ContactFormValues>(() => valuesFrom(initial));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof ContactFormValues>(k: K) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV((s) => ({ ...s, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(toInput(v, Boolean(initial)));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const days = Array.from({ length: 31 }, (_, i) => i + 1);
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name">{(id) => <Input id={id} value={v.firstName} onChange={set('firstName')} autoFocus />}</Field>
        <Field label="Last name">{(id) => <Input id={id} value={v.lastName} onChange={set('lastName')} />}</Field>
        <Field label="E-mail" className="sm:col-span-2">{(id) => <Input id={id} type="email" value={v.email} onChange={set('email')} />}</Field>
        <Field label="Company">{(id) => <Input id={id} value={v.company} onChange={set('company')} />}</Field>
        <Field label="Job title">{(id) => <Input id={id} value={v.jobTitle} onChange={set('jobTitle')} />}</Field>
        <Field label="Relationship">
          {(id) => (
            <Select id={id} value={v.relationshipType} onChange={set('relationshipType')}>
              {RELATIONSHIP_TYPES.map((t) => (
                <option key={t} value={t}>
                  {RELATIONSHIP_LABELS[t]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Tags" hint="Comma separated">{(id) => <Input id={id} value={v.tags} onChange={set('tags')} placeholder="vip, rust" />}</Field>
      </div>

      <fieldset className="grid gap-4 sm:grid-cols-[1fr_1fr_1fr_1.4fr]">
        <legend className="mb-1.5 text-[13px] font-medium">Birthday</legend>
        <Select aria-label="Birthday month" value={v.bMonth} onChange={set('bMonth')}>
          <option value="">Month</option>
          {Array.from({ length: 12 }, (_, i) => (
            <option key={i + 1} value={i + 1}>
              {monthName(i + 1)}
            </option>
          ))}
        </Select>
        <Select aria-label="Birthday day" value={v.bDay} onChange={set('bDay')}>
          <option value="">Day</option>
          {days.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </Select>
        <Input aria-label="Birth year (optional)" placeholder="Year (optional)" inputMode="numeric" value={v.bYear} onChange={set('bYear')} />
        <Field label="Work anniversary">{(id) => <Input id={id} type="date" value={v.workAnniversary} onChange={set('workAnniversary')} />}</Field>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Consent" hint={CONSENT_HELP[v.consentStatus]}>
          {(id) => (
            <Select id={id} value={v.consentStatus} onChange={set('consentStatus')}>
              {CONSENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s[0]!.toUpperCase() + s.slice(1)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Consent source" hint="Where and how it was given — required for granted or implied.">
          {(id) => <Input id={id} value={v.consentSource} onChange={set('consentSource')} placeholder="Newsletter form, 2026-10-01" />}
        </Field>
        <Field label="Time zone" hint="Used for birthday send times when the workspace is set to contact time zones.">
          {(id) => <Input id={id} value={v.timezone} onChange={set('timezone')} placeholder="Asia/Kolkata" />}
        </Field>
        <Field label="Language">{(id) => <Input id={id} value={v.language} onChange={set('language')} placeholder="en" />}</Field>
      </div>
      {!initial ? <Field label="Note">{(id) => <Textarea id={id} rows={2} value={v.note} onChange={set('note')} placeholder="How you met, what matters to them…" />}</Field> : null}

      <div className="flex justify-end gap-2 border-t border-line pt-4">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
