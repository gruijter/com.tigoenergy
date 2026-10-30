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
        this.api = new TigoClient({ username, password, homey: this.homey });
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
          name: system.system_name,
          data: {
            id: system.system_id,
          },
          capabilities: [
            'meter_power',
            'measure_power',
          ],
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

};
