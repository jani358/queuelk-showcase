// From load/morning-rush.js in the private repo. Only change: the demo login comes from env vars.

/**
 * Morning rush (UPGRADE-PLAN 5.1).
 *
 * 300 patients take a token by "scanning the QR" within 60 seconds, while 5
 * counters keep pressing "call next" and "done" on the same queue. Then the
 * teardown reads the queue back and checks the one promise QueueLK makes:
 * numbers 1..N with no gaps and no duplicates, and every patient called at
 * most once.
 *
 * Run against a local API (see docs/LOAD-TEST-REPORT.md for the exact setup):
 *   k6 run -e API=http://localhost:3171/api -e EMAIL=... -e PASSWORD=... morning-rush.js
 *
 * Each patient iteration has its own cookie jar, so each is a new phone with
 * its own device cookie, which is what the per-device rate limit expects.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import exec from 'k6/execution';

const API = __ENV.API || 'http://localhost:3171/api';
const SLUG = __ENV.SLUG || 'sunrise-dispensary';
const EMAIL = __ENV.EMAIL;
const PASSWORD = __ENV.PASSWORD;
const PATIENTS = Number(__ENV.PATIENTS || 300);
const SECONDS = Number(__ENV.SECONDS || 60);
const COUNTERS = Number(__ENV.COUNTERS || 5);

const tokensTaken = new Counter('tokens_taken');
const patientsCalled = new Counter('patients_called');
const doubleCalls = new Counter('double_calls');
const numberingErrors = new Counter('numbering_errors');
const takeTokenMs = new Trend('take_token_ms', true);
const callNextMs = new Trend('call_next_ms', true);

export const options = {
  scenarios: {
    patients: {
      executor: 'constant-arrival-rate',
      exec: 'patient',
      rate: PATIENTS,
      timeUnit: `${SECONDS}s`,
      duration: `${SECONDS}s`,
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
    counters: {
      executor: 'constant-vus',
      exec: 'counter',
      vus: COUNTERS,
      // A little longer than the rush, so the counters keep serving the tail.
      duration: `${SECONDS + 15}s`,
    },
  },
  thresholds: {
    // The plan's target: p95 under 250 ms.
    'http_req_duration{scenario:patients}': ['p(95)<250'],
    'http_req_duration{scenario:counters}': ['p(95)<250'],
    // Every patient got a token, and the invariants held.
    tokens_taken: [`count>=${PATIENTS}`],
    double_calls: ['count==0'],
    numbering_errors: ['count==0'],
    checks: ['rate==1'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const json = { 'Content-Type': 'application/json' };
const authed = (token, extra = {}) => ({ headers: { ...json, Authorization: `Bearer ${token}`, ...extra } });

export function setup() {
  const login = http.post(`${API}/auth/login`, JSON.stringify({ email: EMAIL, password: PASSWORD }), {
    headers: json,
  });
  check(login, { 'owner logged in': (r) => r.status === 200 || r.status === 201 });
  const accessToken = login.json('data.accessToken');

  // A fresh queue per run, so the numbering check starts at 1 and the run
  // never collides with the seeded demo queues. A random prefix can repeat an
  // earlier run's (only 676 exist), so try a few.
  const letter = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
  let prefix;
  let queue;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    prefix = `K${letter()}${letter()}`;
    queue = http.post(
      `${API}/queues`,
      JSON.stringify({ name: `Morning rush ${prefix}`, prefix, avgServiceSeconds: 60 }),
      authed(accessToken),
    );
    if (queue.status !== 409) break;
  }
  check(queue, { 'rush queue created': (r) => r.status === 201 });

  return { accessToken, queueId: queue.json('data.id'), prefix };
}

export function patient(data) {
  // A new phone: a clean cookie jar means a new device cookie.
  const jar = http.cookieJar();
  jar.clear(API.replace(/\/api$/, ''));

  const res = http.post(
    `${API}/public/q/${SLUG}/${data.prefix}/tokens`,
    JSON.stringify({}),
    { headers: { ...json, 'Idempotency-Key': `rush-${exec.scenario.iterationInTest}-${Date.now()}` }, tags: { name: 'take token' } },
  );
  takeTokenMs.add(res.timings.duration);
  if (check(res, { 'token taken': (r) => r.status === 201 })) tokensTaken.add(1);
}

export function counter(data) {
  const call = http.post(`${API}/queues/${data.queueId}/call-next`, null, {
    ...authed(data.accessToken, { 'Idempotency-Key': `call-${__VU}-${__ITER}-${Date.now()}` }),
    tags: { name: 'call next' },
  });
  callNextMs.add(call.timings.duration);
  check(call, { 'call next ok': (r) => r.status === 200 || r.status === 201 });

  const called = call.json('data');
  if (!called || !called.id) {
    // Nobody waiting yet: the counter looks up again in a moment.
    sleep(0.5);
    return;
  }
  patientsCalled.add(1);

  // A consultation, then Done. A 409 here would mean someone else already
  // acted on "our" patient: the double call the queue lock exists to prevent.
  sleep(0.3 + Math.random() * 0.4);
  const done = http.post(`${API}/tokens/${called.id}/done`, null, {
    ...authed(data.accessToken, { 'Idempotency-Key': `done-${called.id}` }),
    tags: { name: 'done' },
  });
  if (done.status === 409) doubleCalls.add(1);
  check(done, { 'done ok': (r) => r.status === 200 || r.status === 201 });
}

export function teardown(data) {
  const res = http.get(`${API}/queues/${data.queueId}/tokens`, authed(data.accessToken));
  const tokens = res.json('data') || [];
  const numbers = tokens.map((t) => t.number).sort((a, b) => a - b);

  const gapFree = numbers.every((n, i) => n === i + 1);
  const unique = new Set(numbers).size === numbers.length;
  const recalled = tokens.filter((t) => t.recallCount > 0).length;

  if (!gapFree || !unique) numberingErrors.add(1);
  check(numbers, {
    [`numbers are exactly 1..${numbers.length}`]: () => gapFree,
    'no duplicate numbers': () => unique,
    'nobody was called twice (no recalls)': () => recalled === 0,
  });

  console.log(
    `queue ${data.prefix}: ${numbers.length} tokens, last ${numbers[numbers.length - 1]}, ` +
      `done ${tokens.filter((t) => t.status === 'DONE').length}, ` +
      `still waiting ${tokens.filter((t) => t.status === 'WAITING').length}`,
  );
}
