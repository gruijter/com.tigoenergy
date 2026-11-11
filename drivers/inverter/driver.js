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
const TigoClient = require('../../tigo');
const capture = require('../../lib/tigoCapture');

module.exports = class MyDriver extends Homey.Driver {

  async onInit() {
    this.log('System driver has been initialized');
  }

  async onPair(session) {
    let username = '';
    let password = '';
    let info = null;

    session.setHandler('login', async (data) => {
      username = data.username;
      password = data.password;
      try {
        capture.arm('pairing', { force: true });
        this.api = new TigoClient({
          username, password, homey: this.homey, log: (...args) => this.log(...args),
        });
        await this.api.login();
        info = await this.api.getSystems();
        return Promise.resolve(info);
      } catch (error) {
        this.error(error);
        return Promise.reject(error);
      }
    });

    session.setHandler('list_devices', async () => {
      if (!info || !info.systems) throw Error(this.homey.__('errors.noSystem'));
      const { systems } = info;
      const devices = systems.map((system) => {
        return {
          name: system.name,
          data: {
            id: system.system_id,
          },
          capabilities: [...this.manifest.capabilities],
          settings: {
            username,
            password,
            systemId: `${system.system_id}`,
            systemName: system.name,
            systemSize: `${system.power_rating}`,
          },
        };
      });
      return Promise.all(devices);
    });
  }

  /** New login for a paired system, without pairing again. */
  async onRepair(session, device) {
    session.setHandler('login', async ({ username, password }) => {
      try {
        capture.arm('repair', { force: true });
        const api = new TigoClient({
          username, password, homey: this.homey, log: (...args) => this.log(...args),
        });
        await api.login();
        const { systems } = await api.getSystems();
        const { systemId } = device.getSettings();
        if (!(systems || []).some((system) => String(system.system_id) === String(systemId))) {
          throw Error(this.homey.__('errors.systemNotOnAccount'));
        }
        this.log(`Repair: new login for ${device.getName()}`);
        await device.setSettings({ username, password });
        device.restartDevice(1000).catch((error) => this.error(error));
        return true;
      } catch (error) {
        this.error(error);
        throw error;
      }
    });
  }

};
