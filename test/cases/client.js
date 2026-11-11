'use strict';

/*
TigoClient against the responses Tigo really sends: token handling and the error bodies seen live.
*/

const fixtures = require('../fixtures');

const failure = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
};

module.exports = async (t) => {
  const calls = fixtures.routeHttps();
  const client = fixtures.makeClient();
  await client.login();
  t.eq(client.bearerToken, fixtures.get('login').user.auth, 'login stores user.auth as the bearer token');
  t.eq(calls[0].headers.Authorization, `Basic ${Buffer.from('user@example.invalid:secret').toString('base64')}`, 'login sends Basic auth');

  await client.getStatus({ id: 1 });
  t.eq(calls[1].path, '/api/v3/data/summary?system_id=1', 'getStatus asks data/summary for the system');
  t.eq(calls[1].headers.Authorization, `Bearer ${client.bearerToken}`, 'and sends the bearer token');

  const cases = [
    ['premium', 'Payment Required', 'Premium required (402) is raised with its name'],
    ['dataPremium', 'Internal server error', 'the 402 of the data endpoints is raised with its message'],
    ['unauthorized', 'Unauthorized', 'an expired token (401) is raised'],
    ['rateLimited', 'Too many requests', '429 is raised as the rate-limit error'],
  ];
  for (const [name, message, msg] of cases) {
    fixtures.routeHttps({ '/api/v3/data/summary': fixtures.errors[name] });
    client.rateLimitedUntil = 0;
    const error = await failure(client.getStatus({ id: 1 }));
    t.eq(error && error.message, message, msg);
  }

  client.rateLimitedUntil = 0;
  fixtures.routeHttps({ '/api/v3/data/summary': { status: 200, body: 'Datetime,1\n', contentType: 'text/csv' } });
  const csv = await failure(client.getStatus({ id: 1 }));
  t.ok(csv && /Expected JSON/.test(csv.message), 'a non-JSON answer is an error, not data');

  // 429: a cooldown in which nothing is sent; Retry-After decides its length when present
  const limited = fixtures.routeHttps({ '/api/v3/data/summary': fixtures.errors.rateLimited });
  const paced = fixtures.makeClient();
  await paced.login();
  const first = await failure(paced.getStatus({ id: 1 }));
  t.eq(first && first.statusCode, 429, 'a 429 is raised with its status');
  const sent = limited.length;
  const second = await failure(paced.getStatus({ id: 1 }));
  t.eq(limited.length, sent, 'during the cooldown no request is sent');
  t.eq(second && second.statusCode, 429, 'and the call fails as rate limited');
  const left = paced.rateLimitedUntil - Date.now();
  t.ok(left > 4 * 60 * 1000 && left <= 5 * 60 * 1000, 'without Retry-After the cooldown is 5 minutes');
  fixtures.routeHttps({ '/api/v3/data/summary': fixtures.errors.rateLimited });
  const TigoClient = fixtures.app('tigo.js');
  const original = TigoClient.prototype._makeHttpsRequest;
  TigoClient.prototype._makeHttpsRequest = async function withHeader(options) {
    const result = await original.call(this, options);
    if (result.statusCode === 429) result.headers['retry-after'] = '30';
    return result;
  };
  const header = fixtures.makeClient();
  await header.login();
  await failure(header.getStatus({ id: 1 }));
  const wait = header.rateLimitedUntil - Date.now();
  t.ok(wait > 25 * 1000 && wait <= 30 * 1000, 'Retry-After: 30 gives a 30 s cooldown');

  // 401 on an expired token: log in again once and retry
  let expired = true;
  const relogin = fixtures.routeHttps({
    '/api/v3/data/summary': () => {
      if (!expired) return 'summary';
      expired = false;
      return fixtures.errors.unauthorized;
    },
  });
  const stale = fixtures.makeClient();
  await stale.login();
  const status = await stale.getStatus({ id: 1 });
  t.ok(status && status.summary, 'after a 401 the call succeeds on a new token');
  t.eq(relogin.map((c) => c.path.replace(/\?.*$/, '')).join(','), '/api/v3/users/login,/api/v3/data/summary,/api/v3/users/login,/api/v3/data/summary',
    'by logging in once more and retrying once');
  const alwaysDenied = fixtures.routeHttps({ '/api/v3/data/summary': fixtures.errors.unauthorized });
  const denied = fixtures.makeClient();
  await denied.login();
  const deniedError = await failure(denied.getStatus({ id: 1 }));
  t.eq(deniedError && deniedError.statusCode, 401, 'a second 401 is raised');
  t.eq(alwaysDenied.length, 4, 'and not retried again');
};
