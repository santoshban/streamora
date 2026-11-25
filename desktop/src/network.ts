import net from 'node:net';
import os from 'node:os';

function accepts(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function canListen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/**
 * The first free port from `preferred` upwards. Connecting comes first because
 * Windows lets a program listen on 127.0.0.1 while another one already listens
 * on all interfaces, which would silently take over its local traffic.
 */
export async function findFreePort(preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + 50 && port <= 65535; port += 1) {
    if ((await accepts('127.0.0.1', port)) || (await accepts('::1', port))) continue;
    if (await canListen('127.0.0.1', port)) return port;
  }
  throw new Error(`No free port between ${preferred} and ${preferred + 49}`);
}

/** Addresses other devices can use, leaving out virtual adapters. */
export function lanAddresses(): string[] {
  const found: string[] = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    if (/vethernet|wsl|virtualbox|vmware|hyper-v|loopback|docker/i.test(name)) continue;
    for (const a of addresses ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) found.push(a.address);
    }
  }
  return found;
}
