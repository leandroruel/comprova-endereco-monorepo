import { z } from 'zod'
import type { StreetViewResult } from './street-view.js'

export const FacadeClassSchema = z.enum([
  'COMMERCIAL',
  'RESIDENTIAL',
  'VACANT_LOT',
  'CONDOMINIUM',
  'CONSTRUCTION',
  'UNKNOWN',
])

export type FacadeClass = z.infer<typeof FacadeClassSchema>

export const FacadeClassificationSchema = z.object({
  klass: FacadeClassSchema,
  other_business_name: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1),
  notes: z.string().nullable().default(null),
})

export type FacadeClassification = z.infer<typeof FacadeClassificationSchema>

export interface VisionModel {
  readonly id: string
  readonly version: string
  readonly classifyFacade: (image: Uint8Array) => Promise<FacadeClassification>
}

export interface OpenAIVisionOptions {
  readonly apiKey?: string
  readonly model?: string
  readonly prompt: string
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
}

export const makeOpenAIVisionModel = (options: OpenAIVisionOptions): VisionModel => {
  const model = options.model ?? 'gpt-4o'
  const doFetch = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 30_000
  return {
    id: 'openai',
    version: model,
    classifyFacade: async (image) => {
      if (options.apiKey === undefined || options.apiKey === '') {
        throw new Error('OPENAI_API_KEY not configured')
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await doFetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: options.prompt },
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'Classifique a fachada desta imagem.' },
                  {
                    type: 'image_url',
                    image_url: {
                      url: `data:image/jpeg;base64,${Buffer.from(image).toString('base64')}`,
                    },
                  },
                ],
              },
            ],
          }),
          signal: controller.signal,
        })
        if (res.status !== 200) {
          throw new Error(`openai vision HTTP ${res.status}`)
        }
        const body = (await res.json()) as {
          choices?: ReadonlyArray<{ message?: { content?: string } }>
        }
        const content = body.choices?.[0]?.message?.content
        if (content === undefined) {
          throw new Error('openai vision returned no content')
        }
        return FacadeClassificationSchema.parse(JSON.parse(content))
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

export const makeFakeVisionModel = (classify: (image: Uint8Array) => FacadeClassification): VisionModel => ({
  id: 'fake_vision',
  version: 'fake-1',
  classifyFacade: async (image) => classify(image),
})

export const makeStubVisionModel = (): VisionModel => ({
  id: 'stub_vision',
  version: 'stub-1',
  classifyFacade: async () => {
    throw new Error('vision model not configured')
  },
})

export type { StreetViewResult }
