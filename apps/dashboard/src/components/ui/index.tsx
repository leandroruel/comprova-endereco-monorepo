import { cn } from '@/lib/utils'
import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes, InputHTMLAttributes, HTMLAttributes, ReactNode } from 'react'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        outline: 'border border-border bg-card hover:bg-accent',
        ghost: 'hover:bg-accent',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-8 px-3 text-xs',
        lg: 'h-12 px-6 text-base',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export function Button({
  className,
  variant,
  size,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'flex h-10 w-full rounded-lg border border-input bg-card px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-xl border border-border bg-card text-card-foreground shadow-sm', className)}
      {...props}
    />
  )
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col space-y-1.5 p-6', className)} {...props} />
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('font-semibold leading-none tracking-tight', className)} {...props} />
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('text-sm text-muted-foreground', className)} {...props} />
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-6 pt-0', className)} {...props} />
}

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        success: 'border-transparent bg-emerald-100 text-emerald-800',
        warning: 'border-transparent bg-amber-100 text-amber-800',
        destructive: 'border-transparent bg-red-100 text-red-800',
        info: 'border-transparent bg-blue-100 text-blue-800',
        outline: 'text-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

export function Badge({
  className,
  variant,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="w-full overflow-auto">
      <table className="w-full caption-bottom text-sm">{children}</table>
    </div>
  )
}

export function TableHeader({ children }: { children: ReactNode }) {
  return <thead className="[&_tr]:border-b [&_tr]:border-border">{children}</thead>
}

export function TableBody({ children }: { children: ReactNode }) {
  return <tbody className="[&_tr:last-child]:border-0">{children}</tbody>
}

export function TableRow({ children }: { children: ReactNode }) {
  return <tr className="border-b border-border transition-colors hover:bg-muted/50">{children}</tr>
}

export function TableHead({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <th className={cn('h-12 px-4 text-left align-middle font-medium text-muted-foreground', className)}>
      {children}
    </th>
  )
}

export function TableCell({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={cn('p-4 align-middle', className)}>{children}</td>
}

export function Spinner() {
  return (
    <div className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
  )
}

/* ---------------------------------------------------------------- Board UI
 * Re-exports of Board UI components so both the admin and verifier
 * dashboards consume a single shared UI layer from `@/components/ui`.
 * Prefixed with `BUI` so they never clash with the shadcn primitives above. */
/* eslint-disable @typescript-eslint/no-unused-vars */
export {
  Button as BUIButton,
  ButtonLink as BUIButtonLink,
  type ButtonProps as BUIButtonProps,
  type ButtonLinkProps as BUIButtonLinkProps,
} from "./boardui-button";
export {
  Badge as BUIBadge,
  type BadgeProps as BUIBadgeProps,
} from "./boardui-badge";
export {
  Input as BUIInput,
  type InputProps as BUIInputProps,
} from "./boardui-input";
export {
  Table as BUITable,
  TableHeader as BUITableHeader,
  TableBody as BUITableBody,
  TableRow as BUITableRow,
  TableCell as BUITableCell,
  TableColumn as BUITableColumn,
  type TableSize as BUITableSize,
} from "@/components/base/table/table";
export {
  Modal as BUIModal,
  ModalTrigger as BUIModalTrigger,
  ModalHeader as BUIModalHeader,
  ModalBody as BUIModalBody,
  ModalFooter as BUIModalFooter,
  AlertDialog as BUIAlertDialog,
  type ModalProps as BUIModalProps,
  type ModalSize as BUIModalSize,
  type AlertDialogProps as BUIAlertDialogProps,
} from "./boardui-dialog";
export {
  Pagination as BUIPagination,
  type PaginationProps as BUIPaginationProps,
} from "./boardui-pagination";
export {
  BoardUIThemeProvider,
  useBoardUITheme,
} from "./boardui-theme-provider";
/* eslint-enable @typescript-eslint/no-unused-vars */
