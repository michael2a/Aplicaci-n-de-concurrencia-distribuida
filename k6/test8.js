import http from 'k6/http';
import { sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL ?? 'http://localhost:3000';

const reservasAprobadas = new Counter('reservas_aprobadas');
const reservasRechazadas = new Counter('reservas_rechazadas');

http.setResponseCallback(http.expectedStatuses(200, 201, 409));

export const options = {
  scenarios: {
    ping: {
      executor: 'constant-vus',
      vus: 20,
      duration: '30s',
      exec: 'ping',
    },
    reservas: {
      executor: 'per-vu-iterations',
      vus: 100,
      iterations: 1,
      startTime: '5s',
      maxDuration: '25s',
      exec: 'reservas',
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

export function reservas() {
  const response = http.post(
    `${BASE_URL}/reserve`,
    JSON.stringify({}),
    { headers: { 'Content-Type': 'application/json' } }
  );

  const pod = response.json('pod');

  if (response.status === 201) {
    reservasAprobadas.add(1, { pod });
    return;
  }

  if (response.status === 409) {
    reservasRechazadas.add(1, { pod });
  }
}
