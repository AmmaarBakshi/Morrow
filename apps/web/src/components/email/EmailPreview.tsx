import clsx from 'clsx';
import { Monitor, Smartphone } from 'lucide-react';
import { useState } from 'react';

/**
 * Renders e-mail HTML in a fully sandboxed iframe: no scripts, no
 * navigation, no access to the app. What you see is what recipients get.
 */
export function EmailPreview({ html, subject, previewText, from }: { html: string; subject?: string; previewText?: string; from?: string }) {
  const [mobile, setMobile] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 text-sm">
          {from ? <p className="truncate text-xs text-muted">From {from}</p> : null}
          <p className="truncate font-semibold text-ink">{subject || <span className="text-muted">(no subject)</span>}</p>
          {previewText ? <p className="truncate text-xs text-muted">{previewText}</p> : null}
        </div>
        <div className="flex shrink-0 rounded-lg border border-line p-0.5" role="group" aria-label="Preview width">
          <button type="button" onClick={() => setMobile(false)} aria-pressed={!mobile} className={clsx('rounded-md p-1.5', !mobile ? 'bg-surface-3 text-ink' : 'text-muted')} aria-label="Desktop">
            <Monitor className="size-4" />
          </button>
          <button type="button" onClick={() => setMobile(true)} aria-pressed={mobile} className={clsx('rounded-md p-1.5', mobile ? 'bg-surface-3 text-ink' : 'text-muted')} aria-label="Mobile">
            <Smartphone className="size-4" />
          </button>
        </div>
      </div>
      <div className="flex justify-center rounded-lg border border-line bg-[#f3f4f6] p-3">
        <iframe
          title="E-mail preview"
          sandbox=""
          srcDoc={html}
          className={clsx('h-[560px] rounded-md bg-white shadow-sm transition-[width]', mobile ? 'w-[375px] max-w-full' : 'w-full')}
        />
      </div>
    </div>
  );
}
