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
const TigoClient = require('../../tigo');
const capture = require('../../lib/tigoCapture');
const DeviceMigrator = require('../../lib/DeviceMigrator');
const { solarTitle } = require('../../lib/solarTitles');
const { monotonic, raiseListenerCeiling, saveCounters } = require('../../lib/deviceHelpers');

const setTimeoutPromise = util.promisify(setTimeout);

// Longer than a night: whether Tigo keeps updating while the panels are dark is not verified.
const CONNECTION_LOST_AFTER = 24 * 60 * 60 * 1000;
// Without new data (night, or a gateway offline) poll every 10 minutes instead of every minute.
const IDLE_AFTER = 30 * 60 * 1000;
const IDLE_INTERVAL = 10 * 60 * 1000;
// The alerts come with the systems list, a second request; the poll runs every minute.
const ALERTS_INTERVAL = 15 * 60 * 1000;

module.exports = class MyDevice extends Homey.Device {

  async onInit() {
    try {
      this.settings = await this.getSettings();
      const { username, password } = this.settings;
      capture.arm(`device restart: ${this.getName()}`);
      this.api = new TigoClient({
        username, password, homey: this.homey, log: (...args) => this.log(...args),
      });
      this.restarting = false;
      this.busy = false;
      const changed = await DeviceMigrator.migrateCapabilities(this, this.driver.manifest.capabilities);
      // a re-added capability is back on the manifest's options
      await DeviceMigrator.syncCapabilityOptions(this, this.capabilityOptions(), { force: changed });
      await this.startListeners();
      await this.setAvailable();
      await this.doPoll(); // initial poll
      this.log(this.getName(), 'has been initialized');
    } catch (error) {
      this.error(error);
      this.setUnavailable(error).catch(this.error);
      this.restarting = false;
      this.restartDevice(60 * 1000).catch((error) => this.error(error));
    }
  }

  async onUninit() {
    this.log('unInit', this.getName());
    this.unregisterListeners();
    await saveCounters(this);
  }

  async onAdded() {
    this.log('added', this.getName());
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings changed', this.getName(), newSettings);
    this.restartDevice(1000).catch((error) => this.error(error));
  }

  async onRenamed(name) {
    this.log('Device was renamed', name);
  }

  async onDeleted() {
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

  /** No new data for IDLE_AFTER: only every IDLE_INTERVAL. */
  pollDue(now = Date.now()) {
    if (!this.updatedSeenAt || now - this.updatedSeenAt < IDLE_AFTER) return true;
    return now - (this.lastRequestAt || 0) >= IDLE_INTERVAL;
  }

  async doPoll() {
    try {
      if (!this.api) throw Error(this.homey.__('errors.notConnected'));
      if (!this.pollDue()) return;
      this.lastRequestAt = Date.now();
      if (!this.api.bearerToken) await this.api.login();
      const status = await this.api.getStatus({ id: this.settings.systemId });
      if (!status) throw Error(this.homey.__('errors.noData'));
      await this.handleDeviceData(status);
      // a failed alerts check leaves the device available
      await this.updateAlerts().catch((error) => this.error(error));
    } catch (error) {
      this.error(error);
      // a rate-limit cooldown passes by itself; the last values stay
      if (error.statusCode === 429) return;
      this.setUnavailable(error).catch((error) => this.error(error));
    }
  }

  async handleDeviceData(status) {
    // console.dir(status, { depth: null });
    if (!status || !status.summary) throw Error(this.homey.__('errors.noData'));
    if (status.summary.updated_on !== this.lastUpdatedOn) {
      this.lastUpdatedOn = status.summary.updated_on;
      this.updatedSeenAt = Date.now();
    }
    const connectionLost = Date.now() - this.updatedSeenAt > CONNECTION_LOST_AFTER;
    if (connectionLost !== !!this.connectionLost) {
      this.connectionLost = connectionLost;
      this.log(connectionLost ? `No new data for ${this.getName()} for 24 hours: connection alarm` : `${this.getName()} has new data again`);
    }
    await this.setAvailable().catch((error) => this.error(error));
    this.lastPoll = Date.now();
    this.lastSummary = status.summary;
    await this.setCapability('alarm_connectivity', connectionLost);
    // a day-old power reading is not the current one
    if (connectionLost) await this.setCapabilityValue('measure_power', null).catch((error) => this.error(error));
    else this.setCapability('measure_power', Number(status.summary.last_power_dc)).catch((error) => this.error(error));
    const lifetime = Number(status.summary.lifetime_energy_dc) / 1000;
    if (lifetime > 0) {
      monotonic(this, 'meter_power', lifetime)
        .then((value) => this.setCapability('meter_power', value))
        .catch((error) => this.error(error));
    }
    this.setCapability('meter_power.today', Number(status.summary.daily_energy_dc) / 1000).catch((error) => this.error(error));
    // // set settings that have changed
    // const newSettings = {
    //   systemId,
    //   apiKey,
    //   systemName,
    //   systemSize,
    //   interval,
    // };
    // for (const [key, value] of Object.entries(newSettings)) this.setSetting(key, value);
  }

  /** alarm_problem from the system's recent_alerts_count; what Tigo counts as recent is not verified. */
  async updateAlerts() {
    if (!this.hasCapability('alarm_problem') || Date.now() - (this.alertsCheckedAt || 0) < ALERTS_INTERVAL) return;
    this.alertsCheckedAt = Date.now();
    const { systems } = await this.api.getSystems();
    const system = (systems || []).find((item) => String(item.system_id) === String(this.settings.systemId));
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
