/**
 * Polyfills mínimos para testar componentes (Radix) em jsdom.
 *
 * Importado no topo de cada teste de componente marcado com
 * `// @vitest-environment jsdom`. Não deve ser importado por testes de nó.
 */

const installMatchMedia = (): void => {
  if (typeof window.matchMedia === 'function') return
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList
}

const installResizeObserver = (): void => {
  if (typeof globalThis.ResizeObserver !== 'undefined') return
  function ResizeObserverStub(): {
    observe: () => void
    unobserve: () => void
    disconnect: () => void
  } {
    return { observe: () => undefined, unobserve: () => undefined, disconnect: () => undefined }
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
}

const installPointerCapture = (): void => {
  const proto = Element.prototype as Element & {
    hasPointerCapture?: () => boolean
    setPointerCapture?: () => void
    releasePointerCapture?: () => void
  }
  proto.hasPointerCapture ??= () => false
  proto.setPointerCapture ??= () => undefined
  proto.releasePointerCapture ??= () => undefined
}

const installScrollAndHitTest = (): void => {
  Element.prototype.scrollIntoView ??= () => undefined
  if (typeof document.elementFromPoint !== 'function') {
    document.elementFromPoint = () => null
  }
}

installMatchMedia()
installResizeObserver()
installPointerCapture()
installScrollAndHitTest()

export {}
