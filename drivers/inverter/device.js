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

const setTimeoutPromise = util.promisify(setTimeout);

module.exports = class MyDevice extends Homey.Device {

  async onInit() {
    try {
      this.settings = await this.getSettings();
      const { username, password } = this.settings;
      this.api = new TigoClient({ username, password });
      this.restarting = false;
      this.busy = false;
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

  async setCapability(capability, value) {
    if (this.hasCapability(capability) && value !== undefined) {
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

  async doPoll() {
    try {
      if (!this.api) throw Error('API not initialized');
      if (!this.api.bearerToken) await this.api.login();
      const status = await this.api.getStatus({ id: this.settings.systemId });
      if (!status) throw Error('Status data not found');
      await this.handleDeviceData(status);
    } catch (error) {
      this.error(error);
      this.setUnavailable(error).catch((error) => this.error(error));
    }
  }

  async handleDeviceData(status) {
    // console.dir(status, { depth: null });
    if (!status || !status.summary) throw Error('Status data not found');
    if (!this.lastStatus) this.lastStatus = {};
    if (status.summary.updated_on === this.lastStatus.updated_on && Date.now() - this.lastPoll > 1000 * 60 * 60) throw Error('No updates');
    await this.setAvailable().catch((error) => this.error(error));
    this.lastPoll = Date.now();
    this.lastSummary = status.summary;
    this.setCapability('measure_power', Number(status.summary.last_power_dc)).catch((error) => this.error(error));
    this.setCapability('meter_power', Number(status.summary.lifetime_energy_dc / 1000)).catch((error) => this.error(error));
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

  async startListeners() {
    this.unregisterListeners();
    // add listener for X minute trigger
    this.eventListenerXminutes = (minute) => {
      this.doPoll().catch((error) => this.error(error));
    };
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
