import { LogOut, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '@/context/AppContext';
import { ActisButton } from '@/components/admin/ActisButton';

export function AdminHeader() {
  const navigate = useNavigate();
  const { logout } = useApp();

  const handleLogout = () => {
    logout();
    navigate('/admin/login');
  };

  return (
    <header className="border-b border-border bg-card/50 backdrop-blur-xl sticky top-0 z-30">
      <div className="flex items-center justify-between px-8 py-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg gradient-accent flex items-center justify-center">
            <Sparkles size={16} className="text-accent-foreground" />
          </div>
          <h1 className="text-xl font-bold text-foreground tracking-tight">
            Actis <span className="text-gradient-primary">Portal</span>
          </h1>
        </div>
        <ActisButton
          variant="outline"
          size="sm"
          onClick={handleLogout}
        >
          <LogOut size={16} />
          Logout
        </ActisButton>
      </div>
    </header>
  );
}
