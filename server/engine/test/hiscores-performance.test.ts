import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('ranking indexes preserve results and avoid scanning other skills and sorting', () => {
    const db = new Database(':memory:');
    try {
        db.exec(`CREATE TABLE account(id INTEGER PRIMARY KEY, username TEXT, staffmodlevel INTEGER);
            CREATE TABLE hiscore(profile TEXT, account_id INTEGER, type INTEGER, level INTEGER, playtime INTEGER, PRIMARY KEY(profile,account_id,type));
            CREATE TABLE hiscore_large(profile TEXT, account_id INTEGER, type INTEGER, level INTEGER, playtime INTEGER, PRIMARY KEY(profile,account_id,type));
            INSERT INTO account VALUES(1,'slower',0),(2,'faster',0),(3,'lower',0),(4,'staff',2);
            INSERT INTO hiscore VALUES('main',1,1,99,200),('main',2,1,99,100),('main',3,1,50,1),('main',4,1,100,1),('main',1,2,100,1),('iron',3,1,100,1);
            INSERT INTO hiscore_large SELECT * FROM hiscore;`);
        const query = (table: string) => `SELECT account.username, h.level, h.playtime FROM ${table} h JOIN account ON account.id=h.account_id WHERE h.profile='main' AND h.type=1 AND account.staffmodlevel<=1 ORDER BY h.level DESC,h.playtime ASC`;
        const before = ['hiscore', 'hiscore_large'].map(table => db.query(query(table)).all());
        for (const migration of ['20261011000000_hiscore_rank_indexes', '20261022000000_hiscore_playtime_ms', '20261022010000_hiscore_normalized_rank']) {
            db.exec(readFileSync(join(import.meta.dir, `../prisma/singleworld/migrations/${migration}/migration.sql`), 'utf8'));
        }
        for (const [index, table] of ['hiscore', 'hiscore_large'].entries()) {
            expect(db.query(query(table)).all()).toEqual(before[index]);
            const plan = JSON.stringify(db.query('EXPLAIN QUERY PLAN ' + query(table)).all());
            expect(plan).toContain(`COVERING INDEX ${table}_rank`);
            expect(plan).toContain('profile=? AND type=?');
            expect(plan).not.toContain('TEMP B-TREE');
        }
    } finally {
        db.close();
    }
});

test('cached ranks remain correct across profiles, exclusions and cache refresh', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ranked-hiscores-'));
    try {
        const result = Bun.spawnSync([process.execPath, join(import.meta.dir, 'fixtures/ranked-hiscores.ts')], {
            cwd: dir,
            env: { ...process.env, DB_BACKEND: 'sqlite', HISCORES_HIDDEN_NAMES: 'hidden', HISCORES_CACHE_MS: '60000', NODE_TICKRATE: '400' },
        });
        if (result.exitCode !== 0) throw new Error(result.stdout.toString() + result.stderr.toString());
        expect(result.exitCode).toBe(0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});


test('ranking requests wait for a worker with delayed startup to install its handler', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ranked-startup-'));
    try {
        writeFileSync(join(dir, 'RankedHiscores.ts'), readFileSync(join(import.meta.dir, '../src/web/pages/RankedHiscores.ts'), 'utf8')
            .replace('#/util/MemoryDiagnostics.js', './MemoryDiagnostics.ts'));
        writeFileSync(join(dir, 'MemoryDiagnostics.ts'), readFileSync(join(import.meta.dir, '../src/util/MemoryDiagnostics.ts')));
        writeFileSync(join(dir, 'NetworkPressure.ts'), readFileSync(join(import.meta.dir, '../src/util/NetworkPressure.ts')));
        writeFileSync(join(dir, 'RankedHiscoresWorker.ts'), `
            import { parentPort } from 'node:worker_threads';
            let listening = false;
            parentPort.on('message', ({ id, profile }) => {
                if (listening) parentPort.postMessage({ id, rows: [{ username: profile, level: 1, playtime: 0 }] });
            });
            setTimeout(() => { listening = true; parentPort.postMessage({ ready: true }); }, 100);
        `);
        writeFileSync(join(dir, 'check.ts'), `
            import assert from 'node:assert/strict';
            import { loadRankedList } from './RankedHiscores.ts';
            const timeout = setTimeout(() => process.exit(1), 2000);
            const rows = await Promise.all([loadRankedList('a', 0), loadRankedList('b', 1)]);
            assert.deepEqual(rows.map(r => r[0].username), ['a', 'b']);
            clearTimeout(timeout);
        `);
        const result = Bun.spawnSync([process.execPath, join(dir, 'check.ts')]);
        expect(result.exitCode).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
