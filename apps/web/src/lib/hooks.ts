import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useToast } from './toast';

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * A mutation that toasts its outcome and refreshes related queries.
 * `success` may be a message or a function of the result.
 */
export function useAction<TInput, TResult>(
  fn: (input: TInput) => Promise<TResult>,
  options: { success?: string | ((r: TResult) => string); invalidate?: QueryKey[]; onSuccess?: (r: TResult) => void } = {},
) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (result) => {
      for (const key of options.invalidate ?? []) await qc.invalidateQueries({ queryKey: key });
      if (options.success) toast.success(typeof options.success === 'function' ? options.success(result) : options.success);
      options.onSuccess?.(result);
    },
    onError: (err) => toast.error(err),
  });
}

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} · Morrow` : 'Morrow';
  }, [title]);
}
