import { Toaster } from '@/components/ui/sonner';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { AgentDetailPage } from './routes/agent-detail';
import { AgentsPage } from './routes/agents';
import { AlertsPage } from './routes/alerts';
import { SettingsPage } from './routes/settings';

export function App() {
  return (
    <>
      <Routes>
        <Route
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Navigate to="/agents" replace />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="agents/:id" element={<AgentDetailPage />} />
          <Route path="alerts" element={<AlertsPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/agents" replace />} />
      </Routes>
      <Toaster />
    </>
  );
}
