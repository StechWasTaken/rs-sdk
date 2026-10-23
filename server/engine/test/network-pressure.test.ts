import { expect, test } from 'bun:test';
import { NetworkPressure, networkPressure } from '../src/util/NetworkPressure.js';
import { AgentRelay } from '../src/web/AgentRelay.js';

function socket(pressure: NetworkPressure) {
    const state = { bytes: 0, closed: 0 };
    pressure.register(state, 'test', () => state.bytes, () => { state.closed++; pressure.remove(state); });
    return state;
}

test('individual slow readers disconnect and release memory accounting', () => {
    const pressure = new NetworkPressure(100, 1000);
    const slow = socket(pressure), healthy = socket(pressure);
    slow.bytes = 101;
    expect(pressure.beforeSend(slow)).toBe(false);
    expect(slow.closed).toBe(1);
    expect(pressure.beforeSend(healthy)).toBe(true);
    expect(pressure.stats().bufferedBytes).toBe(0);
    expect(pressure.stats().connections).toBe(1);
});

test('aggregate budget closes largest queues, preserving healthy readers', () => {
    const pressure = new NetworkPressure(100, 200);
    const sockets = Array.from({ length: 5 }, () => socket(pressure));
    for (const s of sockets.slice(0, 4)) { s.bytes = 60; pressure.afterSend(s, -1); }
    expect(pressure.stats().bufferedBytes).toBeLessThanOrEqual(150);
    expect(sockets.filter(s => s.closed).length).toBe(2);
    expect(sockets[4].closed).toBe(0);
});

test('drained queues are refreshed before aggregate eviction', () => {
    const pressure = new NetworkPressure(100, 100);
    const a = socket(pressure), b = socket(pressure);
    a.bytes = 80; pressure.afterSend(a, -1);
    a.bytes = 0;
    b.bytes = 80; pressure.afterSend(b, -1);
    expect(a.closed + b.closed).toBe(0);
    expect(pressure.stats().bufferedBytes).toBe(80);
});

test('dropped ordered frames disconnect; stale full states can be skipped', () => {
    const pressure = new NetworkPressure();
    const s = socket(pressure);
    s.bytes = 300 * 1024;
    expect(pressure.skipState(s)).toBe(true);
    s.bytes = 0;
    expect(pressure.skipState(s)).toBe(false);
    pressure.afterSend(s, 0);
    expect(s.closed).toBe(1);
    expect(pressure.stats().droppedFrames).toBe(1);
});

function relay() {
    const down = { bytes: 0, terminated: 0, closed: 0, result: 1, sent: [] as string[],
        getBufferedAmount() { return this.bytes; }, send(data: string) { this.sent.push(data); return this.result; },
        terminate() { this.terminated++; }, close() { this.closed++; } };
    const up = { readyState: 0, bufferedAmount: 0, terminated: 0, closed: 0, sent: [] as string[],
        onopen: null as any, onmessage: null as any, onclose: null as any, onerror: null as any,
        send(data: any) { this.sent.push(data); }, terminate() { this.terminated++; }, close() { this.closed++; } };
    return { down, up, relay: new AgentRelay(down, up, () => false) };
}

test('relay bounds pre-open messages and releases both ends even on late open', () => {
    const before = networkPressure.stats().connections;
    const { relay: r, up, down } = relay();
    const lateOpen = up.onopen;
    for (let i = 0; i < 65; i++) r.message('pending');
    expect(up.terminated).toBe(1);
    expect(down.terminated).toBe(1);
    up.readyState = 1; lateOpen();
    expect(up.sent).toEqual([]);
    expect(up.onmessage).toBeNull();
    expect(networkPressure.stats().connections).toBe(before);
});

test('relay bounds pre-open bytes independently of frame count', () => {
    const { relay: r, up } = relay();
    r.message('x'.repeat(262145));
    expect(up.terminated).toBe(1);
});

test('relay preserves order and tears down dropped downstream streams', () => {
    const before = networkPressure.stats().connections;
    const { relay: r, up, down } = relay();
    r.message('first'); r.message('second');
    up.readyState = 1; up.onopen(); r.message('third');
    expect(up.sent).toEqual(['first', 'second', 'third']);
    up.onmessage({ data: 'response' });
    expect(down.sent).toEqual(['response']);
    down.result = 0; up.onmessage({ data: 'dropped' });
    expect(up.terminated).toBe(1);
    expect(down.terminated).toBe(1);
    r.close();
    expect(up.terminated).toBe(1);
    expect(networkPressure.stats().connections).toBe(before);
});

test('relay bounds upstream buffering and cleans up downstream disconnects', () => {
    const before = networkPressure.stats().connections;
    const first = relay();
    first.up.readyState = 1; first.up.onopen();
    first.up.bufferedAmount = 3 * 1024 * 1024;
    first.relay.message('action');
    expect(first.up.sent).toEqual([]);
    expect(first.down.terminated).toBe(1);
    const second = relay(); second.relay.close();
    expect(second.up.terminated).toBe(1);
    expect(networkPressure.stats().connections).toBe(before);
});
