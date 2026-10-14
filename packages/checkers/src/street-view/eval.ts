import type { FacadeClass, VisionModel } from '@comprova/providers'

export interface EvalCase {
  readonly id: string
  readonly image: Uint8Array
  readonly expected: FacadeClass
}

export interface EvalReport {
  readonly perClass: ReadonlyArray<{
    readonly klass: FacadeClass
    readonly correct: number
    readonly total: number
  }>
  readonly accuracy: number
  readonly errors: number
  readonly modelId: string
}

export const runFacadeEval = async (model: VisionModel, cases: readonly EvalCase[]): Promise<EvalReport> => {
  const outcomes = await cases.reduce<Promise<readonly (readonly [FacadeClass, FacadeClass | null])[]>>(
    async (acc, c) => {
      const prior = await acc
      try {
        const result = await model.classifyFacade(c.image)
        return [...prior, [c.expected, result.klass] as const]
      } catch {
        return [...prior, [c.expected, null] as const]
      }
    },
    Promise.resolve([]),
  )
  const classes = [...new Set(cases.map((c) => c.expected))]
  const perClass = classes.map((klass) => {
    const ofClass = outcomes.filter(([expected]) => expected === klass)
    return {
      klass,
      correct: ofClass.filter(([, actual]) => actual === klass).length,
      total: ofClass.length,
    }
  })
  const errors = outcomes.filter(([, actual]) => actual === null).length
  const correct = outcomes.filter(([expected, actual]) => expected === actual).length
  return {
    perClass,
    accuracy: cases.length === 0 ? 0 : correct / cases.length,
    errors,
    modelId: model.id,
  }
}
