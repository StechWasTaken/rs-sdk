import { expect, test } from 'bun:test';
import { Packet } from '../src/network/rsbuf/packet.js';
import ClientSocket from '../src/server/ClientSocket.js';

class TestSocket extends ClientSocket {
    closed = false;
    send() {}
    close() { this.closed = true; }
    terminate() {}
}

test('packet copies preserve full views, slices, offsets and overlapping sources', () => {
    const backing = Uint8Array.from({ length: 32 }, (_, i) => i);
    for (const source of [backing, backing.subarray(5, 13), Buffer.from(backing)]) {
        for (const [offset, length] of [[0, source.length], [1, 3], [0, 0]]) {
            const original = new Uint8Array(source);
            const packet = new Packet(64);
            packet.pos = 4;
            packet.pdata(source, offset, length);
            expect(packet.pos).toBe(4 + length);
            expect(packet.data.slice(4, packet.pos)).toEqual(new Uint8Array(source.slice(offset, offset + length)));
            // pdata must copy, not retain an alias to a renderer's cached bytes.
            const saved = packet.data.slice();
            source.fill(99);
            expect(packet.data).toEqual(saved);
            source.set(original);
        }
    }
    const packet = new Packet(12);
    packet.data.set([1, 2, 3, 4, 5, 6]);
    packet.pos = 2;
    packet.pdata(packet.data.subarray(0, 6), 0, 6);
    expect([...packet.data.slice(0, 8)]).toEqual([1, 2, 1, 2, 3, 4, 5, 6]);
});

test('reads preserve packet order across fragmented input and append after partial reads', () => {
    const socket = new TestSocket();
    socket.buffer(Buffer.from([10, 11, 12]));
    const dest = new Uint8Array(8).fill(255);
    expect(socket.read(dest, 2, 2)).toBe(true);
    expect([...dest]).toEqual([255, 255, 10, 11, 255, 255, 255, 255]);
    expect(socket.available).toBe(1);
    socket.buffer(Buffer.from([13, 14, 15]));
    expect(socket.read(dest, 0, 5)).toBe(false);
    expect(socket.available).toBe(4);
    expect(socket.read(dest, 0, 0)).toBe(true);
    expect(socket.read(dest, 0, 4)).toBe(true);
    expect([...dest.slice(0, 4)]).toEqual([12, 13, 14, 15]);
    expect(socket.available).toBe(0);
    expect(socket.remaining).toBe(socket.in.length);
    socket.buffer(Buffer.from([20]));
    expect(socket.read(dest, 0, 1)).toBe(true);
    expect(dest[0]).toBe(20);
});

test('random fragmented reads match a byte queue up to receive capacity', () => {
    const socket = new TestSocket();
    const queue: number[] = [];
    let seed = 12345;
    const random = (max: number) => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % max);
    // Exercise overlap with more queued bytes than consumed, plus a full buffer.
    const full = Buffer.from(Uint8Array.from({ length: socket.remaining }, (_, i) => i & 255));
    socket.buffer(full);
    queue.push(...full);
    for (let i = 0; i < 600; i++) {
        const length = random(Math.min(queue.length + 2, 1000));
        const dest = new Uint8Array(length + 4).fill(253);
        const before = queue.length;
        expect(socket.read(dest, 2, length)).toBe(length <= before);
        if (length <= before) {
            expect([...dest.slice(2, 2 + length)]).toEqual(queue.splice(0, length));
        }
        expect(dest[0]).toBe(253);
        expect(dest.at(-1)).toBe(253);
        const append = Buffer.from(Uint8Array.from({ length: Math.min(random(400), socket.remaining) }, () => random(256)));
        socket.buffer(append);
        queue.push(...append);
        expect(socket.available).toBe(queue.length);
        expect([...socket.in.data.slice(0, socket.available)]).toEqual(queue);
    }
    expect(socket.closed).toBe(false);
    socket.buffer(Buffer.alloc(socket.remaining + 1));
    expect(socket.closed).toBe(true);
});
