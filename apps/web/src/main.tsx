import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { isApiError } from './lib/api';
import { SessionProvider } from './lib/session';
import { ThemeProvider } from './lib/theme';
import { ToastProvider } from './lib/toast';
import { router } from './routes';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Client errors (validation, permissions, not found) are final; retry only server/network trouble.
      retry: (count, err) => !(isApiError(err) && err.status < 500) && count < 2,
      refetchOnWindowFocus: false,
      staleTime: 15_000,
      // Keep the previous render while refetching so charts and tables never flash.
      placeholderData: (prev: unknown) => prev,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <SessionProvider>
            <RouterProvider router={router} />
          </SessionProvider>
        </ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
