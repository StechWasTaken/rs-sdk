import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import { getMemoryDiagnostics, registerMemoryWorker } from '../src/util/MemoryDiagnostics.js';

test('worker replacement retains the new sample when the old worker exits', () => {
    const oldWorker = Object.assign(new EventEmitter(), { threadId: 101 });
    const newWorker = Object.assign(new EventEmitter(), { threadId: 102 });
    registerMemoryWorker(oldWorker as unknown as Worker, 'test-worker');
    registerMemoryWorker(newWorker as unknown as Worker, 'test-worker');
    newWorker.emit('message', { type: 'memory_sample', sample: { threadId: 102, heapUsed: 42 } });
    oldWorker.threadId = -1;
    oldWorker.emit('exit', 0);
    expect(getMemoryDiagnostics().workers['test-worker'].heapUsed).toBe(42);
    newWorker.threadId = -1;
    newWorker.emit('exit', 0);
    expect(getMemoryDiagnostics().workers['test-worker']).toBeUndefined();
});

test('memory history is persisted and rotated without keeping the process alive', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rs-memory-'));
    try {
        writeFileSync(join(directory, 'test.jsonl'), 'x'.repeat(5 * 1024 * 1024));
        const script = `
            import { startMemoryDiagnostics } from ${JSON.stringify(new URL('../src/util/MemoryDiagnostics.ts', import.meta.url).href)};
            startMemoryDiagnostics('test', () => ({ players: 123 }));
            startMemoryDiagnostics('ignored');
        `;
        const result = Bun.spawnSync([process.execPath, '-e', script], {
            env: { ...process.env, MEMORY_DIAGNOSTICS_DIR: directory }, timeout: 5000
        });
        expect(result.exitCode).toBe(0);
        const lines = readFileSync(join(directory, 'test.jsonl'), 'utf8').trim().split('\n');
        expect(lines.length).toBe(1);
        const value = JSON.parse(lines[0]);
        expect(value.process.role).toBe('test');
        expect(value.process.rss).toBeGreaterThan(0);
        expect(value.native.current).toBeGreaterThan(0);
        expect(value.context.network.bufferedBytes).toBe(0);
        expect(value.context.players).toBe(123);
        expect(readFileSync(join(directory, 'test.jsonl.1')).length).toBe(5 * 1024 * 1024);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
