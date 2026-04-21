import { Link, useLocation } from 'react-router-dom';
import { BarChart3, Monitor, ChevronRight, Building2, Tv2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export function AdminNav() {
  const location = useLocation();

  const navItems = [
    { label: 'Dashboard', path: '/admin/dashboard', icon: BarChart3 },
    { label: 'Branches', path: '/admin/branches', icon: Building2 },
    { label: 'Displays', path: '/admin/displays', icon: Monitor },
    { label: 'Ambient Displays', path: '/admin/ambient', icon: Tv2 },
  ];

  return (
    <nav className="w-60 min-h-[calc(100vh-65px)] border-r border-border bg-card/30 p-4 flex flex-col gap-1">
      <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground px-3 mb-2">
        Navigation
      </p>
      {navItems.map((item) => {
        const Icon = item.icon;
        const isActive =
          location.pathname === item.path ||
          location.pathname.startsWith(item.path + '/');

        return (
          <Link
            key={item.path}
            to={item.path}
            className={cn(
              'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 group',
              isActive
                ? 'gradient-primary text-primary-foreground glow-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
            )}
          >
            <Icon size={18} />
            <span className="flex-1">{item.label}</span>
            {isActive && <ChevronRight size={14} className="opacity-70" />}
          </Link>
        );
      })}
    </nav>
  );
}
