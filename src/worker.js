import { parentPort, workerData } from 'node:worker_threads';
import { generarComprobante } from './cpu-task.js';

const { seed, iteraciones } = workerData;
const resultado = generarComprobante(seed, iteraciones);

parentPort.postMessage(resultado);
