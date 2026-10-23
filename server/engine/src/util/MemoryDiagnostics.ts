import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isMainThread, parentPort, threadId, type Worker } from 'node:worker_threads';
import { networkPressure } from './NetworkPressure.js';
import { memoryUsage as nativeMemoryUsage } from 'bun:jsc';

// JS heap statistics omit substantial native allocations (SQLite, sockets, workers).
// Keep process RSS alongside each isolate's heap, and retain samples across OOM restarts.
const INTERVAL_MS = 30_000;
const MAX_HISTORY = 120;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
type Sample = { at: number; role: string; pid: number; threadId: number; rss: number; heapTotal: number; heapUsed: number; external: number; arrayBuffers: number };
type WorkerSample = Sample & { receivedAt: number };
const workers = new Map<string, WorkerSample>();
const history: ReturnType<typeof snapshot>[] = [];
let role = 'engine';
let timer: ReturnType<typeof setInterval> | undefined;
let context: () => Record<string, unknown> = () => ({});
let lastWriteError = 0;

function sample(): Sample {
    return { at: Date.now(), role, pid: process.pid, threadId, ...process.memoryUsage() };
}

function systemMemory(): Record<string, number> | null {
    if (process.platform !== 'linux') return null;
    try {
        const meminfo = readFileSync('/proc/meminfo', 'utf8');
        return Object.fromEntries(['MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree'].map(name =>
            [name, Number(meminfo.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))?.[1] ?? 0) * 1024]));
    } catch { return null; }
}

function snapshot() {
    return { process: sample(), native: nativeMemoryUsage(), system: systemMemory(), workers: Object.fromEntries(workers), context: { ...context(), network: networkPressure.stats() } };
}

export function getMemoryDiagnostics(includeHistory = false) {
    return { ...snapshot(), ...(includeHistory ? { history: [...history] } : {}) };
}

export function registerMemoryWorker(worker: Worker, name: string): void {
    const id = worker.threadId;
    worker.on('message', message => {
        if (message?.type !== 'memory_sample') return;
        const value = message.sample as Sample;
        workers.set(name, { ...value, receivedAt: Date.now() });
    });
    worker.on('exit', () => {
        // An old worker's late exit must not remove its replacement's sample.
        if (workers.get(name)?.threadId === id) workers.delete(name);
    });
}

export function startMemoryDiagnostics(name: string, getContext?: () => Record<string, unknown>): void {
    if (timer) return;
    role = name;
    if (getContext) context = getContext;
    const collect = () => {
        if (!isMainThread) {
            parentPort?.postMessage({ type: 'memory_sample', sample: sample() });
            return;
        }
        const value = snapshot();
        history.push(value);
        if (history.length > MAX_HISTORY) history.shift();
        const directory = process.env.MEMORY_DIAGNOSTICS_DIR;
        if (!directory) return;
        try {
            mkdirSync(directory, { recursive: true });
            const file = join(directory, `${name}.jsonl`);
            if (existsSync(file) && statSync(file).size >= MAX_FILE_BYTES) renameSync(file, `${file}.1`);
            appendFileSync(file, JSON.stringify(value) + '\n');
        } catch (error) {
            if (Date.now() - lastWriteError > 60_000) {
                lastWriteError = Date.now();
                console.warn('[memory] could not persist sample:', String(error));
            }
        }
    };
    collect();
    timer = setInterval(collect, INTERVAL_MS);
    timer.unref();
}
