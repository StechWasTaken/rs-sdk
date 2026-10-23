import { Worker } from 'node:worker_threads';
import { registerMemoryWorker } from '../util/MemoryDiagnostics.js';
import type { WebTransportOptions } from './WebTransportServer.js';

// A failed public listener must not leave a running but unreachable world.
// Recreate only the transport isolate; clients reconnect to the existing game.
export function startWebTransport(options: WebTransportOptions): Promise<void> {
    return new Promise((resolve, reject) => {
        let started = false;
        function launch() {
            const worker = new Worker(new URL('./WebTransportWorker.ts', import.meta.url), { workerData: options });
            registerMemoryWorker(worker, 'web-transport');
            const timeout = setTimeout(() => { void worker.terminate(); }, 10000);
            timeout.unref();
            worker.on('message', message => {
                if (message?.type !== 'ready') return;
                clearTimeout(timeout);
                console.log(`[web-transport] listening on ${message.port}`);
                started = true;
                resolve();
            });
            worker.on('error', error => console.error('[web-transport] worker error', error));
            worker.on('exit', code => {
                clearTimeout(timeout);
                if (!started) { reject(new Error(`Web transport failed to start (exit ${code})`)); return; }
                console.error(`[web-transport] exited (${code}); restarting in one second`);
                setTimeout(launch, 1000);
            });
        }
        launch();
    });
}
