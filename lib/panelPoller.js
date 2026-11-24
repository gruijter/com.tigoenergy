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

const capture = require('./tigoCapture');
const { latestPerObject, localIso } = require('./tigoAggregate');
const {
  clientFor, connect, findSystem, needsPremium,
} = require('./tigoSource');
const {
  panelPower, panelSeries, panelEnergy, gatewaySerials,
} = require('./tigoReadings');

// 5 requests per system per poll (Pin, Vin, Iin, RSSI per minute, Pin per day): every 5 min is 1440 a day at most.
// The app's API: 5 per gateway (pin, vin, iin, rssi, temp) plus one for the energy.
const INTERVAL = 5 * 60 * 1000;
const IDLE_AFTER = 30 * 60 * 1000;
const IDLE_INTERVAL = 30 * 60 * 1000;
// power is the newest minute in this window; none means no current reading
const POWER_WINDOW = 30 * 60 * 1000;
// the app's API: 15-minute data that arrives 10-20 min late (its third-party client, not verified)
const MOBILE_POWER_WINDOW = 60;
// besides power on the app's API; a failing one leaves its tile as it is (M. Stranik's Tigo app)
const MOBILE_FIELDS = {
  voltageV: 'vin', currentA: 'iin', rssi: 'rssi', tempC: 'temp',
};
// on the app's API, how often to look whether the official API (EI Premium) works again
const PREMIUM_RECHECK = 24 * 60 * 60 * 1000;
const MINUTE_PARAMS = {
  powerW: 'Pin', voltageV: 'Vin', currentA: 'Iin', rssi: 'RSSI',
};
// Underperforming (own choice, not from Tigo): a day below 85% of the string's median, 3 days in a row;
// days whose median is under 0.2 kWh (dark, snow) don't count either way.
const UNDER_RATIO = 0.85;
const UNDER_DAYS = 3;
const UNDER_MIN_KWH = 0.2;
// fewer paired panels in a string give no meaningful median (3, as M. Stranik's Tigo app)
const MIN_COMPARED = 3;
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
    // systemId -> { devices: Set, api, source, apiSystemId, credentials, lastRequestAt, newDataAt, lastAt }
    this.systems = new Map();
  }

  /** Add a panel device to its system's poll; polls soon after. */
  register(device) {
    const { systemId, username, password } = device.getSettings();
    let system = this.systems.get(systemId);
    if (!system) {
      system = { devices: new Set(), lastRequestAt: 0 };
      this.systems.set(systemId, system);
    }
    const source = device.getStoreValue('apiSource') || 'v3';
    capture.recordLogin({
      username, password, systemId: device.getStoreValue('apiSystemId') || systemId, systemName: device.getSettings().systemName, apiSource: source,
    }, (...args) => this.log(...args));
    const apiSystemId = device.getStoreValue('apiSystemId') || systemId;
    const credentials = `${username}\n${password}\n${source}\n${apiSystemId}`;
    if (system.credentials !== credentials) {
      system.credentials = credentials;
      system.source = source;
      system.apiSystemId = apiSystemId;
      system.api = clientFor(source, {
        username, password, homey: this.homey, log: (...args) => this.log(...args),
      });
      system.gateways = null;
      system.premiumCheckedAt = 0;
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

  /** A panel without a value yet today has made 0 kWh, not yesterday's total. */
  static fillToday(system, readings, date) {
    if (system.todayDate !== date) {
      system.todayDate = date;
      system.hasToday = new Set();
    }
    for (const [device, reading] of readings) {
      if (reading.todayKwh !== undefined) system.hasToday.add(device);
      else if (!system.hasToday.has(device)) reading.todayKwh = 0;
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
      if (system.source === 'mobile' && now - system.premiumCheckedAt >= PREMIUM_RECHECK) {
        system.premiumCheckedAt = now;
        if (await this.switchSource(systemId, system, 'v3')) return;
      }
      if (!system.api.bearerToken) await system.api.login();
      const { readings, newest } = system.source === 'mobile'
        ? await this.readMobile(system, devices, nowLocal)
        : await this.readV3(system, devices, now, nowLocal, objectIds, timeZone);
      if (newest && newest !== system.lastAt) {
        system.lastAt = newest;
        system.newDataAt = now;
      }
      PanelPoller.fillToday(system, readings, nowLocal.slice(0, 10));
      await this.compare(system, devices, readings, nowLocal.slice(0, 10));
      await Promise.all(devices.map((device) => device.update(readings.get(device)).catch((error) => this.error(error))));
    } catch (error) {
      this.error(`panels of system ${systemId} on the ${system.source} API:`, error.statusCode || '', error.message);
      // a rate-limit cooldown passes by itself; the last values stay
      if (error.statusCode === 429) return;
      if (system.source === 'v3' && needsPremium(error) && await this.switchSource(systemId, system, 'mobile')) return;
      await Promise.all(devices.map((device) => device.setUnavailable(error).catch((err) => this.error(err))));
    }
  }

  /** Pin, Vin, Iin, RSSI per minute and Pin per day of the official API. */
  async readV3(system, devices, now, nowLocal, objectIds, timeZone) {
    const start = localIso(new Date(now - POWER_WINDOW), timeZone);
    const minutes = {};
    for (const [key, param] of Object.entries(MINUTE_PARAMS)) {
      minutes[key] = latestPerObject(await system.api.getAggregate({
        id: system.apiSystemId, start, end: nowLocal, level: 'min', param, objectIds,
      }));
    }
    const days = latestPerObject(await system.api.getAggregate({
      id: system.apiSystemId, start: `${nowLocal.slice(0, 10)}T00:00:00`, end: nowLocal, level: 'day', objectIds,
    }));
    const newest = [...minutes.powerW.values()].map(({ at }) => at).sort().pop();
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
    return { readings, newest };
  }

  /** Power, the MOBILE_FIELDS and today's energy per panel of the app's API. */
  async readMobile(system, devices, nowLocal) {
    const id = system.apiSystemId;
    const date = nowLocal.slice(0, 10);
    if (!system.gateways) system.gateways = gatewaySerials(await system.api.getEquipments({ id }));
    const minuteOf = (hhmm) => {
      const [hour, minute] = String(hhmm).split(':').map(Number);
      return hour * 60 + minute;
    };
    const nowMinute = minuteOf(nowLocal.slice(11, 16));
    const recent = (cells, into) => {
      for (const [objectId, cell] of cells) {
        if (nowMinute - minuteOf(cell.t) <= MOBILE_POWER_WINDOW) into.set(objectId, cell.value);
      }
    };
    const values = { powerW: new Map() };
    const failed = new Set();
    let newest;
    for (const uid of system.gateways) {
      const result = panelPower(await system.api.getPanelPower({ id, date, uid }));
      recent(result.power, values.powerW);
      if (result.lastData && !(newest >= result.lastData)) newest = result.lastData;
      for (const [key, temp] of Object.entries(MOBILE_FIELDS)) {
        if (!values[key]) values[key] = new Map();
        try {
          recent(panelSeries(await system.api.getPanelSeries({
            id, date, uid, temp,
          })), values[key]);
        } catch (error) {
          if (error.statusCode === 429) throw error;
          failed.add(key);
          this.log(`panels of system ${id}: no ${temp} on the app's API:`, error.statusCode || '', error.message);
        }
      }
    }
    const energy = panelEnergy(await system.api.getPanelEnergy({ id, date }));
    const readings = new Map(devices.map((device) => {
      const objectId = String(device.getStoreValue('objectId'));
      const reading = { todayKwh: energy.get(objectId) };
      for (const [key, found] of Object.entries(values)) {
        if (!failed.has(key)) reading[key] = found.has(objectId) ? found.get(objectId) : null;
      }
      return [device, reading];
    }));
    return { readings, newest };
  }

  /**
   * Move a system's panels to the other API when it holds the system.
   * @returns {Promise<boolean>} whether they moved
   */
  async switchSource(systemId, system, only) {
    const devices = [...system.devices];
    const { username, password, systemName } = devices[0].getSettings();
    try {
      const { source, systems } = await connect({
        username, password, homey: this.homey, log: (...args) => this.log(...args),
      }, { only });
      const found = findSystem(systems, { ids: [system.apiSystemId, systemId], name: systemName });
      if (source === system.source || !found) return false;
      this.log(`panels of system ${systemId}: moving from the ${system.source} to the ${source} API`);
      for (const device of devices) await device.useSource(source, `${found.id}`);
      for (const device of devices) this.register(device);
      return true;
    } catch (error) {
      this.log(`panels of system ${systemId}: ${only} API not usable:`, error.statusCode || '', error.message);
      return false;
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
      readings.get(device).efficiencyPct = group.length >= MIN_COMPARED && mid >= EFFICIENCY_MIN_KWH && Number.isFinite(todayKwh)
        ? Math.round((todayKwh / mid) * 1000) / 10 : null;
    }
  }
  if (system.day && system.day !== date && system.lastDayKwh) {
    for (const group of strings.values()) {
      const mid = median(group.map((device) => system.lastDayKwh.get(device)));
      if (group.length < MIN_COMPARED || !(mid >= UNDER_MIN_KWH)) continue;
      for (const device of group) {
        const kwh = system.lastDayKwh.get(device);
        if (!Number.isFinite(kwh)) continue;
        const days = kwh < UNDER_RATIO * mid ? (device.getStoreValue('underDays') || 0) + 1 : 0;
        await device.setStoreValue('underDays', days).catch((error) => this.error(error));
      }
    }
  }
  system.day = date;
  // a panel missing from one poll keeps its last value of the day
  const previous = system.lastDayKwh || new Map();
  system.lastDayKwh = new Map(devices.map((device) => {
    const { todayKwh } = readings.get(device);
    return [device, todayKwh !== undefined ? todayKwh : previous.get(device)];
  }));
  for (const device of devices) readings.get(device).underperforming = (device.getStoreValue('underDays') || 0) >= UNDER_DAYS;
};

module.exports = PanelPoller;
