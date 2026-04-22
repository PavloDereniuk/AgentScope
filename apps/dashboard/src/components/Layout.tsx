import { Outlet } from 'react-router-dom';
import { Sidebar } from './shell/Sidebar';
import { TopBar } from './shell/TopBar';

export function Layout() {
  return (
    <div className="grid min-h-screen grid-cols-[232px_1fr] bg-surface text-fg md:grid-cols-[232px_1fr] max-[760px]:grid-cols-1">
      <Sidebar />
      <main className="flex min-w-0 flex-col">
        <TopBar />
        <div className="flex-1 overflow-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
