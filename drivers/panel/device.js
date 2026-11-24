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
    try {
      await DeviceMigrator.migrateCapabilities(this, this.driver.manifest.capabilities);
      const { string } = this.getSettings();
      if (this.hasCapability('panel_string')) await this.setCapabilityValue('panel_string', string || null);
      this.homey.app.panelPoller.register(this);
      this.log(this.getName(), 'has been initialized');
    } catch (error) {
      this.error(error);
      this.setUnavailable(error).catch(this.error);
    }
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
    this.homey.setTimeout(() => this.homey.app.panelPoller.register(this), 1000);
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
      measure_rssi_panel: reading.rssi,
      measure_efficiency_panel: reading.efficiencyPct,
      alarm_underperforming_panel: reading.underperforming,
    };
    for (const [cap, value] of Object.entries(values)) {
      if (value !== undefined && this.hasCapability(cap)) await this.setCapabilityValue(cap, value);
    }
  }

  /** Repair stores the new login; poll with it. */
  async restartDevice() {
    this.homey.app.panelPoller.register(this);
  }

};
