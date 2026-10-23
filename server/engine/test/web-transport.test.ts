import { afterEach, expect, test } from 'bun:test';
import { Worker } from 'node:worker_threads';
import { gzipSync } from 'node:zlib';
import WS from 'ws';
import net from 'node:net';
import { WebSocketBridge } from '../src/web/WebSocketBridge.js';
import { networkPressure } from '../src/util/NetworkPressure.js';
import { getIp } from '../src/web/utils.js';
import { isTransportRequest, setTransportSecret, TRANSPORT_KEY, TRANSPORT_PEER } from '../src/web/transportAuth.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); setTransportSecret(''); });

async function fixture(overrides: Record<string, unknown> = {}) {
    const secret = crypto.randomUUID();
    setTransportSecret(secret);
    const received: { path: string; peer: string | null; extensions: string | null; role: string }[] = [];
    const compressedBody = gzipSync('compressed HTTP body '.repeat(500));
    const backend = (role: string) => Bun.serve({
        hostname: '127.0.0.1', port: 0,
        async fetch(req, server) {
            const url = new URL(req.url);
            if (role === 'engine' && !isTransportRequest(req)) return new Response(null, { status: 403 });
            if (req.headers.get('upgrade') === 'websocket') {
                received.push({ path: url.pathname + url.search, peer: getIp(req, false), extensions: req.headers.get('sec-websocket-extensions'), role });
                if (server.upgrade(req)) return;
                return new Response(null, { status: 400 });
            }
            if (url.pathname === '/gzip') return new Response(compressedBody, { headers: { 'content-encoding': 'gzip' } });
            if (url.pathname === '/redirect') return new Response(null, { status: 307, headers: { location: '/elsewhere?q=1', 'set-cookie': 'a=1; Path=/' } });
            if (url.pathname === '/cookies') {
                const headers = new Headers(); headers.append('set-cookie', 'a=1; Path=/'); headers.append('set-cookie', 'b=2; HttpOnly');
                return new Response('cookies', { headers });
            }
            return Response.json({ path: url.pathname + url.search, host: req.headers.get('host'), method: req.method,
                body: [...new Uint8Array(await req.arrayBuffer())], peer: getIp(req, false), fly: req.headers.get('fly-client-ip') }, { status: 201 });
        },
        websocket: {
            perMessageDeflate: false,
            message(ws, message) {
                if (message === 'close') ws.close(4001, 'resync');
                else ws.send(message);
            }
        }
    });
    const engine = backend('engine'), gateway = backend('gateway');
    cleanup.push(() => { engine.stop(true); }, () => { gateway.stop(true); });
    const worker = new Worker(new URL('../src/web/WebTransportWorker.ts', import.meta.url), { workerData: {
        port: 0, hostname: '127.0.0.1', engineOrigin: engine.url.origin, gatewayOrigin: gateway.url.origin.replace('http:', 'ws:'),
        secret, behindFly: false, worldFeed: { enabled: true, token: 'test-token', maxClients: 1 }, ...overrides
    } });
    cleanup.push(() => worker.terminate());
    const port = await new Promise<number>((resolve, reject) => {
        worker.on('message', message => { if (message.type === 'ready') resolve(message.port); });
        worker.once('error', reject); worker.once('exit', code => reject(new Error(`worker exited ${code}`)));
    });
    return { url: `http://127.0.0.1:${port}`, received, compressedBody, engine, worker };
}

async function connect(url: string, headers: Record<string, string> = {}, compress = true) {
    const ws = new WS(url.replace('http:', 'ws:'), { headers, perMessageDeflate: compress });
    cleanup.push(() => ws.terminate());
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    return ws;
}

function echo(ws: WS, frames: (string | Buffer)[]) {
    return new Promise<{ data: Buffer; binary: boolean }[]>((resolve, reject) => {
        const result: { data: Buffer; binary: boolean }[] = [];
        ws.on('message', function receive(data, binary) {
            result.push({ data: Buffer.from(data as Buffer), binary });
            if (result.length === frames.length) { ws.off('message', receive); resolve(result); }
        });
        ws.once('error', reject);
        for (const frame of frames) ws.send(frame);
    });
}

test('worker preserves streamed HTTP, status, host, query, redirects, cookies and compressed bytes', async () => {
    const { url, compressedBody, engine } = await fixture();
    expect((await fetch(engine.url)).status).toBe(403);
    const response = await fetch(url + '/upload?name=a%2Fb', { method: 'POST', body: new Uint8Array([0, 255, 1]), headers: {
        host: 'game.example', [TRANSPORT_KEY]: 'spoofed', [TRANSPORT_PEER]: '203.0.113.99', 'fly-client-ip': '203.0.113.98'
    } });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ path: '/upload?name=a%2Fb', host: 'game.example', method: 'POST', body: [0, 255, 1], peer: '127.0.0.1', fly: null });
    const redirect = await fetch(url + '/redirect', { redirect: 'manual' });
    expect(redirect.status).toBe(307); expect(redirect.headers.get('location')).toBe('/elsewhere?q=1');
    expect(redirect.headers.getSetCookie()).toEqual(['a=1; Path=/']);
    expect((await fetch(url + '/cookies')).headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; HttpOnly']);
    const gzip = await fetch(url + '/gzip', { decompress: false });
    expect(gzip.headers.get('content-encoding')).toBe('gzip');
    expect(Buffer.from(await gzip.arrayBuffer())).toEqual(compressedBody);
});

test('game packets preserve binary framing and ordering; loopback is uncompressed and peer is authenticated', async () => {
    const { url, received } = await fixture({ behindFly: true });
    const ws = await connect(url + '/bot?client=old', { 'fly-client-ip': '203.0.113.7', [TRANSPORT_PEER]: '203.0.113.99' });
    const frames = Array.from({ length: 40 }, (_, i) => Buffer.from([i, 0, 255, 128]));
    const echoed = await echo(ws, frames);
    expect(echoed.map(x => x.data)).toEqual(frames);
    expect(echoed.every(x => x.binary)).toBe(true);
    expect(received).toEqual([{ path: '/bot?client=old', peer: '203.0.113.7', extensions: null, role: 'engine' }]);
});

test('legacy gateway bypasses engine, preserves labels, compresses text, supports old clients and propagates closes', async () => {
    const { url, received } = await fixture({ behindFly: true });
    for (const compress of [true, false]) {
        const ws = await connect(url + '/gateway/', { 'fly-client-ip': '203.0.113.8', 'fly-region': 'lhr' }, compress);
        expect(ws.extensions.includes('permessage-deflate')).toBe(compress);
        const payload = 'ordered state '.repeat(4000);
        const [reply] = await echo(ws, [payload]);
        expect(reply.data.toString()).toBe(payload); expect(reply.binary).toBe(false);
        const closed = new Promise<[number, string]>(resolve => ws.once('close', (code, reason) => resolve([code, reason.toString()])));
        ws.send('close'); expect(await closed).toEqual([4001, 'resync']);
    }
    expect(received.map(x => x.role)).toEqual(['gateway', 'gateway']);
    expect(received.every(x => x.extensions === null)).toBe(true);
    expect(received[0].path).toBe('/?edge=lhr&ip=203.0.113.8');
});

test('spectator token, capacity and ordered text survive worker boundary', async () => {
    const { url } = await fixture();
    const refused = async (path: string) => {
        const response = await fetch(url + path, { headers: {
            upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13'
        } });
        return response.status;
    };
    expect(await refused('/worldfeed')).toBe(403);
    expect(await refused('/unknown')).toBe(404);
    const ws = await connect(url + '/worldfeed?token=test-token');
    expect(await refused('/worldfeed?token=test-token')).toBe(503);
    const frames = Array.from({ length: 20 }, (_, tick) => JSON.stringify({ tick, deltas: ['delta'.repeat(1000)] }));
    expect((await echo(ws, frames)).map(x => x.data.toString())).toEqual(frames);
    await new Promise<void>(resolve => { ws.once('close', () => resolve()); ws.close(); });
    const replacement = await connect(url + '/worldfeed?token=test-token');
    expect((await echo(replacement, ['hello']))[0].data.toString()).toBe('hello');
});

test('worker compresses gateway and spectator bytes on the wire while game packets remain uncompressed', async () => {
    const { url } = await fixture();
    let wire = Buffer.alloc(0);
    const sockets = new Set<net.Socket>();
    const proxy = net.createServer(down => {
        const up = net.connect(Number(new URL(url).port), '127.0.0.1');
        sockets.add(down); sockets.add(up);
        let headers = Buffer.alloc(0), upgraded = false;
        up.on('data', chunk => {
            if (upgraded) wire = Buffer.concat([wire, chunk]);
            else {
                headers = Buffer.concat([headers, chunk]);
                const end = headers.indexOf('\r\n\r\n');
                if (end >= 0) { upgraded = true; wire = Buffer.from(headers.subarray(end + 4)); }
            }
        });
        down.pipe(up).pipe(down);
        down.on('error', () => up.destroy()); up.on('error', () => down.destroy());
        down.on('close', () => up.destroy()); up.on('close', () => down.destroy());
    });
    cleanup.push(() => { for (const socket of sockets) socket.destroy(); proxy.close(); });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const address = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
    for (const path of ['/gateway', '/worldfeed?token=test-token', '/bot']) {
        const ws = await connect(address + path);
        const payload = Buffer.from('compressible state '.repeat(4000));
        const result = await echo(ws, [payload]);
        expect(result[0].data).toEqual(payload);
        const compressed = path !== '/bot';
        expect(Boolean(wire[0] & 0x40)).toBe(compressed);
        if (compressed) expect(wire.length).toBeLessThan(payload.length / 10);
        else expect(wire.length).toBeGreaterThanOrEqual(payload.length);
        await new Promise<void>(resolve => { ws.once('close', () => resolve()); ws.close(); });
    }
});

function bridge() {
    const down = { bytes: 0, terminated: 0, result: 1, getBufferedAmount() { return this.bytes; },
        send() { return this.result; }, terminate() { this.terminated++; }, close() {} };
    const up = { readyState: 0, bufferedAmount: 0, terminated: 0, sent: [] as (string | Buffer)[],
        onopen: null as any, onmessage: null as any, onclose: null as any, onerror: null as any,
        send(frame: string | Buffer) { this.sent.push(frame); }, terminate() { this.terminated++; }, close() {} };
    return { down, up, bridge: new WebSocketBridge(down, up as unknown as WebSocket, true) };
}

test('transport bounds handshake queues, copies transient binary buffers, closes on lost ordered frames and releases accounting', () => {
    const before = networkPressure.stats().connections;
    const first = bridge();
    for (let i = 0; i < 65; i++) first.bridge.message('pending');
    expect(first.up.terminated).toBe(1); expect(first.down.terminated).toBe(1);
    const second = bridge(); second.bridge.message('x'.repeat(262145));
    expect(second.up.terminated).toBe(1);
    const third = bridge(), frame = Buffer.from([1, 2]);
    third.bridge.message(frame); frame[0] = 9;
    third.up.readyState = 1; third.up.onopen();
    expect(third.up.sent).toEqual([Buffer.from([1, 2])]);
    third.down.result = 0; third.up.onmessage({ data: 'lost delta' });
    expect(third.down.terminated).toBe(1); expect(third.up.terminated).toBe(1);
    third.bridge.close(); expect(third.up.terminated).toBe(1);
    const fourth = bridge(); fourth.up.readyState = 1; fourth.up.onopen(); fourth.up.bufferedAmount = 3 * 1024 * 1024;
    fourth.bridge.message('action'); expect(fourth.up.sent).toEqual([]); expect(fourth.down.terminated).toBe(1);
    expect(networkPressure.stats().connections).toBe(before);
});
