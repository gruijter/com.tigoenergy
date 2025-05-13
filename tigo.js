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

const https = require('https');

// API host
const defaultHost = 'api2.tigoenergy.com';
const defaultPort = 443;
const defaultTimeout = 20000;

// Endpoints
const loginEP = '/api/v3/users/login';
const logoutEP = '/api/v3/users/logout';
const getSystemsEP = '/api/v3/systems';
const getLayoutEP = '/api/v3/systems/layout';
const getObjectsEP = '/api/v3/objects/system';
const getSourcesEP = '/api/v3/sources/system';
const getStatusEP = '/api/v3/data/summary';

// Represents a session to a Tigo system.
class TigoClient {

  constructor(opts) {
    const options = opts || {};
    this.username = options.username;
    this.password = options.password;
    this.bearerToken = null;
    this.host = defaultHost;
    this.port = defaultPort;
    this.timeout = options.timeout || defaultTimeout;
    this.lastResponse = undefined;
  }

  async login(opts) {
    try {
      const options = opts || {};
      const username = options.username || this.username;
      const password = options.password || this.password;
      this.username = username;
      this.password = password;
      const res = await this._makeRequest(loginEP);
      this.user = res.user;
      this.bearerToken = res.user.auth;
      return Promise.resolve(res);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async logout() {
    try {
      const res = await this._makeRequest(logoutEP);
      this.bearerToken = null;
      return Promise.resolve(res);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async getSystems(opts) {
    try {
      let path = getSystemsEP;
      if (opts && opts.id) path += `/${opts.id}`;
      const res = await this._makeRequest(path);
      return Promise.resolve(res);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async getLayout(opts) {
    try {
      let path = getLayoutEP;
      if (opts && opts.id) path += `?id=${opts.id}`;
      const res = await this._makeRequest(path);
      return Promise.resolve(res);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async getObjects(opts) {
    try {
      let path = getObjectsEP;
      if (opts && opts.id) path += `?system_id=${opts.id}`;
      const res = await this._makeRequest(path);
      return Promise.resolve(res);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async getSources(opts) {
    try {
      let path = getSourcesEP;
      if (opts && opts.id) path += `?system_id=${opts.id}`;
      const res = await this._makeRequest(path);
      return Promise.resolve(res);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async getStatus(opts) {
    try {
      let path = getStatusEP;
      if (opts && opts.id) path += `?system_id=${opts.id}`;
      const res = await this._makeRequest(path);
      return Promise.resolve(res);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async _makeRequest(actionPath, data, timeout, method) {
    try {
      const postData = JSON.stringify(data);
      const headers = { };
      if (actionPath === loginEP) headers.Authorization = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`;
      else headers.Authorization = `Bearer ${this.bearerToken}`;
      const options = {
        hostname: this.host,
        port: this.port,
        path: actionPath,
        headers,
        method: 'GET',
      };
      if (data && data !== '') options.method = 'POST';
      if (method) options.method = method;
      // console.log(options);
      const result = await this._makeHttpsRequest(options, postData, timeout);
      // console.dir(result.body, { depth: null });
      // console.dir(result.headers, { depth: null });
      this.lastResponse = result.body || result.statusCode;
      const contentType = result.headers['content-type'];
      // find errors
      if (result['x-rate-limit-remaining'] <= 0) throw Error('Rate limit exceeded');
      if (result.statusCode !== 200) {
        if (result.body && result.body.includes('"message":')) {
          const errorMsg = JSON.parse(result.body);
          let msg = errorMsg.name;
          if (!msg) msg = errorMsg.messages ? errorMsg.messages[0].message : errorMsg.message;
          throw Error(msg);
        }
        if (result.statusCode === 429) throw Error('Too many requests');
        throw Error(`HTTP request Failed. ${this.lastResponse}`);
      }
      if (!/application\/json/.test(contentType)) {
        throw Error(`Expected JSON but received ${contentType}: ${result.body}`);
      }
      // console.dir(result.body, { depth: null });
      return Promise.resolve(JSON.parse(result.body));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  _makeHttpsRequest(options, postData, timeout) {
    return new Promise((resolve, reject) => {
      const opts = options;
      opts.timeout = timeout || this.timeout;
      const req = https.request(opts, (res) => {
        let resBody = '';
        res.on('data', (chunk) => {
          resBody += chunk;
        });
        res.once('end', () => {
          this.lastResponse = resBody;
          if (!res.complete) {
            return reject(Error('The connection was terminated while the message was still being sent'));
          }
          res.body = resBody;
          return resolve(res);
        });
      });
      req.on('error', (e) => {
        req.destroy();
        this.lastResponse = e;
        return reject(e);
      });
      req.on('timeout', () => {
        req.destroy();
      });
      req.end(postData);
    });
  }

}

module.exports = TigoClient;
