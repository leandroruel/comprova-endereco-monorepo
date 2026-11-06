'use client'

import {
  Button as BoardUIButton,
  ButtonLink as BoardUIButtonLink,
  type ButtonProps,
  type ButtonLinkProps,
} from '@/components/base/buttons/button'

/**
 * Board UI Button re-exported from the shared UI barrel so both the admin and
 * verifier dashboards consume a single stable component from `@/components/ui`.
 *
 * The shadcn `Button` already exported from this folder keeps working
 * alongside this one; they are different components from different design
 * systems and are intentionally not merged.
 */
export { BoardUIButton as Button }
export { BoardUIButtonLink as ButtonLink }
export type { ButtonProps, ButtonLinkProps }
