import http from 'k6/http';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL ?? 'http://localhost:3000';

const reservasAprobadas = new Counter('reservas_aprobadas');
const reservasRechazadas = new Counter('reservas_rechazadas');

http.setResponseCallback(http.expectedStatuses(201, 409));

export const options = {
  scenarios: {
    reservas: {
      executor: 'per-vu-iterations',
      vus: 100,
      iterations: 1,
      maxDuration: '1m',
    },
  },
};

export function setup() {
  const response = http.post(
    `${BASE_URL}/reset`,
    JSON.stringify({}),
    { headers: { 'Content-Type': 'application/json' } }
  );

  return response.json();
}

export default function () {
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

export function teardown() {
  const response = http.get(`${BASE_URL}/status`);
  console.log(`Estado final: ${response.body}`);
}
