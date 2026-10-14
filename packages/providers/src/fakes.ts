import type { GeocodeProvider, GeocodeQuery, GeocodeResult, PlacesProvider, Poi } from './types.js'

export const makeFakeGeocoder = (
  resolve: (query: GeocodeQuery) => GeocodeResult | null,
): GeocodeProvider => ({
  id: 'fake_geocoder',
  geocode: async (query) => resolve(query),
})

export const makeFailingGeocoder = (): GeocodeProvider => ({
  id: 'failing_geocoder',
  geocode: async () => null,
})

export const makeFakePlaces = (pois: readonly Poi[]): PlacesProvider => ({
  id: 'fake_places',
  findNearbyPois: async () => [...pois],
})

export const makeFailingPlaces = (): PlacesProvider => ({
  id: 'failing_places',
  findNearbyPois: async () => [],
})
