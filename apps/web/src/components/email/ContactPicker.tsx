import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../lib/api';
import { useDebounced } from '../../lib/hooks';
import { Input, Select } from '../ui/field';

/** Search-and-pick a contact (for previews and test data). Empty = sample data. */
export function ContactPicker({ value, onChange, emptyLabel = 'Sample contact' }: { value: string | null; onChange(id: string | null): void; emptyLabel?: string }) {
  const [q, setQ] = useState('');
  const query = useDebounced(q);
  const list = useQuery({ queryKey: ['contact-picker', query], queryFn: () => api.contacts.list({ q: query || undefined, pageSize: 25 }) });
  return (
    <div className="flex gap-2">
      <Input className="w-40" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search contacts" />
      <Select className="min-w-0 flex-1" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} aria-label="Preview as contact">
        <option value="">{emptyLabel}</option>
        {list.data?.items.map((c) => (
          <option key={c.id} value={c.id}>
            {c.fullName}
            {c.email ? ` <${c.email}>` : ''}
          </option>
        ))}
      </Select>
    </div>
  );
}
