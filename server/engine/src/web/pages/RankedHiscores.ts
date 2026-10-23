import { Worker } from 'node:worker_threads';
import { registerMemoryWorker } from '#/util/MemoryDiagnostics.js';

export type RankedRow = { username: string; level: number; playtime: number };
type Job = { resolve: (rows: RankedRow[]) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; request: { profile: string; category: number } };
let worker: Worker | null = null;
let workerReady = false;
let nextId = 0;
const jobs = new Map<number, Job>();

// Only immutable leaderboard rows cross threads; the worker never touches the world.
export function loadRankedList(profile: string, category: number): Promise<RankedRow[]> {
    if (!worker) {
        const current = new Worker(new URL('./RankedHiscoresWorker.ts', import.meta.url));
        registerMemoryWorker(current, 'rankings');
        worker = current;
        workerReady = false;
        const fail = (error: Error) => {
            if (worker !== current) return;
            worker = null;
            void current.terminate();
            for (const job of jobs.values()) { clearTimeout(job.timer); job.reject(error); }
            jobs.clear();
        };
        current.on('error', fail);
        current.on('exit', code => fail(new Error(`Leaderboard worker exited (${code})`)));
        current.on('message', ({ id, rows, error, ready }) => {
            if (worker !== current) return;
            if (ready) {
                workerReady = true;
                for (const [id, job] of jobs) current.postMessage({ id, ...job.request });
                return;
            }
            const job = jobs.get(id);
            if (!job) return;
            jobs.delete(id);
            clearTimeout(job.timer);
            if (error) job.reject(new Error(error)); else job.resolve(rows);
            if (!jobs.size) current.unref();
        });
        current.unref();
    }
    const current = worker;
    return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
            // Restart on a stuck query so later refreshes don't accumulate behind it.
            if (worker === current) { worker = null; void current.terminate(); }
            for (const job of jobs.values()) { clearTimeout(job.timer); job.reject(new Error('Leaderboard refresh timed out')); }
            jobs.clear();
        }, 30_000);
        jobs.set(id, { resolve, reject, timer, request: { profile, category } });
        current.ref();
        if (workerReady) current.postMessage({ id, profile, category });
    });
}
