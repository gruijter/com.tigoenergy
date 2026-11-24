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

const Homey = require('homey');
const DeviceMigrator = require('../../lib/DeviceMigrator');

module.exports = class PanelDevice extends Homey.Device {

  async onInit() {
    // the poll does not need either, so a failure still registers
    await this.applySource().catch((error) => this.error(error));
    const { string } = this.getSettings();
    if (this.hasCapability('panel_string')) await this.setCapabilityValue('panel_string', string || null).catch((error) => this.error(error));
    this.homey.app.panelPoller.register(this);
    this.log(this.getName(), `has been initialized on the ${this.getStoreValue('apiSource') || 'v3'} API`);
  }

  async onUninit() {
    this.homey.app.panelPoller.unregister(this);
  }

  async onDeleted() {
    this.homey.app.panelPoller.unregister(this);
  }

  async onSettings({ changedKeys }) {
    // Homey's own "exclude from Energy" toggle is an energy_* setting
    if (changedKeys.length && changedKeys.every((key) => key.startsWith('energy_'))) return;
    // after onSettings resolves the new values apply; then register with the new login
    this.homey.setTimeout(() => {
      this.shareLogin().catch((error) => this.error(error));
    }, 1000);
  }

  /** Called by lib/panelPoller.js; `null` clears a tile, `undefined` leaves it. */
  async update(reading) {
    if (!this.getAvailable()) await this.setAvailable();
    const round = (value, decimals) => (typeof value === 'number' ? Math.round(value * 10 ** decimals) / 10 ** decimals : value);
    const values = {
      measure_watt_panel: reading.powerW,
      meter_kwh_panel_today: round(reading.todayKwh, 3),
      measure_volt_panel: round(reading.voltageV, 1),
      measure_amp_panel: round(reading.currentA, 2),
      measure_temperature_panel: round(reading.tempC, 1),
      measure_rssi_panel: reading.rssi,
      measure_efficiency_panel: reading.efficiencyPct,
      alarm_underperforming_panel: reading.underperforming,
    };
    for (const [cap, value] of Object.entries(values)) {
      if (value !== undefined && this.hasCapability(cap)) await this.setCapabilityValue(cap, value);
    }
  }

  /** Capabilities for the API in the store (the app's API has no V, I and RSSI). */
  async applySource() {
    const source = this.getStoreValue('apiSource') || 'v3';
    await DeviceMigrator.migrateCapabilities(this, this.driver.capabilityList(source));
  }

  /** Called by lib/panelPoller.js when the system moves to another API. */
  async useSource(source, apiSystemId) {
    await this.setStoreValue('apiSource', source);
    await this.setStoreValue('apiSystemId', apiSystemId);
    await this.applySource().catch((error) => this.error(error));
  }

  /** Repair stores the new login and API; poll with them. */
  async restartDevice() {
    await this.applySource().catch((error) => this.error(error));
    await this.shareLogin();
  }

  /** One login per system: the other panels of this system get it too, then the poll uses it. */
  async shareLogin() {
    const { systemId, username, password } = this.getSettings();
    const source = this.getStoreValue('apiSource') || 'v3';
    const apiSystemId = this.getStoreValue('apiSystemId') || systemId;
    for (const other of this.driver.getDevices()) {
      if (other === this || other.getSettings().systemId !== systemId) continue;
      try {
        const settings = other.getSettings();
        if (settings.username !== username || settings.password !== password) await other.setSettings({ username, password });
        if ((other.getStoreValue('apiSource') || 'v3') !== source || other.getStoreValue('apiSystemId') !== apiSystemId) {
          await other.useSource(source, apiSystemId);
        }
      } catch (error) {
        this.error(error);
      }
    }
    this.homey.app.panelPoller.register(this);
  }

};
