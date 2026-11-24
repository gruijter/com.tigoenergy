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
const { fromSummary, fromHomepage } = require('../../lib/tigoReadings');

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
// The alerts come with the systems list, a second request; the poll runs every minute.
const ALERTS_INTERVAL = 15 * 60 * 1000;

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
      if (this.source === 'mobile') {
        await this.handleReading(fromHomepage(await this.api.getHomepage({ id: this.apiSystemId })));
        return;
      }
      await this.handleDeviceData(await this.api.getStatus({ id: this.apiSystemId }));
      // a failed alerts check leaves the device available
      await this.updateAlerts().catch((error) => this.error(error));
    } catch (error) {
      this.error(`poll on the ${this.source} API failed:`, error.statusCode || '', error.message);
      // a rate-limit cooldown passes by itself; the last values stay
      if (error.statusCode === 429) return;
      if (this.source === 'v3' && needsPremium(error) && await this.switchSource('mobile')) return;
      this.setUnavailable(error).catch((error) => this.error(error));
    }
  }

  /** An answer of the official data/summary. */
  async handleDeviceData(status) {
    return this.handleReading(fromSummary(status));
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
    const connectionLost = Date.now() - this.updatedSeenAt > CONNECTION_LOST_AFTER;
    if (connectionLost !== !!this.connectionLost) {
      this.connectionLost = connectionLost;
      this.log(connectionLost ? `No new data for ${this.getName()} for 24 hours: connection alarm` : `${this.getName()} has new data again`);
    }
    await this.setAvailable().catch((error) => this.error(error));
    this.lastPoll = Date.now();
    await this.setCapability('alarm_connectivity', connectionLost);
    // a day-old power reading is not the current one
    if (connectionLost) await this.setCapabilityValue('measure_power', null).catch((error) => this.error(error));
    else this.setCapability('measure_power', reading.powerW).catch((error) => this.error(error));
    if (reading.lifetimeKwh > 0) {
      monotonic(this, 'meter_power', reading.lifetimeKwh)
        .then((value) => this.setCapability('meter_power', value))
        .catch((error) => this.error(error));
    }
    this.setCapability('meter_power.today', reading.todayKwh).catch((error) => this.error(error));
  }

  /** alarm_problem from the system's recent_alerts_count; what Tigo counts as recent is not verified. */
  async updateAlerts() {
    if (!this.hasCapability('alarm_problem') || Date.now() - (this.alertsCheckedAt || 0) < ALERTS_INTERVAL) return;
    this.alertsCheckedAt = Date.now();
    const { systems } = await this.api.getSystems();
    const system = (systems || []).find((item) => String(item.system_id) === String(this.apiSystemId));
    if (system && typeof system.recent_alerts_count === 'number') await this.setCapability('alarm_problem', system.recent_alerts_count > 0);
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
