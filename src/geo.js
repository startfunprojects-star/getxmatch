'use strict';

// Country → state → city lookups for the profile location picker, backed by
// the `country-state-city` dataset. Profiles store plain names; this module
// maps our country names to ISO codes (a few differ from the dataset's names).

const { Country, State, City } = require('country-state-city');

const ALIASES = { Czechia: 'Czech Republic' };

const byName = new Map(Country.getAllCountries().map((c) => [c.name, c.isoCode]));

function countryCode(name) {
  return byName.get(ALIASES[name] || name) || null;
}

// State names for a country (empty when unknown or the dataset has none).
function states(countryName) {
  const cc = countryCode(countryName);
  if (!cc) return [];
  return State.getStatesOfCountry(cc).map((s) => s.name).sort((a, b) => a.localeCompare(b));
}

function stateCode(countryName, stateName) {
  const cc = countryCode(countryName);
  if (!cc) return null;
  const s = State.getStatesOfCountry(cc).find((x) => x.name === stateName);
  return s ? s.isoCode : null;
}

// City names for a state (de-duplicated, sorted).
function cities(countryName, stateName) {
  const cc = countryCode(countryName);
  const sc = stateCode(countryName, stateName);
  if (!cc || !sc) return [];
  return [...new Set(City.getCitiesOfState(cc, sc).map((c) => c.name))].sort((a, b) => a.localeCompare(b));
}

// Nearest known city to a coordinate, as "City, State, Country" — used by the
// camera's "Use my location" button. The city list is loaded on first use.
let allCities = null;
const countryNames = new Map(Country.getAllCountries().map((c) => [c.isoCode, c.name]));
function nearestPlace(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (!allCities) {
    allCities = City.getAllCities()
      .map((c) => ({ name: c.name, cc: c.countryCode, sc: c.stateCode, lat: +c.latitude, lon: +c.longitude }))
      .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon));
  }
  const cosLat = Math.cos((lat * Math.PI) / 180);
  let best = null;
  let bestD = Infinity;
  for (const c of allCities) {
    const dLat = c.lat - lat;
    const dLon = (c.lon - lon) * cosLat;
    const d = dLat * dLat + dLon * dLon;
    if (d < bestD) { bestD = d; best = c; }
  }
  if (!best || bestD > 4) return null; // more than ~200 km from any known city
  const state = State.getStateByCodeAndCountry(best.sc, best.cc);
  return [best.name, state && state.name !== best.name ? state.name : null, countryNames.get(best.cc)]
    .filter(Boolean)
    .join(', ');
}

module.exports = { states, cities, nearestPlace };
