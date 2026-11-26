import fs from 'node:fs';
import path from 'node:path';
import type { NetworkInterfaceInfo } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { reachableAddresses } from '../src/lib/addresses.js';
import { resolveServerId } from '../src/lib/server-id.js';
import { tempDir } from './helpers/harness.js';

const v4 = (address: string, internal = false): NetworkInterfaceInfo => ({
  address,
  family: 'IPv4',
  internal,
  netmask: '255.255.255.0',
  mac: '00:00:00:00:00:00',
  cidr: `${address}/24`,
});

const interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {
  'Wi-Fi': [v4('192.168.1.20'), { ...v4('fe80::1'), family: 'IPv6', scopeid: 0 }],
  Tailscale: [v4('100.101.102.103')],
  'vEthernet (WSL)': [v4('172.20.0.1')],
  'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)],
  'Ethernet 2': [v4('169.254.10.10')],
  'ZeroTier One [8056c2e21c]': [v4('10.147.17.5')],
  eth1: [v4('203.0.113.5')],
};

describe('reachableAddresses', () => {
  it('lists home-network addresses, then VPN ones, then advertised URLs', () => {
    expect(reachableAddresses(interfaces, '0.0.0.0', 8484, ['https://media.example.com'])).toEqual([
      { url: 'http://192.168.1.20:8484', kind: 'lan' },
      { url: 'http://100.101.102.103:8484', kind: 'vpn' },
      { url: 'http://10.147.17.5:8484', kind: 'vpn' },
      { url: 'https://media.example.com', kind: 'custom' },
    ]);
  });

  it('only lists the address the server is bound to', () => {
    expect(reachableAddresses(interfaces, '192.168.1.20', 8485)).toEqual([{ url: 'http://192.168.1.20:8485', kind: 'lan' }]);
  });

  it('lists no network address when the server only listens locally', () => {
    expect(reachableAddresses(interfaces, '127.0.0.1', 8484, ['http://pc.tail1234.ts.net:8484'])).toEqual([
      { url: 'http://pc.tail1234.ts.net:8484', kind: 'custom' },
    ]);
  });
});

describe('resolveServerId', () => {
  const dir = tempDir();
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('keeps the same ID for a data folder', () => {
    const id = resolveServerId(dir);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(resolveServerId(dir)).toBe(id);
  });

  it('replaces a damaged ID file', () => {
    fs.writeFileSync(path.join(dir, '.server-id'), 'garbage');
    expect(resolveServerId(dir)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('ADVERTISED_URLS', () => {
  it('keeps the origin of each URL', () => {
    const config = loadConfig({ NODE_ENV: 'test', ADVERTISED_URLS: 'http://pc.tail1234.ts.net:8484/, https://media.example.com/watch' });
    expect(config.advertisedUrls).toEqual(['http://pc.tail1234.ts.net:8484', 'https://media.example.com']);
    expect(loadConfig({ NODE_ENV: 'test' }).advertisedUrls).toEqual([]);
  });

  it('rejects anything but http(s) URLs', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', ADVERTISED_URLS: 'ftp://nas.local' })).toThrow(/ADVERTISED_URLS/);
    expect(() => loadConfig({ NODE_ENV: 'test', ADVERTISED_URLS: 'nas.local:8484' })).toThrow(/ADVERTISED_URLS/);
  });
});
