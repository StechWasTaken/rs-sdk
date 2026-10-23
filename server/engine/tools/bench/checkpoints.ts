// Disposable ledger and worker stubs; never connects to the running game.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';

if (!process.env.CHECKPOINT_BENCH_CHILD) {
    const dir = mkdtempSync(join(tmpdir(), 'checkpoint-bench-'));
    try {
        mkdirSync(join(dir, 'data/config'), { recursive: true });
        copyFileSync(join(import.meta.dir, '../../data/config/private.pem'), join(dir, 'data/config/private.pem'));
        const result = Bun.spawnSync([process.execPath, import.meta.path], {
            cwd: dir,
            env: { ...process.env, CHECKPOINT_BENCH_CHILD: '1', GE_ENABLED: 'true', GE_DATABASE: join(dir, 'market.sqlite'),
                CHECKPOINT_BENCH_CACHE: resolve(import.meta.dir, '../../data/pack') },
            stdout: 'inherit', stderr: 'inherit'
        });
        process.exitCode = result.exitCode;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
} else {
    const { mock } = await import('bun:test');
    class TestWorker extends EventEmitter { postMessage() {} }
    mock.module('worker_threads', () => ({ Worker: TestWorker }));
    const engineRoot = process.env.PERF_ENGINE_ROOT ?? resolve(import.meta.dir, '../..');
    const load = (path: string) => import(pathToFileURL(join(engineRoot, 'src', path)).href);
    const { default: World } = await load('engine/World.js');
    const { default: Player } = await load('engine/entity/Player.js');
    const { default: VarPlayerType } = await load('cache/config/VarPlayerType.js');
    const { default: InvType } = await load('cache/config/InvType.js');
    const { marketStore } = await load('engine/market/MarketStore.js');
    VarPlayerType.load(process.env.CHECKPOINT_BENCH_CACHE!);
    InvType.load(process.env.CHECKPOINT_BENCH_CACHE!);
    const players = Array.from({ length: 2000 }, (_, i) => {
        const p = new Player(`bench${i}`, BigInt(i + 1), BigInt(i + 1));
        p.x = 3200 + i % 50; p.z = 3200;
        for (let id = 0; id < p.vars.length; id += 31) p.vars[id] = id + 1;
        p.getInventory(InvType.getId('bank'));
        World.playerLoop.add(BigInt(i + 1), p);
        return p;
    });
    function bench(name: string, action: () => void) {
        action(); action();
        const samples = [];
        for (let i = 0; i < 9; i++) {
            Bun.gc(true);
            const start = performance.now();
            action();
            samples.push(performance.now() - start);
        }
        console.log(JSON.stringify({ name, medianMs: [...samples].sort((a, b) => a - b)[4], samples }));
    }
    bench('serialize-2000', () => { for (const p of players) p.save(false); });
    bench('checkpoint-2000-unchanged', () => { World.checkpointPlayers(); });
    bench('checkpoint-2000-changing', () => {
        for (const p of players) p.playtime++;
        World.checkpointPlayers();
    });
    marketStore().db.close();
    process.exit(0);
}
