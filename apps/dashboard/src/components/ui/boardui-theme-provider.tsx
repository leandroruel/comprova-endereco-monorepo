'use client'

import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from 'react'

/**
 * BoardUI theme provider.
 *
 * Board UI ships its design system through CSS custom properties (see
 * `src/styles/theme.css` and `src/styles/typography.css`, imported in
 * `src/index.css`) plus a class-based dark variant (`.dark`). This provider
 * is the single place where the Board UI theme is switched on for the whole
 * application — it mounts the theme on the root element and exposes a toggle
 * so any page (admin or verifier) can opt into dark mode.
 *
 * It does not depend on `next-themes` or any router, so both the admin
 * dashboard and the verifier dashboard can wrap their entry point with it.
 */
export interface BoardUIThemeProviderProps {
  children: ReactNode
  /** Start in dark mode? Defaults to false (light). */
  defaultDark?: boolean
}

export function BoardUIThemeProvider({ children, defaultDark = false }: BoardUIThemeProviderProps) {
  const [dark, setDark] = useState(defaultDark)

  useEffect(() => {
    if (dark) {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }, [dark])

  const toggle = useCallback(() => setDark((d) => !d), [])

  return <BoardUIThemeContext.Provider value={{ dark, toggle }}>{children}</BoardUIThemeContext.Provider>
}

const BoardUIThemeContext = createContext<{
  readonly dark: boolean
  readonly toggle: () => void
}>({ dark: false, toggle: () => {} })

export function useBoardUITheme() {
  return useContext(BoardUIThemeContext)
}
