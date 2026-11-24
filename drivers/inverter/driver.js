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
const capture = require('../../lib/tigoCapture');
const { connect, findSystem } = require('../../lib/tigoSource');

module.exports = class MyDriver extends Homey.Driver {

  async onInit() {
    this.log('System driver has been initialized');
  }

  /** The capabilities of a device on `source`: the app's API has no alerts. */
  capabilityList(source) {
    const caps = [...this.manifest.capabilities];
    return source === 'mobile' ? caps.filter((cap) => cap !== 'alarm_problem') : caps;
  }

  /** Login handler plus the subscription_notice view's question; `found()` holds the result. */
  pairLogin(session, why) {
    let found = null;
    session.setHandler('login', async ({ username, password }) => {
      try {
        capture.arm(why, { force: true });
        const { source, api, systems } = await connect({
          username, password, homey: this.homey, log: (...args) => this.log(...args),
        });
        this.log(`Pairing: ${systems.length} system(s) via ${source}`);
        capture.recordLogin({
          username, password, systemId: systems.map((system) => system.id).join(','), systemName: systems.map((system) => system.name).join(','), apiSource: source,
        }, (...args) => this.log(...args));
        found = {
          username, password, source, api, systems,
        };
        return true;
      } catch (error) {
        this.error(error);
        throw error;
      }
    });
    session.setHandler('noPremium', async () => Boolean(found && found.source === 'mobile' && found.systems.length));
    return () => found;
  }

  async onPair(session) {
    const found = this.pairLogin(session, 'pairing');
    session.setHandler('list_devices', async () => {
      const {
        username, password, source, systems,
      } = found() || {};
      if (!systems || !systems.length) throw Error(this.homey.__('errors.noSystem'));
      return systems.map((system) => ({
        name: system.name,
        data: { id: system.id },
        capabilities: this.capabilityList(source),
        store: { apiSource: source, apiSystemId: `${system.id}` },
        settings: {
          username,
          password,
          systemId: `${system.id}`,
          systemName: `${system.name}`,
          systemSize: system.powerRating !== undefined ? `${system.powerRating}` : '',
        },
      }));
    });
  }

  /** New login for a paired system, without pairing again; also picks the API anew. */
  async onRepair(session, device) {
    session.setHandler('login', async ({ username, password }) => {
      try {
        capture.arm('repair', { force: true });
        const { source, systems } = await connect({
          username, password, homey: this.homey, log: (...args) => this.log(...args),
        });
        const { systemId, systemName } = device.getSettings();
        const system = findSystem(systems, { ids: [device.getStoreValue('apiSystemId'), systemId], name: systemName });
        if (!system) throw Error(this.homey.__('errors.systemNotOnAccount'));
        this.log(`Repair: new login for ${device.getName()} via ${source}`);
        await device.setSettings({ username, password });
        await device.setStoreValue('apiSource', source);
        await device.setStoreValue('apiSystemId', `${system.id}`);
        device.restartDevice(1000).catch((error) => this.error(error));
        return true;
      } catch (error) {
        this.error(error);
        throw error;
      }
    });
  }

};
