# TicketRush - Guia de ejecucion y pruebas

## Estructura

```text
src/server.js             API Express, estado memory/redis y estadisticas CPU
src/cpu-task.js           generarComprobante(seed, iteraciones)
src/worker.js             Worker Thread que ejecuta la tarea CPU
src/worker-limiter.js     WorkerLimiter y cola FIFO
Dockerfile                node:22-alpine
k8s/app.yaml              Deployment y Service ticketrush
k8s/redis.yaml            Deployment y Service redis
k6/test1.js               consistencia: 100 VUs, 1 reserva por VU
k6/test3.js               ping + carga CPU
k6/test8.js               ping + 100 reservas
```

## Variables

| Variable | Valores | Por defecto |
|---|---|---|
| `PORT` | entero | `3000` |
| `STATE_MODE` | `memory`, `redis` | `redis` |
| `USE_MUTEX` | `true`, `false` | `true` (solo con `memory`) |
| `REDIS_URL` | URL de Redis | `redis://redis:6379` |
| `CPU_MODE` | `MAIN`, `WORKER` | `MAIN` |
| `CPU_ITERATIONS` | entero | `1000000` |
| `MAX_WORKERS` | entero | `2` |

`TOTAL` es constante y vale `20`. `POD` se toma de `POD_NAME` o del hostname.

## Endpoints

- `GET /ping` -> `200 { pong: true, pod }`
- `GET /status` -> `200 { total, available, approved, rejected, pod, cpu }`
- `POST /reset` -> `200 { ok: true, pod, total, available, approved, rejected, cpu }`
- `POST /reserve` -> `201 { ok: true, pod, remaining }` o `409 { ok: false, pod, remaining }`

`cpu` contiene `{ mode, maxWorkers, active, queued, maxActive, completed, totalMs }`.

## Instalacion

```powershell
Set-Location "C:\Users\USER\OneDrive\Documentos\7mo\Distribuidas\Taller"
npm install
```

## 1. Memory con Mutex

Terminal 1:

```powershell
$env:PORT = "3000"
$env:STATE_MODE = "memory"
$env:USE_MUTEX = "true"
$env:CPU_MODE = "WORKER"
$env:CPU_ITERATIONS = "1000"
$env:MAX_WORKERS = "2"
npm start
```

Terminal 2:

```powershell
k6 run -e BASE_URL=http://127.0.0.1:3000 k6/test1.js
Invoke-RestMethod http://127.0.0.1:3000/status | ConvertTo-Json -Depth 8
```

Resultado esperado: `20` aprobadas, `80` rechazadas, `available = 0`.

`CPU_ITERATIONS=1000` se usa aqui para aislar la prueba de consistencia y que las tareas CPU no alarguen la corrida. En la configuracion normal el valor por defecto es `1000000`.

## 2. Memory sin Mutex

Detener el servidor anterior y levantarlo con:

```powershell
$env:STATE_MODE = "memory"
$env:USE_MUTEX = "false"
$env:CPU_MODE = "WORKER"
$env:CPU_ITERATIONS = "1000"
npm start
```

Ejecutar de nuevo:

```powershell
k6 run -e BASE_URL=http://127.0.0.1:3000 k6/test1.js
Invoke-RestMethod http://127.0.0.1:3000/status | ConvertTo-Json -Depth 8
```

Resultado esperado: mas de `20` aprobadas y `available` negativo. Es la condicion de carrera producida por el `sleep(5)` entre verificar y descontar.

## 3. Redis

Levantar Redis local:

```powershell
docker run -d --name ticketrush-redis-test -p 6379:6379 redis:7-alpine
docker exec ticketrush-redis-test redis-cli ping
```

Terminal 1:

```powershell
$env:PORT = "3000"
$env:STATE_MODE = "redis"
$env:REDIS_URL = "redis://127.0.0.1:6379"
$env:CPU_MODE = "WORKER"
$env:CPU_ITERATIONS = "1000"
$env:MAX_WORKERS = "2"
npm start
```

Terminal 2:

```powershell
k6 run -e BASE_URL=http://127.0.0.1:3000 k6/test1.js
Invoke-RestMethod http://127.0.0.1:3000/status | ConvertTo-Json -Depth 8
docker exec ticketrush-redis-test redis-cli MGET tickets:available tickets:approved tickets:rejected
```

Resultado esperado: `20` aprobadas, `80` rechazadas, `available = 0`, y `available` nunca negativo. El script Lua `reservar` realiza la verificacion y el descuento de forma atomica.

## 4. Prueba de ping con carga CPU

Con el servidor levantado, ejecutar dos corridas independientes cambiando solo `CPU_MODE`.

Modo MAIN:

```powershell
$env:CPU_MODE = "MAIN"
npm start
```

Modo WORKER:

```powershell
$env:CPU_MODE = "WORKER"
$env:MAX_WORKERS = "2"
npm start
```

En otra terminal, en cada corrida:

```powershell
k6 run -e BASE_URL=http://127.0.0.1:3000 k6/test3.js
```

`test3.js` mantiene 20 VUs de `GET /ping` durante 30 s y, a los 5 s, ejecuta `/reset` seguido de 20 reservas para generar trabajo CPU. En modo MAIN el ping queda bloqueado; en modo WORKER el Main Thread sigue respondiendo.

## 5. Prueba integrada

`test8.js` no hace reset automatico. Antes de ejecutarlo:

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:3000/reset `
  -ContentType 'application/json' `
  -Body '{}'
```

Luego:

```powershell
k6 run -e BASE_URL=http://127.0.0.1:3000 k6/test8.js
```

Combina 20 VUs de ping durante 30 s con 100 VUs que hacen una reserva cada una a partir del segundo 5. Con Redis y Workers debe mantener `approved <= 20`, `available >= 0` y el ping disponible.

## 6. Kubernetes

Construir la imagen:

```powershell
docker build -t ticketrush:1.0 .
```

Desplegar Redis y la aplicacion:

```powershell
kubectl apply -f k8s/redis.yaml
kubectl apply -f k8s/app.yaml
kubectl get pods -l app=ticketrush
kubectl get svc ticketrush
```

La aplicacion queda en el NodePort `30080`:

```powershell
Invoke-RestMethod http://127.0.0.1:30080/ping
```

El manifiesto usa `STATE_MODE=redis`, `USE_MUTEX=true`, `CPU_MODE=WORKER`, `CPU_ITERATIONS=1000000` y `MAX_WORKERS=2`. Para cambiar el modo CPU o el limite:

```powershell
kubectl set env deployment/ticketrush CPU_MODE=MAIN
kubectl set env deployment/ticketrush MAX_WORKERS=4
kubectl rollout status deployment/ticketrush
```

Si el puerto `30080` esta ocupado, cambiarlo en `k8s/app.yaml` y volver a aplicar el manifiesto.

## 7. Resultados de verificacion

Con `CPU_MODE=WORKER`, `CPU_ITERATIONS=1000` y `MAX_WORKERS=2`:

| Caso | Aprobadas | Rechazadas | Available | Observacion |
|---|---:|---:|---:|---|
| Memory + Mutex | 20 | 80 | 0 | Consistente |
| Memory sin Mutex | 79 | 21 | -59 | Condicion de carrera |
| Redis | 20 | 80 | 0 | `available` nunca negativo; maximo `approved = 20` |

En Redis, el monitor de `/status` obtuvo `MinAvailable = 0` y `MaxApproved = 20`. Las claves finales fueron:

```text
tickets:available = 0
tickets:approved  = 20
tickets:rejected  = 80
```

## 8. Limpieza

```powershell
docker rm -f ticketrush-redis-test
kubectl delete -f k8s/app.yaml
kubectl delete -f k8s/redis.yaml
```
