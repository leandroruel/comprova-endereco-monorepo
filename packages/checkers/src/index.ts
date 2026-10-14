import type {
  CnaeCategoriaReader,
  CepReader,
  CnefeCoordReader,
  CnefeReader,
  KnownSharedReader,
  ProfileReader,
  RegistryReader,
} from '@comprova/core'
import type { Checker } from '@comprova/core'
import type { GeocodeProvider, PlacesProvider } from '@comprova/providers'
import { makeCepConsistency } from './checkers/cep-consistency.js'
import { makeCnaeVsLocation } from './checkers/cnae-vs-location.js'
import { makeCnefeMatch } from './checkers/cnefe-match.js'
import { makeCotenancy } from './checkers/cotenancy.js'
import { countryCheck } from './checkers/country-check.js'
import { digitalFootprint } from './checkers/digital-footprint.js'
import { documentIntegrity } from './checkers/document-integrity.js'
import { makeGeocodeConsensus } from './checkers/geocode-consensus.js'
import { makePlacesMatch } from './checkers/places-match.js'
import { registryStatus } from './checkers/registry-status.js'

export interface T0Deps {
  readonly registry: RegistryReader
  readonly cnefe: CnefeReader
  readonly cep: CepReader
  readonly profile: ProfileReader
  readonly knownShared: KnownSharedReader
  readonly cnaeCategoria: CnaeCategoriaReader
}

export interface T1Deps {
  readonly geocoder: GeocodeProvider
  readonly cnefeCoords: CnefeCoordReader
  readonly places: PlacesProvider
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

export const makeT1Checkers = (deps: T1Deps): readonly Checker[] => [
  makeGeocodeConsensus(deps.geocoder, deps.cnefeCoords),
  makePlacesMatch(deps.places, deps.cnefeCoords),
  digitalFootprint,
]

export * from './checkers/cep-consistency.js'
export * from './checkers/cnae-vs-location.js'
export * from './checkers/cnefe-match.js'
export * from './checkers/cotenancy.js'
export * from './checkers/country-check.js'
export * from './checkers/digital-footprint.js'
export * from './checkers/document-integrity.js'
export * from './checkers/geocode-consensus.js'
export * from './checkers/places-match.js'
export * from './checkers/registry-status.js'
export * from './street-view/index.js'
export * from './utils.js'
