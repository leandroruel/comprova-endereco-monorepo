/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Chave de API do tenant de dev; vem do `.env` da raiz (ver README). */
  readonly VITE_API_KEY?: string
}
