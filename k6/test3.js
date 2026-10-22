import http from 'k6/http';
import { sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL ?? 'http://localhost:3000';

http.setResponseCallback(http.expectedStatuses(200, 201, 409));

export const options = {
  scenarios: {
    ping: {
      executor: 'constant-vus',
      vus: 20,
      duration: '30s',
      exec: 'ping',
    },
    carga_cpu: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      startTime: '5s',
      exec: 'cargaCpu',
    },
  },
  thresholds: {
    'http_req_duration{scenario:ping}': ['p(95)<30000'],
    'http_req_failed{scenario:ping}': ['rate<0.01'],
    'http_reqs{scenario:ping}': ['count>0'],
  },
};

export function ping() {
  http.get(`${BASE_URL}/ping`);
  sleep(0.25);
}

export function cargaCpu() {
  const headers = { 'Content-Type': 'application/json' };

  http.post(`${BASE_URL}/reset`, JSON.stringify({}), { headers });

  for (let i = 0; i < 20; i += 1) {
    http.post(`${BASE_URL}/reserve`, JSON.stringify({}), { headers });
  }
}
