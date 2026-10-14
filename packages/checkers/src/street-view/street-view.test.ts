import type { CheckContext, Clock, Signal } from '@comprova/core'
import {
  makeFakeStreetView,
  makeFakeVisionModel,
  makeStubVisionModel,
  type FacadeClassification,
  type StreetViewResult,
} from '@comprova/providers'
import { describe, expect, it } from 'vitest'
import { makeStreetViewVlm } from './checker.js'
import { classifyByRubricKeywords } from './rubric.js'
import { runFacadeEval } from './eval.js'
import { FACADE_PROMPT, PROMPT_VERSION } from './prompts/facade-v1.js'
import { makeSignal } from '../utils.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const clock: Clock = { now: () => new Date('2026-10-14T12:00:00Z') }

const geocodeSignal = (): Signal =>
  makeSignal({
    checkerId: 'geocode_consensus',
    checkerVersion: '1.0.0',
    stance: 'supports',
    strength: 0.5,
    confidence: 0.8,
    source: 'test',
    observedAt: '2026-10-14T11:00:00Z',
    ttlSeconds: 3600,
    detail: { lat: -23.56, lon: -46.65 },
  })

const ctxWith = (fantasia: string | null): CheckContext => ({
  subject: { docType: 'CNPJ', docDigitsValid: true, pseudonymized: true },
  registryRecord:
    fantasia === null
      ? undefined
      : {
          cnpjBasico: '12345678',
          cnpjOrdem: '0001',
          cnpjDv: '95',
          matrizFilial: 1,
          nomeFantasia: fantasia,
          situacaoCadastral: 2,
          dataSituacao: null,
          motivoSituacao: null,
          dataAbertura: null,
          cnaePrincipal: '4711301',
          cnaesSecundarios: null,
          tipoLogradouro: 'R.',
          logradouro: 'das Flores',
          numero: '100',
          complemento: null,
          bairro: 'Centro',
          cep: '01310100',
          uf: 'SP',
          municipioReceita: 7107,
          municipioIbge: 3550308,
          paisCodigo: null,
          cidadeExterior: null,
          buildingKey: null,
          unitKey: null,
          telefone: null,
          emailDomain: null,
        },
  address: { country: 'BR' },
  priorSignals: [geocodeSignal()],
  clock,
  metrics: { increment: () => undefined, observe: () => undefined },
})

const image = new Uint8Array([1, 2, 3, 4, 5])
const view = (capturedAt: Date | null): StreetViewResult => ({
  status: 'IMAGE_AVAILABLE',
  image,
  ...(capturedAt !== null ? { capturedAt } : {}),
  attribution: 'Google Street View',
})

const classification = (
  klass: FacadeClassification['klass'],
  other: string | null = null,
): FacadeClassification => ({
  klass,
  other_business_name: other,
  confidence: 0.8,
  notes: null,
})

const run = async (
  checkerCtx: CheckContext,
  deps: {
    readonly view: StreetViewResult
    readonly classification?: FacadeClassification
    readonly writer?: ReturnType<typeof recordingWriter>
    readonly storeImages?: boolean
  },
) => {
  const writer = deps.writer ?? recordingWriter()
  const checker = makeStreetViewVlm({
    streetView: makeFakeStreetView(() => deps.view),
    vision: makeFakeVisionModel(() => deps.classification ?? classification('RESIDENTIAL')),
    evidenceWriter: writer.write,
    ...(deps.storeImages === true ? { storeImages: true } : {}),
  })
  return { signals: await checker.run(checkerCtx, undefined), writer }
}

const recordingWriter = () => {
  const written: string[] = []
  return {
    written,
    write: async (e: { readonly kind: string }): Promise<string> => {
      const id = `ev-${written.length}`
      written.push(e.kind)
      return id
    },
  }
}

describe('street_view_vlm (T2)', () => {
  it('sem imagem na rua -> unknown no_imagery', async () => {
    const { signals } = await run(ctxWith('Loja'), {
      view: { status: 'NO_IMAGE' },
    })
    expect(signals[0]?.stance).toBe('unknown')
    expect(signals[0]?.detail['reason']).toBe('no_imagery')
  })

  it('provedor fora do ar -> unknown provider_unavailable', async () => {
    const { signals } = await run(ctxWith('Loja'), {
      view: { status: 'PROVIDER_UNAVAILABLE' },
    })
    expect(signals[0]?.detail['reason']).toBe('provider_unavailable')
  })

  it('fachada comercial com nome do sujeito -> supports', async () => {
    const { signals } = await run(ctxWith('Loja das Flores'), {
      view: view(new Date('2026-01-01')),
      classification: classification('COMMERCIAL', 'Loja das Flores LTDA'),
    })
    expect(signals[0]?.stance).toBe('supports')
    expect(signals[0]?.detail['facade']).toBe('commercial')
  })

  it('fachada comercial com nome de outro negocio -> contradicts', async () => {
    const { signals } = await run(ctxWith('Papelaria do Bairro'), {
      view: view(new Date('2026-01-01')),
      classification: classification('COMMERCIAL', 'Padaria do Ze'),
    })
    expect(signals[0]?.stance).toBe('contradicts')
    expect(signals[0]?.detail['facade']).toBe('commercial_other_name')
    expect(signals[0]?.detail['other_business_name']).toBe('Padaria do Ze')
  })

  it('fachada residencial -> contradicts com hint de fachada', async () => {
    const { signals } = await run(ctxWith('Studio'), {
      view: view(new Date('2026-01-01')),
      classification: classification('RESIDENTIAL'),
    })
    expect(signals[0]?.stance).toBe('contradicts')
    expect(signals[0]?.detail['facade']).toBe('residential')
  })

  it('imagem antiga reduz a confianca (decay por idade)', async () => {
    const recent = await run(ctxWith(null), {
      view: view(new Date('2026-06-01')),
      classification: classification('RESIDENTIAL'),
    })
    const old = await run(ctxWith(null), {
      view: view(new Date('2018-06-01')),
      classification: classification('RESIDENTIAL'),
    })
    const recentConf = recent.signals[0]?.confidence ?? 0
    const oldConf = old.signals[0]?.confidence ?? 0
    expect(oldConf).toBeLessThan(recentConf)
    expect(oldConf).toBeGreaterThanOrEqual(0.8 * 0.3)
  })

  it('grava evidencia (vlm_output e imagem quando habilitado) e anexa evidence_id', async () => {
    const writer = recordingWriter()
    const { signals } = await run(ctxWith('Loja'), {
      view: view(new Date('2026-01-01')),
      classification: classification('COMMERCIAL', 'Loja'),
      writer,
      storeImages: true,
    })
    expect(writer.written).toEqual(['street_view_image', 'vlm_output'])
    expect(signals[0]?.evidenceId).toBeDefined()
    expect((signals[0]?.detail['evidence_ids'] as string[]).length).toBe(2)
  })

  it('VLM fora do ar -> unknown vlm_unavailable, sem veredito falso', async () => {
    const checker = makeStreetViewVlm({
      streetView: makeFakeStreetView(() => view(new Date('2026-01-01'))),
      vision: makeStubVisionModel(),
      evidenceWriter: recordingWriter().write,
    })
    const signals = await checker.run(ctxWith('Loja'), undefined)
    expect(signals[0]?.stance).toBe('unknown')
    expect(signals[0]?.detail['reason']).toBe('vlm_unavailable')
  })

  it('sem ponto geografico -> unknown no_point', async () => {
    const checker = makeStreetViewVlm({
      streetView: makeFakeStreetView(() => view(new Date('2026-01-01'))),
      vision: makeFakeVisionModel(() => classification('RESIDENTIAL')),
    })
    const signals = await checker.run({ ...ctxWith(null), priorSignals: [] }, undefined)
    expect(signals[0]?.detail['reason']).toBe('no_point')
  })
})

describe('rubrica e prompt versionado', () => {
  it('prompt tem versao e rubrica cobre as classes', () => {
    expect(PROMPT_VERSION).toBe('facade-v1')
    expect(FACADE_PROMPT).toContain('Temperatura zero')
    expect(classifyByRubricKeywords('Fachada com vitrine')).toBe('COMMERCIAL')
    expect(classifyByRubricKeywords('Portaria com interfone')).toBe('CONDOMINIUM')
  })
})

describe('harness de avaliacao (gate de CI com modelo fake)', () => {
  it('roda metricas por classe sobre o dataset de amostra', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const labels = JSON.parse(
      readFileSync(path.join(here, 'eval-data', 'labels.sample.json'), 'utf8'),
    ) as ReadonlyArray<{ id: string; expected: FacadeClassification['klass']; hint: string }>
    const model = makeFakeVisionModel((bytes) =>
      classification(classifyByRubricKeywords(Buffer.from(bytes).toString('utf8'))),
    )
    const report = await runFacadeEval(
      model,
      labels.map((l) => ({
        id: l.id,
        image: new TextEncoder().encode(l.hint),
        expected: l.expected,
      })),
    )
    expect(report.modelId).toBe('fake_vision')
    expect(report.accuracy).toBeGreaterThan(0.85)
    for (const cls of report.perClass) {
      expect(cls.correct / cls.total).toBeGreaterThanOrEqual(0.85)
    }
  })
})
