import {
  createRouter,
  createRoute,
  createRootRoute,
  RouterProvider,
} from '@tanstack/react-router'
import HomePage from '@/pages/Home'
import Validations from '@/pages/Validations'
import { BulkSearchPage } from '@/pages/BulkSearch'
import { DebugNf3eQrCodePage } from '@/pages/DebugNf3eQrCode'
import OrganizationsPage from '@/pages/Organizations'
import { DashboardLayout } from '@/components/layout'

export const rootRoute = createRootRoute({
  component: DashboardLayout,
})

export const homeRoute = createRoute({
  id: 'home',
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomePage,
})

export const validationsRoute = createRoute({
  id: 'validations',
  getParentRoute: () => rootRoute,
  path: '/validations',
  component: Validations,
})

export const bulkRoute = createRoute({
  id: 'bulk',
  getParentRoute: () => rootRoute,
  path: '/bulk',
  component: BulkSearchPage,
})

export const organizationsRoute = createRoute({
  id: 'organizations',
  getParentRoute: () => rootRoute,
  path: '/organizations',
  component: OrganizationsPage,
})

export const debugNf3eQrCodeRoute = createRoute({
  id: 'debug-nf3e-qrcode',
  getParentRoute: () => rootRoute,
  path: '/debug-nf3e-qrcode',
  component: DebugNf3eQrCodePage,
})

export const routeTree = rootRoute.addChildren([
  homeRoute,
  validationsRoute,
  bulkRoute,
  organizationsRoute,
  debugNf3eQrCodeRoute,
])

export const router = createRouter({
  routeTree,
})
