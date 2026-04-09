import { Toaster } from '@/components/ui/sonner';
import { Route, Routes } from 'react-router-dom';

export function App() {
  return (
    <>
      <Routes>
        <Route
          path="*"
          element={
            <main className="grid min-h-screen place-items-center">
              <h1 className="text-4xl font-bold">AgentScope</h1>
            </main>
          }
        />
      </Routes>
      <Toaster />
    </>
  );
}
