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
    const error = await failure(client.getStatus({ id: 1 }));
    t.eq(error && error.message, message, msg);
  }

  fixtures.routeHttps({ '/api/v3/data/summary': { status: 200, body: 'Datetime,1\n', contentType: 'text/csv' } });
  const csv = await failure(client.getStatus({ id: 1 }));
  t.ok(csv && /Expected JSON/.test(csv.message), 'a non-JSON answer is an error, not data');
};
