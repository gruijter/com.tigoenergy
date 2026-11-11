/*
Copyright 2025 - 2026, Robin de Gruijter (rmdegruijter@gmail.com)

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
Raw API responses in the app log, so a user's diagnostics report doubles as test material.
Each endpoint is logged once per arm (app start, device restart, pair), in chunks.
`node test/from-logs.js <report.txt>` turns a report back into test/captures/<site>/*.json.
*/

const captureLog = require('./captureLog');

// path without query -> stable name test/fixtures.js expects; other paths get a derived name
const CAPTURE_NAMES = {
  '/api/v3/systems': 'systems',
  '/api/v3/systems/layout': 'layout',
  '/api/v3/objects/system': 'objects',
  '/api/v3/sources/system': 'sources',
  '/api/v3/data/summary': 'summary',
};

// they carry the login token
const NEVER = new Set(['/api/v3/users/login', '/api/v3/users/logout']);

// '/api/v3/systems/68742' -> 'system', '/api/v3/alerts/system' -> 'alertsSystem'
const deriveName = (path) => {
  if (/^\/api\/v3\/systems\/\d+$/.test(path)) return 'system';
  return path
    .replace(/^\/api\/v\d+\//, '')
    .split('/')
    .filter(Boolean)
    .map((seg, i) => (i === 0 ? seg : seg.charAt(0).toUpperCase() + seg.slice(1)))
    .join('')
    .replace(/[^A-Za-z0-9]/g, '');
};

const nameFor = (path) => {
  const bare = String(path).replace(/\?.*$/, '');
  if (NEVER.has(bare)) return null;
  return CAPTURE_NAMES[bare] || deriveName(bare);
};

// Owner contact details and location are redacted; system ids, names and serials are kept.
const PII_KEYS = new Set([
  'street', 'city', 'state', 'zip', 'latitude', 'longitude', 'contact_name', 'contact_email',
  'email', 'phone', 'mobile', 'first_name', 'last_name', 'auth', 'refresh_token',
]);

const redact = (value) => {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = PII_KEYS.has(k) && v !== null ? '<redacted>' : redact(v);
    return out;
  }
  return value;
};

const core = captureLog('TIGO');

module.exports = {

  CAPTURE_NAMES,

  /**
   * Arm capturing: the next response of every endpoint is logged once.
   * @param {string} why shown in the log
   * @param {object} [options] `force` skips the cooldown (app start, pair)
   */
  arm(why, options) {
    return core.arm(why, options);
  },

  /**
   * Log one API response while armed, once per endpoint per arm.
   * @param {string} path the API path that produced it
   * @param {*} payload the parsed response body
   * @param {Function} log the app/device logger
   */
  record(path, payload, log) {
    if (!payload || typeof log !== 'function') return false;
    const name = nameFor(path);
    if (!name || !core.claim(name)) return false;
    return core.write(name, redact(payload), log);
  },

  /**
   * Read captures back out of a diagnostics report; a name captured twice keeps the last.
   * @param {string} text the whole report
   * @returns {{captures: object, errors: string[]}} parsed payloads by capture name
   */
  parseLog(text) {
    const { entries, errors } = core.parse(text);
    const captures = {};
    entries.forEach(({ name, value }) => {
      captures[name] = value;
    });
    return { captures, errors };
  },

};
