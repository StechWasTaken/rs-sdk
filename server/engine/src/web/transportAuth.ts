import { isIP } from 'node:net';

export const TRANSPORT_KEY = 'x-rs-transport-key';
export const TRANSPORT_PEER = 'x-rs-transport-peer';
let secret = '';

// Set only in the engine isolate. The public worker overwrites both headers.
export function setTransportSecret(value: string): void { secret = value; }
export function isTransportRequest(req: Request): boolean {
    return secret !== '' && req.headers.get(TRANSPORT_KEY) === secret;
}
export function getTransportPeer(req: Request): string | null {
    if (!isTransportRequest(req)) return null;
    const peer = req.headers.get(TRANSPORT_PEER) ?? '';
    return isIP(peer) ? peer : null;
}
