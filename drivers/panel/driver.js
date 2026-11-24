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

// onRepair (new login, system must be on the account) and the pair login are the inverter's
const InverterDriver = require('../inverter/driver');

const { panelsOf } = require('../../lib/tigoReadings');

module.exports = class PanelDriver extends InverterDriver {

  async onInit() {
    this.homey.flow.getConditionCard('alarm_underperforming_panel_is')
      .registerRunListener(({ device }) => device.getCapabilityValue('alarm_underperforming_panel') === true);
    this.log('Panel driver has been initialized');
  }

  /** Both APIs: the official one takes the temperature from the app's API (lib/panelPoller.js). */
  capabilityList() {
    return [...this.manifest.capabilities];
  }

  async onPair(session) {
    const found = this.pairLogin(session, 'pairing panels');
    session.setHandler('list_devices', async () => {
      const {
        username, password, source, api, systems,
      } = found() || {};
      if (!systems || !systems.length) throw Error(this.homey.__('errors.noSystem'));
      const devices = [];
      for (const system of systems) {
        const panels = panelsOf(await api.getLayout({ id: system.id }));
        for (const panel of panels) {
          devices.push({
            name: systems.length > 1 ? `${system.name} ${panel.label}` : `${panel.label}`,
            // the app's layout has no panel_id in its third-party client's fixture
            data: { id: panel.panel_id !== undefined ? panel.panel_id : panel.object_id },
            capabilities: this.capabilityList(source),
            store: {
              objectId: panel.object_id, timezone: system.timezone, apiSource: source, apiSystemId: `${system.id}`,
            },
            settings: {
              username,
              password,
              systemId: `${system.id}`,
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
