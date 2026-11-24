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
One data/aggregate poll per Tigo system for all its panel devices: minutes for power, days for
today's energy. Panel devices register here and do not poll themselves.
*/

const TigoClient = require('../tigo');
const { latestPerObject, localIso } = require('./tigoAggregate');

// 5 requests per system per poll (Pin, Vin, Iin, RSSI per minute, Pin per day): every 5 min is 1440 a day at most.
const INTERVAL = 5 * 60 * 1000;
const IDLE_AFTER = 30 * 60 * 1000;
const IDLE_INTERVAL = 30 * 60 * 1000;
// power is the newest minute in this window; none means no current reading
const POWER_WINDOW = 30 * 60 * 1000;
const MINUTE_PARAMS = {
  powerW: 'Pin', voltageV: 'Vin', currentA: 'Iin', rssi: 'RSSI',
};
// Underperforming (own choice, not from Tigo): a day below 85% of the string's median, 3 days in a row;
// days whose median is under 0.2 kWh (dark, snow) don't count either way.
const UNDER_RATIO = 0.85;
const UNDER_DAYS = 3;
const UNDER_MIN_KWH = 0.2;
// below this median of today the comparison says nothing (morning, dark days)
const EFFICIENCY_MIN_KWH = 0.05;

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** devices grouped by their string setting */
const byString = (devices) => devices.reduce((groups, device) => {
  const key = device.getSettings().string || '';
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(device);
  return groups;
}, new Map());

class PanelPoller {

  constructor({ homey, log = () => {}, error = () => {} }) {
    this.homey = homey;
    this.log = log;
    this.error = error;
    this.systems = new Map(); // systemId -> { devices: Set, api, credentials, lastRequestAt, newDataAt, lastAt }
  }

  /** Add a panel device to its system's poll; polls soon after. */
  register(device) {
    const { systemId, username, password } = device.getSettings();
    let system = this.systems.get(systemId);
    if (!system) {
      system = { devices: new Set(), lastRequestAt: 0 };
      this.systems.set(systemId, system);
    }
    const credentials = `${username}\n${password}`;
    if (system.credentials !== credentials) {
      system.credentials = credentials;
      system.api = new TigoClient({
        username, password, homey: this.homey, log: (...args) => this.log(...args),
      });
      system.lastRequestAt = 0;
    }
    system.devices.add(device);
  }

  unregister(device) {
    for (const [systemId, system] of this.systems) {
      system.devices.delete(device);
      if (!system.devices.size) this.systems.delete(systemId);
    }
  }

  /** Every 5 min; after 30 min without a new minute every 30 min. */
  static due(system, now = Date.now()) {
    const idle = system.newDataAt && now - system.newDataAt > IDLE_AFTER;
    return now - system.lastRequestAt >= (idle ? IDLE_INTERVAL : INTERVAL);
  }

  /** Called every minute by the app. */
  async tick(now = Date.now()) {
    const polls = [...this.systems].filter(([, system]) => PanelPoller.due(system, now))
      .map(([systemId, system]) => this.poll(systemId, system, now).catch((error) => this.error(error)));
    await Promise.all(polls);
  }

  async poll(systemId, system, now = Date.now()) {
    const devices = [...system.devices];
    if (!devices.length) return;
    system.lastRequestAt = now;
    const timeZone = devices[0].getStoreValue('timezone') || this.homey.clock.getTimezone();
    const objectIds = devices.map((device) => device.getStoreValue('objectId')).filter((id) => id !== undefined && id !== null);
    const nowLocal = localIso(new Date(now), timeZone);
    try {
      if (!system.api.bearerToken) await system.api.login();
      const start = localIso(new Date(now - POWER_WINDOW), timeZone);
      const minutes = {};
      for (const [key, param] of Object.entries(MINUTE_PARAMS)) {
        minutes[key] = latestPerObject(await system.api.getAggregate({
          id: systemId, start, end: nowLocal, level: 'min', param, objectIds,
        }));
      }
      const days = latestPerObject(await system.api.getAggregate({
        id: systemId, start: `${nowLocal.slice(0, 10)}T00:00:00`, end: nowLocal, level: 'day', objectIds,
      }));
      const newest = [...minutes.powerW.values()].map(({ at }) => at).sort().pop();
      if (newest && newest !== system.lastAt) {
        system.lastAt = newest;
        system.newDataAt = now;
      }
      const readings = new Map(devices.map((device) => {
        const id = String(device.getStoreValue('objectId'));
        const reading = {};
        for (const key of Object.keys(MINUTE_PARAMS)) {
          const cell = minutes[key].get(id);
          reading[key] = cell ? cell.value : null;
        }
        const day = days.get(id);
        reading.todayKwh = day ? day.value / 1000 : undefined;
        return [device, reading];
      }));
      await this.compare(system, devices, readings, nowLocal.slice(0, 10));
      await Promise.all(devices.map((device) => device.update(readings.get(device)).catch((error) => this.error(error))));
    } catch (error) {
      this.error(`panels of system ${systemId}:`, error.message);
      // a rate-limit cooldown passes by itself; the last values stay
      if (error.statusCode === 429) return;
      await Promise.all(devices.map((device) => device.setUnavailable(error).catch((err) => this.error(err))));
    }
  }

}

/**
 * Adds efficiencyPct (today vs the string's median) and, at the first poll of a new day,
 * underperforming from yesterday's last values.
 */
PanelPoller.prototype.compare = async function compare(system, devices, readings, date) {
  const strings = byString(devices);
  for (const group of strings.values()) {
    const mid = median(group.map((device) => readings.get(device).todayKwh));
    for (const device of group) {
      const { todayKwh } = readings.get(device);
      readings.get(device).efficiencyPct = mid >= EFFICIENCY_MIN_KWH && Number.isFinite(todayKwh)
        ? Math.round((todayKwh / mid) * 1000) / 10 : null;
    }
  }
  if (system.day && system.day !== date && system.lastDayKwh) {
    for (const group of strings.values()) {
      const mid = median(group.map((device) => system.lastDayKwh.get(device)));
      if (!(mid >= UNDER_MIN_KWH)) continue;
      for (const device of group) {
        const kwh = system.lastDayKwh.get(device);
        if (!Number.isFinite(kwh)) continue;
        const days = kwh < UNDER_RATIO * mid ? (device.getStoreValue('underDays') || 0) + 1 : 0;
        await device.setStoreValue('underDays', days).catch((error) => this.error(error));
      }
    }
  }
  system.day = date;
  system.lastDayKwh = new Map(devices.map((device) => [device, readings.get(device).todayKwh]));
  for (const device of devices) readings.get(device).underperforming = (device.getStoreValue('underDays') || 0) >= UNDER_DAYS;
};

module.exports = PanelPoller;
