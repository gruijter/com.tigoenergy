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
Tigo answers in one shape per device kind, whichever API it came from. A missing value stays
undefined (tile untouched), a real 0 stays 0.
*/

const FACTORS = {
  w: 1, kw: 1000, mw: 1e6, wh: 1, kwh: 1000, mwh: 1e6,
};

/**
 * W or Wh from a number, `{ value, unit }` or '2.4 kW'; a bare number is in `defaultUnit`.
 * @returns {number|undefined}
 */
function quantity(raw, defaultUnit) {
  let value = raw;
  let unit = defaultUnit;
  if (value && typeof value === 'object') {
    unit = value.unit || defaultUnit;
    ({ value } = value);
  } else if (typeof value === 'string') {
    const match = value.trim().match(/^([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*([a-z]+)?$/i);
    if (!match) return undefined;
    [, value] = match;
    unit = match[2] || defaultUnit;
  }
  const number = Number(value);
  const factor = FACTORS[String(unit).toLowerCase()];
  if (value === null || value === '' || !Number.isFinite(number) || !factor) return undefined;
  return number * factor;
}

const kwh = (wh) => (wh === undefined ? undefined : wh / 1000);

/** `{ powerW, todayKwh, yearKwh, lifetimeKwh, updatedAt }` from the official data/summary. */
function fromSummary(status) {
  const summary = status && status.summary;
  if (!summary) return null;
  return {
    powerW: quantity(summary.last_power_dc, 'W'),
    todayKwh: kwh(quantity(summary.daily_energy_dc, 'Wh')),
    yearKwh: kwh(quantity(summary.ytd_energy_dc, 'Wh')),
    lifetimeKwh: kwh(quantity(summary.lifetime_energy_dc, 'Wh')),
    updatedAt: summary.updated_on,
  };
}

/** The same plus monthKwh from the app's homepage; W and Wh (seen live by M. Stranik's Tigo app). */
function fromHomepage(homepage) {
  const production = homepage && homepage.energyProduction;
  if (!production) return null;
  return {
    powerW: quantity(production.now, 'W'),
    todayKwh: kwh(quantity(production.day, 'Wh')),
    monthKwh: kwh(quantity(production.month, 'Wh')),
    yearKwh: kwh(quantity(production.year, 'Wh')),
    lifetimeKwh: kwh(quantity(production.lifetime, 'Wh')),
    updatedAt: homepage.minLastTime,
  };
}

/** Newest value per panel of the app's panel summary; '-' is no value. */
function newestPerPanel(summary, toValue) {
  const values = new Map();
  const blocks = summary && summary.dataset;
  for (const block of Array.isArray(blocks) ? blocks : [blocks]) {
    const order = (block && block.order) || [];
    for (const row of (block && block.data) || []) {
      (row.d || []).forEach((cell, i) => {
        const value = cell === '-' ? undefined : toValue(cell);
        if (value !== undefined && order[i] !== undefined) values.set(String(order[i]), { value, t: String(row.t) });
      });
    }
  }
  return values;
}

/**
 * Newest power per panel from the app's panel summary.
 * @returns {{ power: Map<string, {value: number, t: string}>, lastData: string|undefined }} t is local 'HH:MM'
 */
function panelPower(summary) {
  return { power: newestPerPanel(summary, (cell) => quantity(cell, 'W')), lastData: summary && summary.lastData };
}

/** Newest plain number per panel (V, A, RSSI, °C) from the app's panel summary. */
function panelSeries(summary) {
  return newestPerPanel(summary, (cell) => {
    const number = cell === null || cell === '' ? NaN : Number(cell);
    return Number.isFinite(number) ? number : undefined;
  });
}

/** The panels of a systems/layout answer, with their string. */
function panelsOf(layout) {
  const panels = [];
  const system = (layout && layout.system) || {};
  for (const inverter of system.inverters || []) {
    for (const mppt of inverter.mppts || []) {
      for (const string of mppt.strings || []) {
        for (const panel of string.panels || []) panels.push({ ...panel, string: string.label });
      }
    }
  }
  return panels;
}

/** Today's kWh per panel from the app's aggenergy (Wh by object id). */
function panelEnergy(answer) {
  const energy = new Map();
  for (const [id, wh] of Object.entries((answer && answer.dataset) || {})) {
    const value = quantity(wh, 'Wh');
    if (value !== undefined) energy.set(String(id), value / 1000);
  }
  return energy;
}

/** Serials of the gateways (CCA) in the app's equipment list. */
function gatewaySerials(equipments) {
  const list = Array.isArray(equipments) ? equipments : (equipments && (equipments.equipments || equipments.data)) || [];
  return list.filter((item) => /unit|cca|gateway/i.test(item.equipmentType || ''))
    .map((item) => item.equipmentSerial).filter(Boolean);
}

const listOf = (body) => (Array.isArray(body) ? body : (body && (body.data || body.items)) || []);
const joined = (titles) => (titles.length ? [...new Set(titles)].join(', ') : null);

/**
 * Titles of the `count` newest official alerts, `null` for none. An alert is an e-mail Tigo sent,
 * not a state that ends; `count` is the system's recent_alerts_count.
 */
function alertTitles(answer, count) {
  const alerts = ((answer && answer.alerts) || []).filter((alert) => alert && alert.title)
    .sort((a, b) => String(b.added).localeCompare(String(a.added)));
  return joined(alerts.slice(0, count).map((alert) => String(alert.title).replace(/^Tigo Alert:\s*/i, '')));
}

/**
 * Titles of the app's equipment states whose newest event is a warning or error, `null` for none.
 * That a recovery is a newer event of the same type with code 0 is not verified.
 */
function equipmentFaults(history, eventTypes) {
  const titles = new Map(listOf(eventTypes).filter((type) => type && type.type).map((type) => [type.type, type.title || type.type]));
  const newest = new Map();
  for (const row of listOf(history)) {
    if (!row || !row.statusType) continue;
    const equipment = row.equipment || {};
    const key = `${equipment.equipmentSerial || equipment.equipmentId || equipment.equipmentType}|${row.statusType}`;
    const at = String(row.createdTime || row.statusTime || '');
    if (!newest.has(key) || at > newest.get(key).at) newest.set(key, { at, row });
  }
  return joined([...newest.values()].filter(({ row }) => [1, 2].includes(Number(row.statusCode)))
    .map(({ row }) => titles.get(row.statusType) || row.statusType));
}

/** The newest Cloud Connect check-in (epoch ms) and the system's time zone, from sources/system. */
function fromSources(answer) {
  const sources = (answer && answer.sources) || [];
  const times = sources.map((source) => Date.parse(source && source.last_checkin)).filter(Number.isFinite);
  const zoned = sources.find((source) => source && source.timezone);
  return { checkinAt: times.length ? Math.max(...times) : undefined, timeZone: zoned ? zoned.timezone : undefined };
}

/** The id of the System object (object_type_id 1) in objects/system, the one data/combined totals. */
function systemObjectId(answer) {
  const root = ((answer && answer.objects) || []).find((object) => object && object.object_type_id === 1);
  return root && root.id !== undefined && root.id !== null ? String(root.id) : undefined;
}

module.exports = {
  quantity, fromSummary, fromHomepage, panelsOf, panelPower, panelSeries, panelEnergy, gatewaySerials, alertTitles, equipmentFaults, fromSources, systemObjectId,
};
