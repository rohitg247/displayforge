import { Navigate } from 'react-router-dom';
import { useApp } from '@/context/AppContext';

export function ProtectedRoute({ children }) {
  const { state } = useApp();

  if (state.loading) {
    return (
      <div className="min-h-screen gradient-bg flex items-center justify-center">
        <div className="text-foreground text-lg">Loading...</div>
      </div>
    );
  }

  if (!state.isAuthenticated) {
    return <Navigate to="/admin/login" replace />;
  }

  return <>{children}</>;
}
