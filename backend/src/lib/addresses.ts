import type { NetworkInterfaceInfo } from 'node:os';

/** An address other devices can use to reach this server. */
export interface ReachableAddress {
  url: string;
  /**
   * `lan`: the home network. `vpn`: a private VPN such as Tailscale, which also
   * works away from home. `custom`: listed in ADVERTISED_URLS.
   */
  kind: 'lan' | 'vpn' | 'custom';
}

/** Adapters of virtual machines and containers, which other devices can't reach. */
const VIRTUAL_ADAPTER = /vethernet|wsl|virtualbox|vmware|hyper-v|loopback|docker|^veth|^br-|^virbr/i;
/** Tailscale, ZeroTier and WireGuard adapters. */
const VPN_ADAPTER = /tailscale|zerotier|wireguard|^wg\d|^zt/i;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** Whether only this computer can connect (the desktop app's sharing is off). */
export const isLocalOnly = (host: string): boolean => LOOPBACK_HOSTS.has(host);
const ALL_INTERFACES = new Set(['0.0.0.0', '::', '']);

const octets = (address: string) => address.split('.').map(Number);

/** 10/8, 172.16/12 and 192.168/16: home and office networks. */
export function isPrivateIPv4(address: string): boolean {
  const [a, b] = octets(address);
  return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
}

/** 100.64/10, the carrier-grade NAT range that Tailscale gives its devices. */
export function isSharedIPv4(address: string): boolean {
  const [a, b] = octets(address);
  return a === 100 && b! >= 64 && b! <= 127;
}

/**
 * Where phones can reach a server listening on `host:port`: home-network
 * addresses first, then VPN ones, then `advertised` URLs. Public addresses are
 * left out on purpose: Streamora isn't meant to be exposed to the internet.
 */
export function reachableAddresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
  host: string,
  port: number,
  advertised: string[] = [],
): ReachableAddress[] {
  const found: ReachableAddress[] = [];
  if (!LOOPBACK_HOSTS.has(host)) {
    for (const [name, infos] of Object.entries(interfaces)) {
      const vpnAdapter = VPN_ADAPTER.test(name);
      if (!vpnAdapter && VIRTUAL_ADAPTER.test(name)) continue;
      for (const info of infos ?? []) {
        if (info.family !== 'IPv4' || info.internal) continue;
        if (!ALL_INTERFACES.has(host) && info.address !== host) continue;
        const kind = vpnAdapter || isSharedIPv4(info.address) ? 'vpn' : isPrivateIPv4(info.address) ? 'lan' : null;
        if (kind) found.push({ url: `http://${info.address}:${port}`, kind });
      }
    }
  }
  found.sort((a, b) => Number(a.kind === 'vpn') - Number(b.kind === 'vpn'));
  for (const url of advertised) found.push({ url, kind: 'custom' });
  return found.filter((address, i) => found.findIndex((other) => other.url === address.url) === i);
}
