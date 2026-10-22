import crypto from 'node:crypto';
import os from 'node:os';
import express from 'express';
import { Mutex } from 'async-mutex';
import Redis from 'ioredis';
import { generarComprobante } from './cpu-task.js';
import { limiter } from './worker-limiter.js';

const TOTAL = 20;
const POD = process.env.POD_NAME ?? os.hostname();
const PORT = Number(process.env.PORT ?? 3000);
const STATE_MODE = String(process.env.STATE_MODE ?? 'redis').toLowerCase();
const USE_MUTEX = String(process.env.USE_MUTEX ?? 'true').toLowerCase() === 'true';
const CPU_MODE = String(process.env.CPU_MODE ?? 'MAIN').toUpperCase();
const CPU_ITERATIONS = Number(process.env.CPU_ITERATIONS ?? 1_000_000);
const MAX_WORKERS = Number(process.env.MAX_WORKERS ?? 2);
const REDIS_URL = process.env.REDIS_URL ?? 'redis://redis:6379';

if (!['memory', 'redis'].includes(STATE_MODE)) {
  throw new Error(`STATE_MODE invalido: ${STATE_MODE}`);
}

if (!['MAIN', 'WORKER'].includes(CPU_MODE)) {
  throw new Error(`CPU_MODE invalido: ${CPU_MODE}`);
}

const KEYS = {
  available: 'tickets:available',
  approved: 'tickets:approved',
  rejected: 'tickets:rejected',
};

const LUA_RESERVAR = `
local disponible = tonumber(redis.call('GET', KEYS[1]) or '0')
if disponible > 0 then
  redis.call('DECR', KEYS[1])
  redis.call('INCR', KEYS[2])
  return 1
end
redis.call('INCR', KEYS[3])
return 0
`;

const estadoMemoria = {
  available: TOTAL,
  approved: 0,
  rejected: 0,
};

const mutex = new Mutex();

const redis = STATE_MODE === 'redis' ? new Redis(REDIS_URL) : null;

if (redis) {
  redis.defineCommand('reservar', {
    numberOfKeys: 3,
    lua: LUA_RESERVAR,
  });
}

let cpuCompleted = 0;
let cpuFirstStart = null;
let cpuLastEnd = null;
let cpuTotalMs = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function inicializarEstado() {
  if (STATE_MODE === 'memory') {
    return;
  }

  await redis.setnx(KEYS.available, TOTAL);
  await redis.setnx(KEYS.approved, 0);
  await redis.setnx(KEYS.rejected, 0);
}

async function obtenerEstado() {
  if (STATE_MODE === 'memory') {
    return {
      total: TOTAL,
      available: estadoMemoria.available,
      approved: estadoMemoria.approved,
      rejected: estadoMemoria.rejected,
    };
  }

  const [available, approved, rejected] = await redis.mget(
    KEYS.available,
    KEYS.approved,
    KEYS.rejected
  );

  return {
    total: TOTAL,
    available: Number(available ?? 0),
    approved: Number(approved ?? 0),
    rejected: Number(rejected ?? 0),
  };
}

async function reservarEnMemoria() {
  const ejecutar = async () => {
    if (estadoMemoria.available <= 0) {
      estadoMemoria.rejected += 1;
      return { approved: false, remaining: estadoMemoria.available };
    }

    await sleep(5);
    estadoMemoria.available -= 1;
    estadoMemoria.approved += 1;

    return { approved: true, remaining: estadoMemoria.available };
  };

  if (!USE_MUTEX) {
    return ejecutar();
  }

  const release = await mutex.acquire();

  try {
    return await ejecutar();
  } finally {
    release();
  }
}

async function reservarEnRedis() {
  const aprobada = await redis.reservar(
    KEYS.available,
    KEYS.approved,
    KEYS.rejected
  );

  if (Number(aprobada) === 1) {
    const remaining = Number((await redis.get(KEYS.available)) ?? 0);
    return { approved: true, remaining };
  }

  return { approved: false, remaining: 0 };
}

async function resetEstado() {
  if (STATE_MODE === 'memory') {
    const aplicarReset = () => {
      estadoMemoria.available = TOTAL;
      estadoMemoria.approved = 0;
      estadoMemoria.rejected = 0;
    };

    if (!USE_MUTEX) {
      aplicarReset();
      return;
    }

    const release = await mutex.acquire();

    try {
      aplicarReset();
    } finally {
      release();
    }

    return;
  }

  await redis.mset(KEYS.available, TOTAL, KEYS.approved, 0, KEYS.rejected, 0);
}

function registrarInicio() {
  if (cpuFirstStart === null) {
    cpuFirstStart = Date.now();
  }
}

function registrarFin() {
  cpuCompleted += 1;
  cpuLastEnd = Date.now();

  if (cpuFirstStart !== null) {
    cpuTotalMs = cpuLastEnd - cpuFirstStart;
  }
}

function resetCpuStats() {
  cpuCompleted = 0;
  cpuFirstStart = null;
  cpuLastEnd = null;
  cpuTotalMs = 0;
}

function estadoCpu() {
  const usaWorkers = CPU_MODE === 'WORKER';

  return {
    mode: CPU_MODE,
    maxWorkers: MAX_WORKERS,
    active: usaWorkers ? limiter.active : 0,
    queued: usaWorkers ? limiter.queue.length : 0,
    maxActive: usaWorkers ? limiter.maxActive : 0,
    completed: cpuCompleted,
    totalMs: cpuTotalMs,
  };
}

function procesarReserva(seed) {
  registrarInicio();

  if (CPU_MODE === 'WORKER') {
    return limiter.run({ seed, iteraciones: CPU_ITERATIONS });
  }

  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try {
        resolve(generarComprobante(seed, CPU_ITERATIONS));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function lanzarProcesamiento() {
  procesarReserva(crypto.randomUUID())
    .then(registrarFin)
    .catch((error) => {
      console.error(`[cpu] ${error.stack ?? error.message}`);
    });
}

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

app.get('/ping', (req, res) => {
  res.status(200).json({ pong: true, pod: POD });
});

app.get('/status', async (req, res, next) => {
  try {
    const estado = await obtenerEstado();

    res.status(200).json({
      total: estado.total,
      available: estado.available,
      approved: estado.approved,
      rejected: estado.rejected,
      pod: POD,
      cpu: estadoCpu(),
    });
  } catch (error) {
    next(error);
  }
});

app.post('/reset', async (req, res, next) => {
  try {
    await resetEstado();
    resetCpuStats();
    const estado = await obtenerEstado();

    res.status(200).json({
      ok: true,
      pod: POD,
      ...estado,
      cpu: estadoCpu(),
    });
  } catch (error) {
    next(error);
  }
});

app.post('/reserve', async (req, res, next) => {
  try {
    const resultado =
      STATE_MODE === 'redis' ? await reservarEnRedis() : await reservarEnMemoria();

    if (!resultado.approved) {
      res.status(409).json({
        ok: false,
        pod: POD,
        remaining: resultado.remaining,
      });
      return;
    }

    lanzarProcesamiento();

    res.status(201).json({
      ok: true,
      pod: POD,
      remaining: resultado.remaining,
    });
  } catch (error) {
    next(error);
  }
});

app.use((req, res) => {
  res.status(404).json({ ok: false, pod: POD, error: 'not_found' });
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  res.status(500).json({
    ok: false,
    pod: POD,
    error: error.message || 'internal_error',
  });
});

async function main() {
  await inicializarEstado();

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(
      JSON.stringify({
        event: 'listening',
        pod: POD,
        port: PORT,
        stateMode: STATE_MODE,
        useMutex: USE_MUTEX,
        cpuMode: CPU_MODE,
        cpuIterations: CPU_ITERATIONS,
        maxWorkers: MAX_WORKERS,
        redisUrl: STATE_MODE === 'redis' ? REDIS_URL : null,
      })
    );
  });

  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(JSON.stringify({ event: 'shutdown', signal, pod: POD }));

    server.close(async () => {
      if (redis) {
        await redis.quit();
      }

      process.exit(0);
    });

    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error(`[startup] ${error.stack ?? error.message}`);
  process.exit(1);
});
