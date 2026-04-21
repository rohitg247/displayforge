import { cn } from '@/lib/utils';

export function ActisCard({ children, className = '', hover = false }) {
  return (
    <div
      className={cn(
        'gradient-card border border-border rounded-xl shadow-card transition-all duration-300',
        hover && 'hover:border-primary/30 hover:shadow-lg hover:-translate-y-0.5',
        className
      )}
    >
      {children}
    </div>
  );
}

export function ActisCardHeader({ children, className = '' }) {
  return <div className={cn('p-6 pb-2', className)}>{children}</div>;
}

export function ActisCardContent({ children, className = '' }) {
  return <div className={cn('p-6 pt-2', className)}>{children}</div>;
}

export function ActisCardFooter({ children, className = '' }) {
  return <div className={cn('p-6 pt-0 flex gap-3', className)}>{children}</div>;
}
