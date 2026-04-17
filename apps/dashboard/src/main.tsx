import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ErrorBoundary } from './components/error-boundary';
import { PrivyProvider } from './lib/privy';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 10s balances freshness against request volume. SSE events trigger
      // targeted invalidations for alerts/transactions, so this mostly
      // affects background refetches on tab focus.
      staleTime: 10_000,
      retry: 1,
    },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <PrivyProvider>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </QueryClientProvider>
      </PrivyProvider>
    </ErrorBoundary>
  </StrictMode>,
);
