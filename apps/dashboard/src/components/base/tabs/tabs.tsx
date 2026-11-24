'use client'

import type { ComponentType, ReactNode } from 'react'
import React from 'react'
import { cx } from '@/utils/cx'

type IconComponent = ComponentType<{
  className?: string
  'aria-hidden'?: boolean | 'true' | 'false'
}>

interface TabsProps {
  children?: ReactNode
  className?: string
  defaultValue?: string
  value?: string
  onValueChange?: (value: string) => void
}

interface TabListProps {
  children?: ReactNode
  className?: string
}

interface TabProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children?: ReactNode
  className?: string
  value: string
  icon?: IconComponent
}

interface TabPanelProps {
  children?: ReactNode
  className?: string
  value: string
}

const TabsContext = React.createContext<{
  value: string
  onValueChange: (value: string) => void
} | null>(null)

export function Tabs({
  children,
  className,
  defaultValue = 'simple',
  value,
  onValueChange,
}: TabsProps) {
  const [internalValue, setInternalValue] = React.useState(defaultValue)
  const controlledValue = value ?? internalValue

  const handleValueChange = (nextValue: string) => {
    setInternalValue(nextValue)
    onValueChange?.(nextValue)
  }

  return (
    <TabsContext.Provider value={{ value: controlledValue, onValueChange: handleValueChange }}>
      <div className={cx('flex w-full flex-col gap-4', className)}>{children}</div>
    </TabsContext.Provider>
  )
}

export function TabList({ children, className }: TabListProps) {
  return <div className={cx('flex w-full items-center gap-1 border-b border-separator-border', className)}>{children}</div>
}

export function Tab({
  children,
  className,
  value,
  icon: Icon,
  ...props
}: TabProps) {
  const context = React.useContext(TabsContext)
  const isSelected = context?.value === value

  return (
    <button
      type="button"
      className={cx(
        'relative inline-flex cursor-pointer items-center gap-2.5 px-2.5 py-2 whitespace-nowrap',
        'outline-none transition-colors duration-150 ease',
        'focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-border-focus-ring',
        isSelected ? 'text-body-medium text-accent-600' : 'text-body-regular text-text-primary',
        className,
      )}
      {...props}
      aria-selected={isSelected}
      onClick={() => context?.onValueChange(value)}
    >
      <span className={cx('inline-flex items-center gap-1.5')}>
        {Icon && <Icon className="size-4 shrink-0" aria-hidden />}
        {children}
      </span>
    </button>
  )
}

export function TabPanel({ children, className, value }: TabPanelProps) {
  const context = React.useContext(TabsContext)
  const isSelected = context?.value === value

  if (!isSelected) return null

  return <div className={cx('outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-border-focus-ring', className)}>{children}</div>
}
