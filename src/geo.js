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

module.exports = { states, cities };
