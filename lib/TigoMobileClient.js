/*
Copyright 2026, Robin de Gruijter (rmdegruijter@gmail.com)

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

/*
The Tigo app's own API (mapi.tigoenergy.com), for accounts without EI Premium. Unofficial: endpoints
and headers from JeremyWhittaker/tigo_home_assistant (Apache-2.0), not verified live.
*/

const TigoClient = require('../tigo');

const loginEP = '/api/v3/user/login';

class TigoMobileClient extends TigoClient {

  constructor(opts) {
    super(opts);
    this.host = 'mapi.tigoenergy.com';
    this.loginPath = loginEP;
    this.source = 'mobile';
  }

  _headers(actionPath) {
    const headers = {
      Accept: 'application/json',
      Origin: 'capacitor://localhost',
      'X-App-Version': '5.4.7-04',
    };
    if (actionPath.split('?')[0] === loginEP) headers['Content-Type'] = 'application/json';
    else headers.Authorization = `Bearer ${this.bearerToken}`;
    return headers;
  }

  async login(opts = {}) {
    this.username = opts.username || this.username;
    this.password = opts.password || this.password;
    const res = await this._makeRequest(`${loginEP}?type=8`, { username: this.username, password: this.password });
    const root = (res && res.data) || res || {};
    const user = root.user || root;
    if (!user.auth) {
      // the shape is from a third-party client; show the real one (keys and types only)
      const shape = (value) => (value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item)])) : typeof value);
      if (this.log) this.log('Tigo app login without token, answer shape:', JSON.stringify(shape(res)));
      throw this._error(this.translate('errors.noData', 'No data received from Tigo'));
    }
    this.user = user;
    this.bearerToken = user.auth;
    return res;
  }

  async logout() {
    this.bearerToken = null;
  }

  /** `{ systems: [{ id, name, timezone }] }`: `id`, not `system_id`. */
  async getSystems() {
    return this._makeRequest('/api/v3/systems/query?limit=100&page=1&sort=-id');
  }

  /** `{ energyProduction: { now, day, week, month, year, lifetime }, minLastTime }` */
  async getHomepage({ id }) {
    return this._makeRequest(`/api/v4/smart/systems/${encodeURIComponent(id)}/homepage`);
  }

  /** Equipment list; the gateway (CCA) item's `equipmentSerial` is the uid of getPanelPower. */
  async getEquipments({ id }) {
    return this._makeRequest(`/api/v4/equipments?${new URLSearchParams({ systemId: id })}`);
  }

  /** Power per panel for one day: `{ lastData, dataset: [{ order: [object ids], data: [{ t, d: [W | '-'] }] }] }` */
  async getPanelPower({ id, date, uid }) {
    return this.getPanelSeries({
      id, date, uid, temp: 'pin',
    });
  }

  /** The same for `temp` vin (V), iin (A), rssi, temp (°C), vout (V), pwm or reclaimedPower (W) (seen live by M. Stranik's Tigo app). */
  async getPanelSeries({
    id, date, uid, temp,
  }) {
    const query = new URLSearchParams({
      system_id: id, date, temp, uid, resourceId: `data-${date}-${temp}-${uid}`,
    });
    return this._makeRequest(`/api/v4/system/summary/summary?${query}`);
  }

  /**
   * The newest status events per equipment (shape from M. Stranik's Tigo app, not seen by us):
   * `[{ equipmentSerial, equipmentType, equipmentStatusesLatest: [{ statusTime, createdTime, statusType, statusCode: 0 ok | 1 warning | 2 error }] }]`
   */
  async getEquipmentStatus({ id }) {
    return this._makeRequest(`/api/v4/equipment-status/latest?${new URLSearchParams({ systemId: id })}`);
  }

  /** The titles of the status types: `[{ type, title }]` (same source). */
  async getEventTypes({ id }) {
    return this._makeRequest(`/api/v4/equipment-event-types?${new URLSearchParams({ systemId: id })}`);
  }

  /** Energy per panel for one day: `{ dataset: { <object id>: Wh }, datasetLastData }` */
  async getPanelEnergy({ id, date }) {
    const query = new URLSearchParams({
      system_id: id, date, temp: 'energy', resourceId: `data-${date}-energy`,
    });
    return this._makeRequest(`/api/v4/system/summary/aggenergy?${query}`);
  }

}

module.exports = TigoMobileClient;
