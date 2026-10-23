// Isolated slow-reader reproduction. Never run against the game server.
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { NetworkPressure } from '../../src/util/NetworkPressure.js';

const fixed = process.argv.includes('--fixed');
const pressure = new NetworkPressure();
const sockets = new Set<any>();
const readers: net.Socket[] = [];
const count = 24;
const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(req, server) { if (server.upgrade(req)) return; return new Response('', { status: 400 }); },
    websocket: {
        ...(fixed ? { backpressureLimit: pressure.perSocket, closeOnBackpressureLimit: true } : {}),
        open(ws) {
            sockets.add(ws);
            if (fixed) pressure.register(ws, 'test', () => ws.getBufferedAmount(), () => ws.terminate());
        }, message() {}, close(ws) { sockets.delete(ws); pressure.remove(ws); }
    }
});
const before = process.memoryUsage().rss;
for (let i = 0; i < count; i++) {
    const reader = net.connect(server.port!, '127.0.0.1');
    readers.push(reader);
    reader.on('error', () => {});
    reader.on('connect', () => {
        reader.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`);
        reader.pause();
    });
}
const deadline = Date.now() + 5000;
while (sockets.size < count && Date.now() < deadline) await Bun.sleep(5);
if (sockets.size !== count) throw Error('Readers did not connect');
const frame = Buffer.alloc(32768, 42);
for (let batch = 0; batch < 70; batch++) {
    for (const socket of sockets) for (let n = 0; n < 16; n++) {
        if (fixed && !pressure.beforeSend(socket)) break;
        const result = socket.send(frame);
        if (fixed) pressure.afterSend(socket, result);
    }
    await Bun.sleep(2);
}
console.log(JSON.stringify({ runtime: Bun.version, fixed, readers: count, remainingConnections: sockets.size, pressure: pressure.stats(), rssGrowthMiB: (process.memoryUsage().rss - before) / 1048576,
    bufferedMiB: [...sockets].reduce((n, s) => n + s.getBufferedAmount(), 0) / 1048576,
    peakPerSocketMiB: Math.max(0, ...[...sockets].map(s => s.getBufferedAmount())) / 1048576 }));
for (const reader of readers) reader.destroy();
for (const socket of sockets) socket.terminate();
await server.stop(true);
