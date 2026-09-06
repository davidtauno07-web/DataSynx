import net from 'node:net';
import { ScanStatus } from '@prisma/client';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

/**
 * Optional ClamAV (INSTREAM) integration. When CLAMAV_HOST is unset the
 * scan is reported as SKIPPED rather than silently claimed to be clean.
 */
export async function scanBuffer(buffer: Buffer): Promise<ScanStatus> {
  if (!env.CLAMAV_HOST) return ScanStatus.SKIPPED;

  return new Promise<ScanStatus>((resolve) => {
    const socket = net.createConnection({ host: env.CLAMAV_HOST as string, port: env.CLAMAV_PORT });
    let response = '';

    socket.setTimeout(30_000, () => {
      socket.destroy();
      resolve(ScanStatus.ERROR);
    });
    socket.on('error', (err) => {
      logger.warn({ err }, 'clamav scan failed');
      resolve(ScanStatus.ERROR);
    });
    socket.on('data', (chunk) => {
      response += chunk.toString();
    });
    socket.on('end', () => {
      if (response.includes('OK') && !response.includes('FOUND')) resolve(ScanStatus.CLEAN);
      else if (response.includes('FOUND')) resolve(ScanStatus.INFECTED);
      else resolve(ScanStatus.ERROR);
    });

    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      const size = Buffer.alloc(4);
      size.writeUInt32BE(buffer.length, 0);
      socket.write(size);
      socket.write(buffer);
      socket.write(Buffer.from([0, 0, 0, 0]));
    });
  });
}
