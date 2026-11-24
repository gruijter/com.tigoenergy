/*
Copyright 2026, Robin de Gruijter (rmdegruijter@gmail.com)

This file is part of com.tigoenergy.

com.tigoenergy is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

com.tigoenergy is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with com.tigoenergy.  If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

/*
Which API a login reaches its systems on: the official API (EI Premium) first, the Tigo app's API
only when that gives no system.
*/

const TigoClient = require('../tigo');
const TigoMobileClient = require('./TigoMobileClient');

const clientFor = (source, opts) => (source === 'mobile' ? new TigoMobileClient(opts) : new TigoClient(opts));

/** Systems of either API as `{ id, name, timezone, powerRating }`; id as the API gives it. */
const systemsOf = (res) => ((res && res.systems) || []).map((system) => ({
  id: system.system_id !== undefined ? system.system_id : system.id,
  name: system.name,
  timezone: system.timezone,
  powerRating: system.power_rating,
}));

/** By id; by name when the two APIs number a system differently (not verified whether they do). */
const findSystem = (systems, { ids = [], name }) => {
  const wanted = ids.filter((id) => id !== undefined && id !== null && id !== '').map(String);
  return systems.find((system) => wanted.includes(String(system.id)))
    || (name ? systems.find((system) => system.name === name) : undefined);
};

async function trySource(source, opts) {
  const api = clientFor(source, opts);
  await api.login();
  return { source, api, systems: systemsOf(await api.getSystems()) };
}

/**
 * The official API when it lists a system, else the app's API.
 * @param {object} opts username, password, homey, log
 * @param {object} [options] `only: 'v3' | 'mobile'` tries one of them
 * @returns {Promise<{source: string, api: TigoClient, systems: object[]}>} systems may be empty
 */
async function connect(opts, { only } = {}) {
  let empty;
  let firstError;
  for (const source of only ? [only] : ['v3', 'mobile']) {
    try {
      const result = await trySource(source, opts);
      if (result.systems.length) return result;
      if (!empty) empty = result;
    } catch (error) {
      if (opts.log) opts.log(`Tigo ${source} API not usable:`, error.statusCode || '', error.message);
      if (!firstError) firstError = error;
    }
  }
  if (empty) return empty;
  throw firstError;
}

/** The official API refuses an account without EI Premium with 402 (seen live). */
const needsPremium = (error) => Boolean(error && error.statusCode === 402);

module.exports = {
  clientFor, connect, findSystem, systemsOf, needsPremium,
};
