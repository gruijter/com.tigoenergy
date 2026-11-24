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
data/aggregate CSV (API V3 document p. 22-23): `Datetime,<id>,<id>` then rows `2014/09/23 00:06:23,23,23`.
The header can repeat with other columns further down; a row belongs to the header above it.
*/

/** Calls `onValue(columnId, number, datetime)` for every numeric cell, in order. */
function eachValue(csv, onValue) {
  let header = null;
  for (const line of String(csv || '').split(/\r?\n/)) {
    const cells = line.split(',').map((cell) => cell.trim());
    if (!cells[0]) continue;
    if (/^datetime$/i.test(cells[0])) {
      header = cells;
      continue;
    }
    if (!header) continue;
    for (let i = 1; i < header.length; i += 1) {
      const value = cells[i] === undefined || cells[i] === '' ? NaN : Number(cells[i]);
      if (Number.isFinite(value)) onValue(header[i], value, cells[0]);
    }
  }
}

/**
 * Latest numeric value per column id.
 * @param {string} csv
 * @returns {Map<string, {value: number, at: string}>}
 */
function latestPerObject(csv) {
  const latest = new Map();
  eachValue(csv, (id, value, at) => latest.set(id, { value, at }));
  return latest;
}

/** The sum per column id, e.g. Wh of all days of a data/combined answer at level day. */
function totalPerObject(csv) {
  const totals = new Map();
  eachValue(csv, (id, value) => totals.set(id, (totals.get(id) || 0) + value));
  return totals;
}

/** `day` (YYYY-MM-DD) plus `days` calendar days. */
const shiftDay = (day, days) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

/** `date` as local `YYYY-MM-DDTHH:mm:ss` in `timeZone`, the form the API takes for start/end. */
function localIso(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

module.exports = {
  latestPerObject, totalPerObject, localIso, shiftDay,
};
