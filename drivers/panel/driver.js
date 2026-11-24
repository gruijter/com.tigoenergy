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

const TigoClient = require('../../tigo');
const capture = require('../../lib/tigoCapture');
// onRepair (new login, system must be on the account) is the inverter's
const InverterDriver = require('../inverter/driver');

/** The panels of a systems/layout answer, with their string. */
function panelsOf(layout) {
  const panels = [];
  const system = (layout && layout.system) || {};
  for (const inverter of system.inverters || []) {
    for (const mppt of inverter.mppts || []) {
      for (const string of mppt.strings || []) {
        for (const panel of string.panels || []) panels.push({ ...panel, string: string.label });
      }
    }
  }
  return panels;
}

module.exports = class PanelDriver extends InverterDriver {

  async onInit() {
    // a condition card never runs by itself (skill §17)
    this.homey.flow.getConditionCard('alarm_underperforming_panel_is')
      .registerRunListener(({ device }) => device.getCapabilityValue('alarm_underperforming_panel') === true);
    this.log('Panel driver has been initialized');
  }

  async onPair(session) {
    let username = '';
    let password = '';
    let api = null;
    let systems = [];

    session.setHandler('login', async (data) => {
      ({ username, password } = data);
      try {
        capture.arm('pairing panels', { force: true });
        api = new TigoClient({
          username, password, homey: this.homey, log: (...args) => this.log(...args),
        });
        await api.login();
        ({ systems = [] } = await api.getSystems());
        return true;
      } catch (error) {
        this.error(error);
        throw error;
      }
    });

    session.setHandler('list_devices', async () => {
      if (!systems.length) throw Error(this.homey.__('errors.noSystem'));
      const devices = [];
      for (const system of systems) {
        const panels = panelsOf(await api.getLayout({ id: system.system_id }));
        for (const panel of panels) {
          devices.push({
            name: systems.length > 1 ? `${system.name} ${panel.label}` : `${panel.label}`,
            data: { id: panel.panel_id },
            capabilities: [...this.manifest.capabilities],
            store: { objectId: panel.object_id, timezone: system.timezone },
            settings: {
              username,
              password,
              systemId: `${system.system_id}`,
              systemName: `${system.name}`,
              label: `${panel.label}`,
              string: `${panel.string || ''}`,
              serial: `${panel.serial || ''}`,
              type: `${panel.type || ''}`,
            },
          });
        }
      }
      return devices;
    });
  }

};

module.exports.panelsOf = panelsOf;
