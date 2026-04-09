import { Route, Routes } from 'react-router-dom';

export function App() {
  return (
    <Routes>
      <Route
        path="*"
        element={
          <main style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
            <h1>AgentScope</h1>
          </main>
        }
      />
    </Routes>
  );
}
