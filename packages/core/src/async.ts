export const findFirstAsync = async <T>(
  items: readonly T[],
  predicate: (item: T) => Promise<boolean>,
): Promise<T | undefined> => {
  const head = items[0]
  if (head === undefined) return undefined
  if (await predicate(head)) return head
  return findFirstAsync(items.slice(1), predicate)
}

export const mapSequential = async <T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>,
): Promise<readonly R[]> =>
  items.reduce<Promise<readonly R[]>>(
    async (chain, item, index) => [...(await chain), await mapper(item, index)],
    Promise.resolve([]),
  )
