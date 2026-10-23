// Isolated loopback benchmark: count actual WebSocket bytes and verify every
// decoded message. Optional input is { streams: string[][] } (one stream per bot).
import net from 'node:net';
import type { WebSocketCompressor } from 'bun';

export function sampleStream(count = 32): string[] {
    return Array.from({ length: count }, (_, tick) => JSON.stringify({
        type: 'sdk_state', state: { tick,
            nearbyLocs: Array.from({ length: 150 }, (_, i) => ({ id: i, name: `Tree ${i}`, x: 3200 + i, z: 3200, options: ['Chop down', 'Examine'] })),
            nearbyNpcs: Array.from({ length: 40 }, (_, i) => ({ index: i, name: `Guard ${i}`, x: 3200 + i + tick % 4, z: 3200 })),
            inventory: [{ name: 'Logs', count: tick }],
            gameMessages: Array.from({ length: 40 }, (_, i) => ({ text: `You get some logs. ${i}`, tick: i }))
        }
    }));
}

export async function trial(streams: string[][], compress: WebSocketCompressor | boolean, offerCompression = true) {
    let wireBytes = 0, sendMs = 0, frames = 0, requestExtensions = '', responseExtensions = '';
    const cpuStart = process.cpuUsage(), started = performance.now();
    const server = Bun.serve<{ stream: number; next: number }>({
        hostname: '127.0.0.1', port: 0,
        fetch(req, s) {
            requestExtensions = req.headers.get('sec-websocket-extensions') ?? '';
            if (s.upgrade(req, { data: { stream: Number(new URL(req.url).pathname.slice(1)), next: 0 } })) return;
            return new Response('', { status: 400 });
        },
        websocket: {
            perMessageDeflate: { compress, decompress: 'shared' },
            message(ws) {
                const payload = streams[ws.data.stream]![ws.data.next++];
                if (payload === undefined) return;
                const start = performance.now();
                ws.send(payload, true);
                sendMs += performance.now() - start;
            }
        }
    });
    const connections = new Set<net.Socket>();
    const proxy = net.createServer(down => {
        const up = net.connect(server.port!, '127.0.0.1');
        connections.add(down); connections.add(up);
        let headers = Buffer.alloc(0), upgraded = false;
        up.on('data', chunk => {
            if (upgraded) wireBytes += chunk.length;
            else {
                headers = Buffer.concat([headers, chunk]);
                const end = headers.indexOf('\r\n\r\n');
                if (end >= 0) {
                    responseExtensions = headers.toString().match(/sec-websocket-extensions:([^\r\n]+)/i)?.[1]?.trim() ?? '';
                    upgraded = true; wireBytes += headers.length - end - 4; headers = Buffer.alloc(0);
                }
            }
        });
        down.pipe(up).pipe(down);
        down.on('error', () => up.destroy()); up.on('error', () => down.destroy());
        down.on('close', () => { up.destroy(); connections.delete(down); });
        up.on('close', () => { down.destroy(); connections.delete(up); });
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const port = (proxy.address() as net.AddressInfo).port;
    try {
        for (let stream = 0; stream < streams.length; stream++) {
            await new Promise<void>((resolve, reject) => {
                const ws = new WebSocket(`ws://127.0.0.1:${port}/${stream}`, { perMessageDeflate: offerCompression });
                let index = 0;
                const timer = setTimeout(() => { ws.terminate(); reject(Error('WebSocket trial timed out')); }, 10000);
                ws.onopen = () => ws.send('next');
                ws.onmessage = event => {
                    if (String(event.data) !== streams[stream]![index]) {
                        clearTimeout(timer); ws.terminate(); reject(Error(`Payload mismatch at ${stream}/${index}`)); return;
                    }
                    index++; frames++;
                    if (index === streams[stream]!.length) { clearTimeout(timer); ws.close(); resolve(); }
                    else ws.send('next');
                };
                ws.onerror = () => { clearTimeout(timer); ws.terminate(); reject(Error('WebSocket error')); };
                ws.onclose = () => { if (index !== streams[stream]!.length) { clearTimeout(timer); reject(Error('Early close')); } };
            });
        }
        const cpu = process.cpuUsage(cpuStart);
        const payloadBytes = streams.flat().reduce((n, s) => n + Buffer.byteLength(s), 0);
        return { compress, offerCompression, requestExtensions, responseExtensions, frames, payloadBytes, wireBytes, ratio: wireBytes / payloadBytes,
            sendMs, cpuMs: (cpu.user + cpu.system) / 1000, elapsedMs: performance.now() - started };
    } finally {
        for (const s of connections) s.destroy();
        proxy.close(); await server.stop(true);
    }
}

if (import.meta.main) {
    const corpus = process.argv[2] ? await Bun.file(process.argv[2]).json() : { streams: [sampleStream()] };
    for (const mode of ['shared', '16KB', '64KB', '128KB', '256KB'] as const) {
        console.log(JSON.stringify({ runtime: Bun.version, ...await trial(corpus.streams, mode) }));
    }
}
