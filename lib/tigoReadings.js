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

/** `{ powerW, todayKwh, lifetimeKwh, updatedAt }` from the official data/summary. */
function fromSummary(status) {
  const summary = status && status.summary;
  if (!summary) return null;
  return {
    powerW: quantity(summary.last_power_dc, 'W'),
    todayKwh: kwh(quantity(summary.daily_energy_dc, 'Wh')),
    lifetimeKwh: kwh(quantity(summary.lifetime_energy_dc, 'Wh')),
    updatedAt: summary.updated_on,
  };
}

/** The same from the app's homepage; units per its README, not verified live. */
function fromHomepage(homepage) {
  const production = homepage && homepage.energyProduction;
  if (!production) return null;
  return {
    powerW: quantity(production.now, 'W'),
    todayKwh: kwh(quantity(production.day, 'Wh')),
    lifetimeKwh: kwh(quantity(production.lifetime, 'Wh')),
    updatedAt: homepage.minLastTime,
  };
}

/**
 * Newest power per panel from the app's panel summary; '-' is no value.
 * @returns {{ power: Map<string, {value: number, t: string}>, lastData: string|undefined }} t is local 'HH:MM'
 */
function panelPower(summary) {
  const power = new Map();
  const blocks = summary && summary.dataset;
  for (const block of Array.isArray(blocks) ? blocks : [blocks]) {
    const order = (block && block.order) || [];
    for (const row of (block && block.data) || []) {
      (row.d || []).forEach((cell, i) => {
        const watt = cell === '-' ? undefined : quantity(cell, 'W');
        if (watt !== undefined && order[i] !== undefined) power.set(String(order[i]), { value: watt, t: String(row.t) });
      });
    }
  }
  return { power, lastData: summary && summary.lastData };
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

module.exports = {
  quantity, fromSummary, fromHomepage, panelPower, panelEnergy, gatewaySerials,
};
