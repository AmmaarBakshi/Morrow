import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeft, CheckCircle2, FileUp, Upload } from 'lucide-react';
import { useState, type DragEvent } from 'react';
import { Link } from 'react-router';
import { CONSENT_STATUSES, IMPORT_FIELD_LABELS, IMPORT_FIELDS, type ConsentStatus, type DuplicateStrategy, type ImportDTO, type ImportPreviewDTO, type ImportReportDTO, type ImportTarget } from '@morrow/core';
import { Button, ButtonLink } from '../../components/ui/button';
import { Badge, Card, CardHeader, Notice, PageHeader } from '../../components/ui/display';
import { Checkbox, Field, Input, Select, Textarea } from '../../components/ui/field';
import { api, errorMessage } from '../../lib/api';
import { formatNumber } from '../../lib/format';
import { useDocumentTitle } from '../../lib/hooks';

type Step = 'upload' | 'map' | 'done';

const DUPLICATE_HELP: Record<DuplicateStrategy, string> = {
  update_empty: 'Fill in blanks on existing contacts; never overwrite what you already have.',
  overwrite: 'Replace existing values with the file’s values.',
  skip: 'Leave existing contacts untouched.',
};

export default function ImportPage() {
  useDocumentTitle('Import contacts');
  const [step, setStep] = useState<Step>('upload');
  const [upload, setUpload] = useState<ImportDTO | null>(null);
  const [mapping, setMapping] = useState<ImportTarget[]>([]);
  const [duplicateStrategy, setDuplicates] = useState<DuplicateStrategy>('update_empty');
  const [dateOrder, setDateOrder] = useState<'DMY' | 'MDY' | 'YMD'>('DMY');
  const [defaultConsent, setConsent] = useState<ConsentStatus>('unknown');
  const [consentSource, setConsentSource] = useState('');
  const [addTags, setAddTags] = useState('');
  const [trigger, setTrigger] = useState(false);
  const [preview, setPreview] = useState<ImportPreviewDTO | null>(null);
  const [report, setReport] = useState<ImportReportDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paste, setPaste] = useState('');
  const [dragging, setDragging] = useState(false);
  const fields = useQuery({ queryKey: ['fields'], queryFn: () => api.fields.list() });

  const options = () => ({ duplicateStrategy, dateOrder, defaultConsent, consentSource: consentSource.trim() || null, addTags: addTags.split(',').map((t) => t.trim()).filter(Boolean) });

  async function send(filename: string, csv: string) {
    setBusy(true);
    setError(null);
    try {
      const u = await api.imports.upload(filename, csv);
      setUpload(u);
      setMapping(u.suggestedMapping);
      setStep('map');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 30 * 1024 * 1024) return setError('Files up to 30 MB are supported. Split larger exports.');
    await send(file.name, await file.text());
  }

  async function runPreview() {
    if (!upload) return;
    setBusy(true);
    setError(null);
    try {
      setPreview(await api.imports.preview(upload.id, { mapping, options: options() }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!upload) return;
    setBusy(true);
    setError(null);
    try {
      setReport(await api.imports.commit(upload.id, { mapping, options: options(), triggerAutomations: trigger }));
      setStep('done');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const targetOptions: Array<{ value: ImportTarget; label: string }> = [
    { value: 'ignore', label: 'Don’t import' },
    ...IMPORT_FIELDS.map((f) => ({ value: f as ImportTarget, label: IMPORT_FIELD_LABELS[f] })),
    ...(fields.data?.items ?? []).map((f) => ({ value: `custom:${f.key}` as ImportTarget, label: `Custom: ${f.label}` })),
  ];

  return (
    <>
      <PageHeader
        back={
          <Link to="/contacts" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
            <ArrowLeft className="size-4" /> Contacts
          </Link>
        }
        title="Import contacts"
        description="Upload a CSV export from your CRM, spreadsheet or event tool. You will see exactly what changes before anything is saved."
      />
      <ol className="mb-6 flex items-center gap-3 text-sm">
        {(['upload', 'map', 'done'] as Step[]).map((s, i) => (
          <li key={s} className={clsx('flex items-center gap-2', step === s ? 'font-medium text-ink' : 'text-muted')}>
            <span className={clsx('flex size-6 items-center justify-center rounded-full text-xs', step === s ? 'bg-accent text-accent-ink' : 'bg-surface-2')}>{i + 1}</span>
            {['Upload', 'Map & review', 'Done'][i]}
          </li>
        ))}
      </ol>
      {error ? (
        <div className="mb-4">
          <Notice tone="bad">{error}</Notice>
        </div>
      ) : null}

      {step === 'upload' ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <label
              onDragOver={(e: DragEvent) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e: DragEvent) => {
                e.preventDefault();
                setDragging(false);
                void onFile(e.dataTransfer.files[0]);
              }}
              className={clsx('flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-6 py-14 text-center transition-colors', dragging ? 'border-accent bg-accent-soft' : 'border-line-strong hover:bg-surface-2')}
            >
              <FileUp className="size-8 text-muted" />
              <span className="text-sm font-medium">Drop a CSV here or click to choose</span>
              <span className="text-xs text-muted">UTF-8, comma or semicolon separated, up to 30 MB</span>
              <input type="file" accept=".csv,text/csv,text/plain" className="sr-only" onChange={(e) => void onFile(e.target.files?.[0])} />
            </label>
          </Card>
          <Card>
            <CardHeader title="Or paste rows" description="Include a header row." />
            <Textarea rows={8} className="font-mono text-xs" placeholder={'First name,Email,Birthday,Company\nRavi,ravi@example.com,07/03/1990,Northwind'} value={paste} onChange={(e) => setPaste(e.target.value)} aria-label="CSV text" />
            <div className="mt-3 flex justify-end">
              <Button variant="primary" icon={<Upload className="size-4" />} disabled={!paste.trim()} loading={busy} onClick={() => send('pasted.csv', paste)}>
                Continue
              </Button>
            </div>
          </Card>
        </div>
      ) : null}

      {step === 'map' && upload ? (
        <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
          <Card padded={false}>
            <div className="p-5 pb-3">
              <CardHeader title={`${upload.filename} · ${formatNumber(upload.rowCount)} rows`} description="Match each column to a Morrow field. We guessed from the headers." />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-y border-line text-left text-xs uppercase tracking-wide text-muted">
                    <th className="px-5 py-2 font-medium">Column</th>
                    <th className="px-5 py-2 font-medium">Sample</th>
                    <th className="px-5 py-2 font-medium">Import as</th>
                  </tr>
                </thead>
                <tbody>
                  {upload.headers.map((h, i) => (
                    <tr key={i} className="border-b border-line last:border-0">
                      <td className="px-5 py-2.5 font-medium">{h || <span className="text-muted">(blank)</span>}</td>
                      <td className="max-w-48 truncate px-5 py-2.5 text-ink-2">{upload.sample.map((r) => r[i]).filter(Boolean).slice(0, 2).join(' · ') || '—'}</td>
                      <td className="px-5 py-2">
                        <Select
                          aria-label={`Field for ${h}`}
                          value={mapping[i] ?? 'ignore'}
                          onChange={(e) => {
                            const next = [...mapping];
                            next[i] = e.target.value as ImportTarget;
                            setMapping(next);
                            setPreview(null);
                          }}
                        >
                          {targetOptions.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </Select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="flex flex-col gap-6">
            <Card>
              <CardHeader title="Options" />
              <div className="flex flex-col gap-4">
                <Field label="Existing contacts (matched by e-mail)" hint={DUPLICATE_HELP[duplicateStrategy]}>
                  {(id) => (
                    <Select id={id} value={duplicateStrategy} onChange={(e) => (setDuplicates(e.target.value as DuplicateStrategy), setPreview(null))}>
                      <option value="update_empty">Fill in missing details</option>
                      <option value="overwrite">Overwrite with file values</option>
                      <option value="skip">Skip</option>
                    </Select>
                  )}
                </Field>
                <Field label="Ambiguous dates like 03/04" hint="How to read dates where day and month could swap.">
                  {(id) => (
                    <Select id={id} value={dateOrder} onChange={(e) => (setDateOrder(e.target.value as 'DMY'), setPreview(null))}>
                      <option value="DMY">Day / month (03/04 = 3 April)</option>
                      <option value="MDY">Month / day (03/04 = 4 March)</option>
                      <option value="YMD">Year first</option>
                    </Select>
                  )}
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Consent for rows without one">
                    {(id) => (
                      <Select id={id} value={defaultConsent} onChange={(e) => (setConsent(e.target.value as ConsentStatus), setPreview(null))}>
                        {CONSENT_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label="Consent source">{(id) => <Input id={id} value={consentSource} onChange={(e) => setConsentSource(e.target.value)} placeholder="DevConf 2026 sign-ups" />}</Field>
                </div>
                {(defaultConsent === 'granted' || defaultConsent === 'implied') && !consentSource.trim() ? (
                  <Notice tone="warn">Say where this consent came from. Only mark consent your contacts actually gave.</Notice>
                ) : null}
                <Field label="Tag every imported contact">{(id) => <Input id={id} value={addTags} onChange={(e) => setAddTags(e.target.value)} placeholder="imported-oct-2026" />}</Field>
                <Checkbox label="Start “contact created” automations for new contacts" description="Off by default so an import never e-mails hundreds of people at once." checked={trigger} onChange={(e) => setTrigger(e.target.checked)} />
                <Button onClick={runPreview} loading={busy && !preview}>
                  Preview changes
                </Button>
              </div>
            </Card>

            {preview ? (
              <Card>
                <CardHeader title="What will happen" />
                <dl className="grid grid-cols-3 gap-3 text-center">
                  {[
                    ['Create', preview.willCreate, 'good'],
                    ['Update', preview.willUpdate, 'accent'],
                    ['Skip', preview.willSkip, 'neutral'],
                  ].map(([label, n]) => (
                    <div key={label as string} className="rounded-lg bg-surface-2 py-3">
                      <dt className="text-xs text-muted">{label}</dt>
                      <dd className="text-xl font-semibold">{formatNumber(n as number)}</dd>
                    </div>
                  ))}
                </dl>
                <ul className="mt-4 flex flex-col gap-1 text-[13px] text-ink-2">
                  <li>{formatNumber(preview.invalid)} invalid rows (not imported)</li>
                  <li>{formatNumber(preview.duplicatesInFile)} duplicate addresses within the file</li>
                  <li>{formatNumber(preview.suppressed)} addresses on your suppression list (imported, never e-mailed)</li>
                  {preview.conflicts ? <li>{formatNumber(preview.conflicts)} rows disagree with existing data</li> : null}
                </ul>
                {preview.issues.length ? (
                  <div className="mt-4 max-h-56 overflow-y-auto rounded-lg border border-line">
                    {preview.issues.slice(0, 100).map((i) => (
                      <div key={i.row} className="flex items-start gap-2 border-b border-line px-3 py-2 text-xs last:border-0">
                        <Badge tone={i.errors.length ? 'bad' : 'warn'}>Row {i.row}</Badge>
                        <span className="text-ink-2">{[...i.errors, ...i.warnings, ...(i.conflicts ?? [])].join(' · ')}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
                <Button variant="primary" className="mt-4 w-full" loading={busy} disabled={preview.willCreate + preview.willUpdate === 0} onClick={commit}>
                  Import {formatNumber(preview.willCreate + preview.willUpdate)} contacts
                </Button>
              </Card>
            ) : null}
          </div>
        </div>
      ) : null}

      {step === 'done' && report ? (
        <Card className="mx-auto max-w-lg text-center">
          <CheckCircle2 className="mx-auto size-10 text-good" />
          <h2 className="mt-3 text-lg font-semibold">Import complete</h2>
          <p className="mt-1 text-sm text-ink-2">
            {formatNumber(report.created)} created, {formatNumber(report.updated)} updated, {formatNumber(report.skipped)} skipped
            {report.failed ? `, ${formatNumber(report.failed)} failed` : ''}.
          </p>
          <div className="mt-5 flex justify-center gap-2">
            <ButtonLink to="/contacts" variant="primary">
              View contacts
            </ButtonLink>
            <Button
              onClick={() => {
                setStep('upload');
                setUpload(null);
                setPreview(null);
                setReport(null);
                setPaste('');
              }}
            >
              Import another file
            </Button>
          </div>
        </Card>
      ) : null}
    </>
  );
}
