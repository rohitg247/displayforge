import { Outlet } from 'react-router-dom';
import { AdminHeader } from './AdminHeader';
import { AdminNav } from './AdminNav';

export function AdminLayout() {
  return (
    <div className="min-h-screen gradient-bg">
      <AdminHeader />
      <div className="flex">
        <AdminNav />
        <main className="flex-1 p-8 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
