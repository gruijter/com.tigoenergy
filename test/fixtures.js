'use strict';

/*
Fixtures for the offline suite: real captures from test/captures/<site>/*.json when present, else
stubs taken from the Tigo REST API V3 document (2019, zzz_docs/Tigo_REST_API_V3_2019.pdf).
*/

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const APP = path.join(__dirname, '..');
const CAPTURE_DIR = path.join(__dirname, 'captures');

// ---------------------------------------------------------------------------
// Doc-derived stubs (example responses of the API V3 document)
// ---------------------------------------------------------------------------

const docStubs = {
  systems: {
    systems: [{
      system_id: 1,
      name: 'Test System',
      external_id: 'test',
      created: '2014-05-16T20:50:45+00:00',
      street: '<redacted>',
      city: '<redacted>',
      timezone: 'America/Los_Angeles',
      power_rating: 12000,
      turn_on_date: '2017-01-01',
      // not in the document, seen in the live response the app reads it from
      recent_alerts_count: 0,
    }],
  },
  system: {
    system: {
      system_id: 1, name: 'Test System', power_rating: 12000, turn_on_date: '2017-01-01',
    },
  },
  layout: {
    system: {
      system_id: 1,
      inverters: [{
        inverter_id: 1,
        label: 'Inverter 1',
        object_id: 1,
        mppts: [{
          mppt_id: 1,
          label: 'MPPT 1',
          strings: [{
            string_id: 1,
            label: 'String A',
            short_label: 'A',
            object_id: 2,
            panels: [{
              panel_id: 1, label: 'A1', short_label: 1, serial: '04C05B8001234', type: 'TS4-S', source_id: 1, object_id: 3, panel_type_id: 1,
            }],
          }],
        }],
      }],
    },
  },
  objects: {
    objects: [
      {
        id: 1, label: 'System', object_type_id: 1, parent_id: -1, datasource: null, children: [2],
      },
      {
        id: 2, label: 'String A', object_type_id: 3, parent_id: 1, datasource: null, children: [3],
      },
      {
        id: 3, label: 'A1', object_type_id: 2, parent_id: 2, datasource: '04C05B800ACE.panels.A1', children: null, ui: { X: 150, Y: 150 },
      },
    ],
  },
  sources: {
    sources: [{
      source_id: 9999,
      name: 'My Cloud Connect',
      serial: '04C05B8FFFFF',
      gateway_count: 1,
      control_state: 'on',
      last_checkin: '2017-02-16T23:19:06-08:00',
      timezone: 'America/Los_Angeles',
      sets: [{ set_name: 'panels_avg', last_min: '2016-09-07T18:32:00-07:00', last_day: '2014-11-18T00:00:00-08:00' }],
      system_id: 1,
    }],
  },
  summary: {
    summary: {
      lifetime_energy_dc: 18607879.27,
      ytd_energy_dc: 500.32,
      daily_energy_dc: 0,
      updated_on: '2014-11-18T00:00:00-08:00',
      last_power_dc: 0,
    },
  },
  login: {
    user: {
      user_id: 1, auth: 'ABCDE', expires: '2016-09-01T00:00:00-08:00', user_type: 'Basic',
    },
  },
};

// error bodies seen live (zzz_docs/README.md)
const errors = {
  unauthorized: {
    status: 401,
    body: {
      name: 'Unauthorized', message: '', code: 0, status: 401,
    },
  },
  premium: {
    status: 402,
    body: {
      name: 'Payment Required', message: 'Premium required.', code: 0, status: 402,
    },
  },
  dataPremium: { status: 402, body: { type: 'api_error', code: 'internal_server_error', message: 'Internal server error' } },
  rateLimited: { status: 429, body: { isSuccess: false, messages: [{ message: 'Too Many Requests', type: 'error' }] } },
};

// ---------------------------------------------------------------------------
// Source selection
// ---------------------------------------------------------------------------

const readCaptureDir = (dir) => {
  const out = {};
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    try {
      out[path.basename(file, '.json')] = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (err) {
      console.log(`    (ignoring unreadable capture ${path.join(path.basename(dir), file)}: ${err.message})`);
    }
  }
  return out;
};

// test/captures/<site>/*.json; loose *.json directly in test/captures count as site 'default'
const readSites = () => {
  const out = {};
  if (!fs.existsSync(CAPTURE_DIR)) return out;
  for (const entry of fs.readdirSync(CAPTURE_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const set = readCaptureDir(path.join(CAPTURE_DIR, entry.name));
    if (Object.keys(set).length) out[entry.name] = set;
  }
  const loose = readCaptureDir(CAPTURE_DIR);
  if (Object.keys(loose).length) out.default = { ...loose, ...(out.default || {}) };
  return out;
};

const sites = readSites();
const siteNames = Object.keys(sites).sort();
let activeSite = siteNames[0] || null;
const activeCaptures = () => (activeSite ? sites[activeSite] : {});

const fixtures = {
  sites: siteNames,
  errors,

  get site() {
    return activeSite;
  },

  /** Point the fixture helpers at one site's captures (null = doc stubs only). */
  useSite(name) {
    if (name != null && !sites[name]) {
      throw new Error(`No captures for site '${name}'. Have: ${siteNames.join(', ') || '(none)'}`);
    }
    activeSite = name != null ? name : null;
  },

  get names() {
    return [...new Set([...Object.keys(docStubs), ...Object.keys(activeCaptures())])].sort();
  },

  /** A response by name, preferring the active site's real capture over the doc stub. */
  get(name) {
    const cap = activeCaptures()[name];
    if (cap) return JSON.parse(JSON.stringify(cap));
    if (docStubs[name]) return JSON.parse(JSON.stringify(docStubs[name]));
    throw new Error(`No fixture '${name}'. Have: ${fixtures.names.join(', ')}`);
  },

  /** True when `name` came from the active site's capture rather than the document. */
  isReal(name) {
    return Boolean(activeCaptures()[name]);
  },

  banner() {
    if (!siteNames.length) {
      return 'fixtures: doc-derived stubs (no captures yet - run `node test/from-logs.js <report>` or `node test/capture.js <user> <password>`)';
    }
    return `fixtures: real captures for ${siteNames.length} site(s) [${siteNames.join(', ')}], doc stubs for the rest`;
  },
};

// ---------------------------------------------------------------------------
// Loading app code without a Homey runtime
// ---------------------------------------------------------------------------

let homeyStub = null;

fixtures.installHomeyStub = () => {
  if (homeyStub) return homeyStub;
  class SimpleClass {

    log() {}

    error() {}

  }
  homeyStub = {
    App: class extends SimpleClass {},
    Device: class extends SimpleClass {},
    Driver: class extends SimpleClass {},
    SimpleClass,
  };
  const original = Module._resolveFilename;
  Module._resolveFilename = function resolve(request, ...rest) {
    if (request === 'homey') return 'homey-stub';
    return original.call(this, request, ...rest);
  };
  require.cache['homey-stub'] = {
    id: 'homey-stub', filename: 'homey-stub', loaded: true, exports: homeyStub,
  };
  return homeyStub;
};

/** Require a module from the app, with the Homey runtime stubbed out. */
fixtures.app = (relative) => {
  fixtures.installHomeyStub();
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(path.join(APP, relative));
};

// path without query -> fixture name
const ROUTES = {
  '/api/v3/users/login': 'login',
  '/api/v3/systems': 'systems',
  '/api/v3/systems/layout': 'layout',
  '/api/v3/objects/system': 'objects',
  '/api/v3/sources/system': 'sources',
  '/api/v3/data/summary': 'summary',
};

const routeOf = (urlPath) => {
  const bare = String(urlPath).replace(/\?.*$/, '');
  if (/^\/api\/v3\/systems\/\d+$/.test(bare)) return 'system';
  return ROUTES[bare];
};

/**
 * Answer every TigoClient request from the fixtures, for all clients (also the ones a driver or
 * device creates itself). `overrides` maps a path without query to a fixture name, a body, an
 * `{ status, body }` from `fixtures.errors`, or a function of the request options.
 * @returns {object[]} the requests made: { path, headers, method }
 */
fixtures.routeHttps = (overrides = {}) => {
  const TigoClient = fixtures.app('tigo.js');
  const calls = [];
  TigoClient.prototype._makeHttpsRequest = async function fake(options) {
    calls.push({ path: options.path, headers: { ...options.headers }, method: options.method });
    const bare = options.path.replace(/\?.*$/, '');
    let answer = Object.prototype.hasOwnProperty.call(overrides, bare) ? overrides[bare] : routeOf(bare);
    if (typeof answer === 'function') answer = answer(options);
    if (typeof answer === 'string') answer = fixtures.get(answer);
    if (answer === undefined) throw new Error(`No fixture route for ${options.path}`);
    const { status, body, contentType } = answer && answer.status && answer.body !== undefined
      ? answer : { status: 200, body: answer };
    return {
      statusCode: status,
      headers: { 'content-type': contentType || 'application/json; charset=utf-8' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    };
  };
  return calls;
};

/** A TigoClient as the app builds it, logging into `lines`. */
fixtures.makeClient = (lines = []) => {
  const TigoClient = fixtures.app('tigo.js');
  return new TigoClient({
    username: 'user@example.invalid',
    password: 'secret',
    homey: { __: (key) => key },
    log: (line) => lines.push(line),
  });
};

/** An inverter device without Homey: capabilities, store and settings in memory. */
fixtures.makeDevice = ({ capabilities, settings = {} } = {}) => {
  const Device = fixtures.app('drivers/inverter/device.js');
  const manifest = JSON.parse(fs.readFileSync(path.join(APP, 'drivers/inverter/driver.compose.json'), 'utf8'));
  const caps = capabilities || [...manifest.capabilities];
  const device = Object.create(Device.prototype);
  const values = {};
  const store = {};
  Object.assign(device, {
    values,
    store,
    available: null,
    homey: { __: (key) => key },
    settings: { systemId: '1', ...settings },
    log() {},
    error() {},
    getName: () => 'Tigo test',
    hasCapability: (cap) => caps.includes(cap),
    getCapabilityValue: (cap) => (cap in values ? values[cap] : null),
    setCapabilityValue: async (cap, value) => {
      values[cap] = value;
    },
    getStoreValue: (key) => store[key],
    setStoreValue: async (key, value) => {
      store[key] = value;
    },
    setAvailable: async () => {
      device.available = true;
    },
    setUnavailable: async (reason) => {
      device.available = false;
      device.unavailableReason = reason;
    },
  });
  return device;
};

/** The inverter driver with its manifest, and a fake pairing session. */
fixtures.makeDriver = () => {
  const Driver = fixtures.app('drivers/inverter/driver.js');
  const driver = Object.create(Driver.prototype);
  driver.homey = { __: (key) => key };
  driver.manifest = JSON.parse(fs.readFileSync(path.join(APP, 'drivers/inverter/driver.compose.json'), 'utf8'));
  driver.log = () => {};
  driver.error = () => {};
  return driver;
};

fixtures.makeSession = () => {
  const handlers = {};
  return {
    handlers,
    setHandler: (name, fn) => {
      handlers[name] = fn;
    },
  };
};

module.exports = fixtures;
