import { cn } from '@/lib/utils';

export function ActisButton({
  children,
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}) {
  const base = 'font-semibold rounded-lg transition-all duration-300 inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';

  const variants = {
    primary: 'gradient-primary text-primary-foreground hover:opacity-90 glow-primary hover:shadow-lg',
    secondary: 'bg-secondary text-secondary-foreground hover:bg-muted border border-border',
    accent: 'gradient-accent text-accent-foreground hover:opacity-90 glow-accent',
    outline: 'bg-transparent text-foreground border border-border hover:bg-secondary hover:border-muted-foreground/30',
    ghost: 'bg-transparent text-muted-foreground hover:text-foreground hover:bg-secondary',
    danger: 'bg-transparent text-accent border border-accent/30 hover:bg-accent/10',
  };

  const sizes = {
    sm: 'px-3 py-1.5 text-sm',
    md: 'px-5 py-2.5 text-sm',
    lg: 'px-6 py-3 text-base',
  };

  return (
    <button
      className={cn(base, variants[variant], sizes[size], className)}
      {...props}
    >
      {children}
    </button>
  );
}
