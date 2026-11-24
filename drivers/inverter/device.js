/*
Copyright 2025, Robin de Gruijter (rmdegruijter@gmail.com)

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

const Homey = require('homey');
const util = require('util');
const capture = require('../../lib/tigoCapture');
const DeviceMigrator = require('../../lib/DeviceMigrator');
const { solarTitle } = require('../../lib/solarTitles');
const { monotonic, raiseListenerCeiling, saveCounters } = require('../../lib/deviceHelpers');
const {
  clientFor, connect, findSystem, needsPremium,
} = require('../../lib/tigoSource');
const {
  fromSummary, fromHomepage, alertTitles, equipmentFaults, fromSources, systemObjectId,
} = require('../../lib/tigoReadings');
const { totalPerObject, localIso, shiftDay } = require('../../lib/tigoAggregate');

const setTimeoutPromise = util.promisify(setTimeout);

// Longer than a night: whether Tigo keeps updating while the panels are dark is not verified.
const CONNECTION_LOST_AFTER = 24 * 60 * 60 * 1000;
// Without new data for IDLE_AFTER (night, or a gateway offline) poll less often. The app's API
// has 15-minute data (per its third-party client, not verified).
const IDLE_AFTER = 30 * 60 * 1000;
const CADENCE = {
  v3: { interval: 0, idle: 10 * 60 * 1000 },
  mobile: { interval: 5 * 60 * 1000, idle: 30 * 60 * 1000 },
};
// on the app's API, how often to look whether the official API (EI Premium) works again
const PREMIUM_RECHECK = 24 * 60 * 60 * 1000;
// Alerts and the Cloud Connect check-in are extra requests; the poll runs every minute.
const STATUS_INTERVAL = 15 * 60 * 1000;
// Own choice: how often a Cloud Connect checks in is not verified.
const CHECKIN_LOST_AFTER = 2 * 60 * 60 * 1000;
// The official alerts are counted over a period Tigo does not document.
const ALERTS_SINCE = 30 * 24 * 60 * 60 * 1000;
const EVENT_TYPES_TTL = 24 * 60 * 60 * 1000;
// data/combined refuses more than 14 days; after a failure the month waits this long
const COMBINED_DAYS = 14;
const MONTH_RETRY = 30 * 60 * 1000;

module.exports = class MyDevice extends Homey.Device {

  async onInit() {
    if (this.destroyed) return;
    try {
      this.settings = await this.getSettings();
      const { username, password } = this.settings;
      capture.arm(`device restart: ${this.getName()}`);
      this.source = this.getStoreValue('apiSource') || 'v3';
      this.apiSystemId = this.getStoreValue('apiSystemId') || this.settings.systemId;
      capture.recordLogin({
        username, password, systemId: this.apiSystemId, systemName: this.settings.systemName, apiSource: this.source,
      }, (...args) => this.log(...args));
      this.api = clientFor(this.source, {
        username, password, homey: this.homey, log: (...args) => this.log(...args),
      });
      this.premiumCheckedAt = 0;
      this.statusCheckedAt = 0;
      this.checkinAt = undefined;
      this.timeZone = undefined;
      this.month = null;
      this.monthRetryAt = 0;
      this.objectId = undefined;
      this.eventTypes = null;
      this.restarting = false;
      this.busy = false;
      const changed = await DeviceMigrator.migrateCapabilities(this, this.driver.capabilityList(this.source));
      // a re-added capability is back on the manifest's options
      await DeviceMigrator.syncCapabilityOptions(this, this.capabilityOptions(), { force: changed });
      await this.startListeners();
      await this.setAvailable();
      await this.doPoll(); // initial poll
      this.log(this.getName(), `has been initialized on the ${this.source} API, system ${this.apiSystemId}`);
    } catch (error) {
      this.error(error);
      this.setUnavailable(error).catch((err) => this.error(err));
      this.restarting = false;
      this.restartDevice(60 * 1000).catch((error) => this.error(error));
    }
  }

  async onUninit() {
    this.destroyed = true;
    this.log('unInit', this.getName());
    this.unregisterListeners();
    await saveCounters(this);
  }

  async onAdded() {
    this.log('added', this.getName());
  }

  async onSettings({ changedKeys }) {
    // Homey's own "exclude from Energy" toggle is an energy_* setting
    if (changedKeys.length && changedKeys.every((key) => key.startsWith('energy_'))) return;
    this.log('Settings changed', this.getName(), changedKeys);
    this.restartDevice(1000).catch((error) => this.error(error));
  }

  async onRenamed(name) {
    this.log('Device was renamed', name);
  }

  async onDeleted() {
    this.destroyed = true;
    this.unregisterListeners();
    this.log('Device was deleted', this.getName());
  }

  async restartDevice(delay) {
    // this.destroyListeners();
    if (this.restarting) return;
    this.restarting = true;
    this.unregisterListeners();
    const dly = delay || 1000 * 5;
    this.log(`Device will restart in ${dly / 1000} seconds`);
    // this.setUnavailable(this.zigbee2MqttType, 'is restarting');
    await setTimeoutPromise(dly);
    if (this.destroyed) return;
    this.onInit().catch((error) => this.error(error));
  }

  /** Tigo reports DC power and energy only. */
  capabilityOptions() {
    return {
      measure_power: { title: solarTitle('measure_power', 'dc') },
      meter_power: { title: solarTitle('meter_power', 'dc') },
      'meter_power.today': { title: solarTitle('meter_power.today', 'dc') },
      'meter_power.month': { title: solarTitle('meter_power.month', 'dc') },
      'meter_power.year': { title: solarTitle('meter_power.year', 'dc') },
    };
  }

  async setCapability(capability, value) {
    if (this.hasCapability(capability) && value !== undefined && !Number.isNaN(value)) {
      await this.setCapabilityValue(capability, value).catch((error) => {
        this.log(error, capability, value);
      });
    }
  }

  // setSetting(setting, value) {
  //   const settings = this.getSettings();
  //   if (settings && settings[setting] !== value) {
  //     const newSettings = {};
  //     newSettings[setting] = value;
  //     this.log('New setting:', newSettings);
  //     this.setSettings(newSettings).catch((error) => {
  //       this.log(error, setting, value);
  //     });
  //   }
  // }

  pollDue(now = Date.now()) {
    const cadence = CADENCE[this.source] || CADENCE.v3;
    const idle = this.updatedSeenAt && now - this.updatedSeenAt >= IDLE_AFTER;
    return now - (this.lastRequestAt || 0) >= (idle ? cadence.idle : cadence.interval);
  }

  /**
   * Move to the other API when it holds this system; the device restarts on it.
   * @returns {Promise<boolean>} whether it moves
   */
  async switchSource(only) {
    try {
      const {
        username, password, systemId, systemName,
      } = this.settings;
      const { source, systems } = await connect({
        username, password, homey: this.homey, log: (...args) => this.log(...args),
      }, { only });
      const system = findSystem(systems, { ids: [this.apiSystemId, systemId], name: systemName });
      if (source === this.source || !system) return false;
      this.log(`${this.getName()}: moving from the ${this.source} to the ${source} API`);
      await this.setStoreValue('apiSource', source);
      await this.setStoreValue('apiSystemId', `${system.id}`);
      this.restartDevice(1000).catch((error) => this.error(error));
      return true;
    } catch (error) {
      this.log(`${this.getName()}: ${only} API not usable:`, error.statusCode || '', error.message);
      return false;
    }
  }

  async doPoll() {
    try {
      if (!this.api) throw Error(this.homey.__('errors.notConnected'));
      if (!this.pollDue()) return;
      const now = Date.now();
      this.lastRequestAt = now;
      if (this.source === 'mobile' && now - this.premiumCheckedAt >= PREMIUM_RECHECK) {
        this.premiumCheckedAt = now;
        if (await this.switchSource('v3')) return;
      }
      if (!this.api.bearerToken) await this.api.login();
      // first, so the reading already has the check-in and time zone; a failure leaves the device available
      await this.updateStatus().catch((error) => this.error(error));
      if (this.source === 'mobile') await this.handleReading(fromHomepage(await this.api.getHomepage({ id: this.apiSystemId })));
      else await this.handleDeviceData(await this.api.getStatus({ id: this.apiSystemId }));
    } catch (error) {
      this.error(`poll on the ${this.source} API failed:`, error.statusCode || '', error.message);
      // a rate-limit cooldown passes by itself; the last values stay
      if (error.statusCode === 429) return;
      if (this.source === 'v3' && needsPremium(error) && await this.switchSource('mobile')) return;
      this.setUnavailable(error).catch((error) => this.error(error));
    }
  }

  /** An answer of the official data/summary; it has no month, that comes from data/combined. */
  async handleDeviceData(status) {
    const reading = fromSummary(status);
    if (reading && this.api && this.hasCapability('meter_power.month')) {
      reading.monthKwh = await this.monthKwh(reading).catch((error) => {
        this.error('month energy:', error.message);
        return undefined;
      });
    }
    return this.handleReading(reading);
  }

  /** This month: the finished days (once per day) plus today when the summary is of today. */
  async monthKwh({ todayKwh, updatedAt }) {
    const today = localIso(new Date(), this.timeZone || this.homey.clock.getTimezone()).slice(0, 10);
    if (!this.month || this.month.day !== today) {
      if (Date.now() < this.monthRetryAt) return undefined;
      try {
        this.month = { day: today, kwh: await this.finishedDaysKwh(today) };
      } catch (error) {
        this.monthRetryAt = Date.now() + MONTH_RETRY;
        throw error;
      }
    }
    // updated_on carries the system's own offset, so its date is the system's day
    const ofToday = String(updatedAt || '').slice(0, 10) === today && Number.isFinite(todayKwh);
    return this.month.kwh + (ofToday ? todayKwh : 0);
  }

  async finishedDaysKwh(today) {
    const first = `${today.slice(0, 8)}01`;
    const yesterday = shiftDay(today, -1);
    if (first > yesterday) return 0;
    if (!this.objectId) this.objectId = systemObjectId(await this.api.getObjects({ id: this.apiSystemId }));
    if (!this.objectId) throw Error(this.homey.__('errors.noData'));
    let wh = 0;
    for (let start = first; start <= yesterday; start = shiftDay(start, COMBINED_DAYS)) {
      const last = shiftDay(start, COMBINED_DAYS - 1) < yesterday ? shiftDay(start, COMBINED_DAYS - 1) : yesterday;
      const csv = await this.api.getCombined({
        id: this.apiSystemId, start: `${start}T00:00:00`, end: `${last}T23:59:59`, level: 'day', objectIds: [this.objectId],
      });
      wh += totalPerObject(csv).get(this.objectId) || 0;
    }
    return wh / 1000;
  }

  /** @param {object} reading { powerW, todayKwh, lifetimeKwh, updatedAt } (lib/tigoReadings.js) */
  async handleReading(reading) {
    if (!reading) throw Error(this.homey.__('errors.noData'));
    if (reading.updatedAt !== this.lastUpdatedOn) {
      // after an app start, a timestamp with a zone tells how old the data already is
      const at = this.lastUpdatedOn === undefined && /(Z|[+-]\d\d:?\d\d)$/.test(String(reading.updatedAt))
        ? Date.parse(reading.updatedAt) : NaN;
      this.lastUpdatedOn = reading.updatedAt;
      this.updatedSeenAt = Number.isFinite(at) && at < Date.now() ? at : Date.now();
    }
    const dataStale = Date.now() - this.updatedSeenAt > CONNECTION_LOST_AFTER;
    // the official API tells when the Cloud Connect last checked in, also at night
    const connectionLost = Number.isFinite(this.checkinAt) ? Date.now() - this.checkinAt > CHECKIN_LOST_AFTER : dataStale;
    if (connectionLost !== !!this.connectionLost) {
      this.connectionLost = connectionLost;
      this.log(connectionLost ? `No new data for ${this.getName()} for 24 hours: connection alarm` : `${this.getName()} has new data again`);
    }
    await this.setAvailable().catch((error) => this.error(error));
    this.lastPoll = Date.now();
    await this.setCapability('alarm_connectivity', connectionLost);
    // a day-old power reading is not the current one
    if (connectionLost || dataStale) await this.setCapabilityValue('measure_power', null).catch((error) => this.error(error));
    else this.setCapability('measure_power', reading.powerW).catch((error) => this.error(error));
    if (reading.lifetimeKwh > 0) {
      monotonic(this, 'meter_power', reading.lifetimeKwh)
        .then((value) => this.setCapability('meter_power', value))
        .catch((error) => this.error(error));
    }
    this.setCapability('meter_power.today', reading.todayKwh).catch((error) => this.error(error));
    this.setCapability('meter_power.month', reading.monthKwh).catch((error) => this.error(error));
    this.setCapability('meter_power.year', reading.yearKwh).catch((error) => this.error(error));
  }

  /** Alerts, and on the official API the Cloud Connect check-in; every 15 min. */
  async updateStatus() {
    if (Date.now() - this.statusCheckedAt < STATUS_INTERVAL) return;
    this.statusCheckedAt = Date.now();
    if (this.source === 'mobile') {
      await this.updateEquipmentFaults();
      return;
    }
    await this.updateAlerts().catch((error) => this.error('alerts:', error.message));
    const { checkinAt, timeZone } = fromSources(await this.api.getSources({ id: this.apiSystemId }));
    this.checkinAt = checkinAt;
    if (timeZone) this.timeZone = timeZone;
  }

  /** alarm_problem from the system's recent_alerts_count (what Tigo counts as recent is not verified), with their titles. */
  async updateAlerts() {
    const { systems } = await this.api.getSystems();
    const system = (systems || []).find((item) => String(item.system_id) === String(this.apiSystemId));
    if (!system || typeof system.recent_alerts_count !== 'number') return;
    const count = system.recent_alerts_count;
    await this.setCapability('alarm_problem', count > 0);
    const titles = count > 0
      ? alertTitles(await this.api.getAlerts({ id: this.apiSystemId, startAdded: new Date(Date.now() - ALERTS_SINCE).toISOString() }), count)
      : null;
    await this.setCapability('active_faults', titles);
  }

  /** The app's equipment states that are a warning or error now. */
  async updateEquipmentFaults() {
    if (!this.eventTypes || Date.now() - this.eventTypes.at > EVENT_TYPES_TTL) {
      // titles only: without them the status type is shown
      const types = await this.api.getEventTypes({ id: this.apiSystemId }).catch(() => null);
      this.eventTypes = { at: Date.now(), types };
    }
    const faults = equipmentFaults(await this.api.getEquipmentStatus({ id: this.apiSystemId }), this.eventTypes.types);
    await this.setCapability('alarm_problem', faults !== null);
    await this.setCapability('active_faults', faults);
  }

  async startListeners() {
    this.unregisterListeners();
    // add listener for X minute trigger
    this.eventListenerXminutes = (minute) => {
      this.doPoll().catch((error) => this.error(error));
    };
    raiseListenerCeiling(this.homey, 'everyXminutes');
    this.homey.on('everyXminutes', this.eventListenerXminutes);
    this.log('listeners registered', this.getName());
  }

  unregisterListeners() {
    if (this.eventListenerXminutes) {
      this.homey.removeListener('everyXminutes', this.eventListenerXminutes);
      this.log('unregistered X minute listener', this.getName());
    }
    this.eventListenerXminutes = null;
  }

};
