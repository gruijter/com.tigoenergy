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
const capture = require('./lib/tigoCapture');

// API host
const defaultHost = 'api2.tigoenergy.com';
const defaultPort = 443;
const defaultTimeout = 20000;
// Used when a 429 carries no Retry-After; our own choice.
const RATE_LIMIT_COOLDOWN = 5 * 60 * 1000;

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
    this.homey = options.homey;
    this.log = options.log;
    this.rateLimitedUntil = 0;
  }

  /** The locale text of `key`; `fallback` without Homey (plain node). */
  translate(key, fallback) {
    const text = this.homey && this.homey.__ ? this.homey.__(key) : null;
    return text && text !== key ? text : fallback;
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

  /** A request; during a rate-limit cooldown none is sent, after a 401 it logs in again once. */
  async _makeRequest(actionPath, data, timeout, method) {
    if (Date.now() < this.rateLimitedUntil) throw this._error(this.translate('errors.rateLimit', 'Too many requests'), 429);
    try {
      return await this._request(actionPath, data, timeout, method);
    } catch (error) {
      if (error.statusCode === 429) {
        const retryAfter = Number(error.retryAfter) * 1000;
        this.rateLimitedUntil = Date.now() + (retryAfter > 0 ? retryAfter : RATE_LIMIT_COOLDOWN);
      }
      if (error.statusCode !== 401 || actionPath === loginEP || !this.password) throw error;
      await this.login();
      return this._request(actionPath, data, timeout, method);
    }
  }

  _error(message, statusCode, retryAfter) {
    const error = Error(message);
    error.statusCode = statusCode;
    if (retryAfter !== undefined) error.retryAfter = retryAfter;
    return error;
  }

  async _request(actionPath, data, timeout, method) {
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
      if (result.statusCode === 429) throw this._error(this.translate('errors.rateLimit', 'Too many requests'), 429, result.headers['retry-after']);
      if (result.statusCode !== 200) {
        if (result.body && result.body.includes('"message":')) {
          const errorMsg = JSON.parse(result.body);
          let msg = errorMsg.name;
          if (!msg) msg = errorMsg.messages ? errorMsg.messages[0].message : errorMsg.message;
          throw this._error(msg, result.statusCode);
        }
        throw this._error(`${this.translate('errors.httpFailed', 'HTTP request failed')}. ${this.lastResponse}`, result.statusCode);
      }
      if (!/application\/json/.test(contentType)) {
        throw Error(`Expected JSON but received ${contentType}: ${result.body}`);
      }
      const payload = JSON.parse(result.body);
      // logs the raw response only while a capture is armed (lib/tigoCapture.js)
      capture.record(actionPath, payload, this.log);
      return Promise.resolve(payload);
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
