import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A random ID kept in the data folder. Apps use it to tell that two addresses
 * (the home network and a VPN) lead to the same server.
 */
export function resolveServerId(dataDir: string): string {
  const file = path.join(dataDir, '.server-id');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (UUID.test(existing)) return existing;
  } catch {
    // first run
  }
  const id = crypto.randomUUID();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, id);
  return id;
}
