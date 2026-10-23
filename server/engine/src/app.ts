import fs from 'fs';
import { Worker } from 'worker_threads';

import { collectDefaultMetrics, register } from 'prom-client';

import { packAll } from '#tools/pack/PackAll.js';
import World from '#/engine/World.js';
import TcpServer from '#/server/tcp/TcpServer.js';
import Environment from '#/util/Environment.js';
import { printError, printInfo } from '#/util/Logger.js';
import { startManagementWeb, startWeb } from '#/web.js';
import OnDemand from '#/engine/OnDemand.js';
import { registerMemoryWorker, startMemoryDiagnostics } from '#/util/MemoryDiagnostics.js';

startMemoryDiagnostics('engine', () => ({ tick: World.currentTick, players: World.getTotalPlayers(), pendingLogins: World.newPlayers.size }));

if (OnDemand.cache.count(0) !== 9 || OnDemand.cache.count(2) === 0 || !fs.existsSync('data/pack/server/script.dat')) {
    printInfo('Packing cache, please wait until you see the world is ready.');

    try {
        // todo: different logic so the main thread doesn't have to load pack files
        const modelFlags: number[] = [];
        await packAll(modelFlags);
    } catch (err) {
        if (err instanceof Error) {
            printError(err);
        }

        process.exit(1);
    }
}

if (Environment.easyStartup) {
    for (const server of ['login', 'friend', 'logger']) {
        const worker = new Worker(new URL(`./${server}.ts`, import.meta.url));
        registerMemoryWorker(worker, server);
        worker.on('error', err => printError(`${server} server worker error: ${err.message ?? err}`));
        worker.on('exit', code => printError(`${server} server worker exited with code ${code}`));
    }
}

await World.start();

const tcpServer = new TcpServer();
tcpServer.start();

await startWeb();
await startManagementWeb();

register.setDefaultLabels({ nodeId: Environment.node.id });
collectDefaultMetrics({ register });

let exiting = false;
function safeExit() {
    if (exiting) {
        return;
    }

    exiting = true;
    World.rebootTimer(0);
}

process.on('SIGINT', safeExit);
process.on('SIGTERM', safeExit);

process.on('uncaughtException', function (err) {
    console.error(err, 'Uncaught exception');
});

process.on('unhandledRejection', (reason, promise) => {
    console.error({ promise, reason }, 'Unhandled Rejection at: Promise');
});
