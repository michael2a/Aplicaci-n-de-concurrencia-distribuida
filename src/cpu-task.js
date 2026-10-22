import { createHash } from 'node:crypto';

export function generarComprobante(seed, iteraciones) {
  let digest = String(seed);

  for (let i = 0; i < iteraciones; i += 1) {
    digest = createHash('sha256').update(digest).digest('hex');
  }

  return digest;
}
