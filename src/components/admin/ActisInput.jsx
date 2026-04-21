import { forwardRef } from 'react';
import { cn } from '@/lib/utils';

export const ActisInput = forwardRef(
  ({ className = '', ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={cn(
          'w-full px-4 py-2.5 rounded-lg border border-border bg-input text-foreground',
          'placeholder:text-muted-foreground/60 transition-all duration-200',
          'focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20',
          'file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground',
          className
        )}
        {...props}
      />
    );
  }
);

ActisInput.displayName = 'ActisInput';
