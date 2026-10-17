import { createAuthClient } from 'better-auth/react'

// Mesma origem (túnel/proxy) por padrão; sobrescrevível via VITE_API_BASE.
export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_API_BASE || window.location.origin,
})
