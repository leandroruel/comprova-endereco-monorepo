import type {
  CnaeCategoriaReader,
  CepReader,
  CnefeReader,
  KnownSharedReader,
  ProfileReader,
  RegistryReader,
} from '@comprova/core'
import type { Checker } from '@comprova/core'
import { makeCepConsistency } from './checkers/cep-consistency.js'
import { makeCnaeVsLocation } from './checkers/cnae-vs-location.js'
import { makeCnefeMatch } from './checkers/cnefe-match.js'
import { makeCotenancy } from './checkers/cotenancy.js'
import { countryCheck } from './checkers/country-check.js'
import { documentIntegrity } from './checkers/document-integrity.js'
import { registryStatus } from './checkers/registry-status.js'

export interface T0Deps {
  readonly registry: RegistryReader
  readonly cnefe: CnefeReader
  readonly cep: CepReader
  readonly profile: ProfileReader
  readonly knownShared: KnownSharedReader
  readonly cnaeCategoria: CnaeCategoriaReader
}

export const makeT0Checkers = (deps: T0Deps): readonly Checker[] => [
  documentIntegrity,
  registryStatus,
  countryCheck,
  makeCepConsistency(deps.cep),
  makeCnefeMatch(deps.cnefe),
  makeCotenancy(deps.profile, deps.knownShared),
  makeCnaeVsLocation(deps.cnaeCategoria),
]

export * from './checkers/cep-consistency.js'
export * from './checkers/cnae-vs-location.js'
export * from './checkers/cnefe-match.js'
export * from './checkers/cotenancy.js'
export * from './checkers/country-check.js'
export * from './checkers/document-integrity.js'
export * from './checkers/registry-status.js'
export * from './utils.js'
