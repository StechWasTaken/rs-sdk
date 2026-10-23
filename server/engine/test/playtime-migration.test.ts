import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatPlaytime, formatNormalizedPlaytime, legacyPlaytimeMs, savedPlaytimeMs } from '../src/util/Playtime.js';
import { backupPlaytimeMigration } from '../tools/server/backup-playtime-migration.js';

const migration = readFileSync(new URL('../prisma/singleworld/migrations/20261022000000_hiscore_playtime_ms/migration.sql', import.meta.url), 'utf8');

test('duration migration preserves all legacy values and order, with a covering index for new rankings', () => {
    const db = new Database(':memory:');
    try {
        for (const table of ['hiscore', 'hiscore_large']) {
            db.exec(`CREATE TABLE ${table}(profile TEXT, type INTEGER, account_id INTEGER, level INTEGER, playtime INTEGER, date TEXT);
                CREATE INDEX ${table}_rank ON ${table}(profile,type,level DESC,playtime,account_id);
                INSERT INTO ${table} VALUES('main',1,1,99,200,'old'),('main',1,2,99,100,'old'),('iron',1,3,99,12000000,'old'),('main',100,4,50,400,'old');`);
        }
        db.exec(migration);
        for (const table of ['hiscore', 'hiscore_large']) {
            expect(db.query(`SELECT playtime,playtime_ms,date FROM ${table} WHERE account_id=3`).get()).toEqual({ playtime: 12000000, playtime_ms: 3600000000, date: 'old' });
            expect(db.query(`SELECT count(*) AS n FROM ${table} WHERE playtime_ms != playtime*300`).get()).toEqual({ n: 0 });
            const query = `SELECT account_id,level,playtime_ms FROM ${table} WHERE profile='main' AND type=1 ORDER BY level DESC,playtime_ms ASC`;
            expect((db.query(query).all() as { account_id: number }[]).map(x => x.account_id)).toEqual([2, 1]);
            const plan = JSON.stringify(db.query('EXPLAIN QUERY PLAN ' + query).all());
            expect(plan).toContain(`COVERING INDEX ${table}_duration_rank`);
            expect(plan).not.toContain('TEMP B-TREE');
            // Historical duration remains available independently of normalized rankings.
            db.exec(`UPDATE ${table} SET playtime_ms=25000 WHERE account_id=1`);
            expect((db.query(query).all() as { account_id: number }[]).map(x => x.account_id)).toEqual([1, 2]);
        }
    } finally { db.close(); }
});

test('legacy conversion and formatting do not depend on the current tick configuration', () => {
    const original = process.env.NODE_TICKRATE;
    try {
        for (const tickMs of [300, 400, 600, 1000]) {
            process.env.NODE_TICKRATE = String(tickMs);
            expect(legacyPlaytimeMs(36000)).toBe(10800000);
            expect(formatPlaytime(10800000)).toContain('3h 00m 00s');
        }
        expect(savedPlaytimeMs(8640000000n)).toBe(8640000000);
        expect(() => savedPlaytimeMs(-1n)).toThrow();
        expect(() => savedPlaytimeMs(9007199254740992n)).toThrow();
    } finally {
        if (original === undefined) delete process.env.NODE_TICKRATE;
        else process.env.NODE_TICKRATE = original;
    }
});

test('offline backup includes highscore rows, WAL market checkpoints and player files; skips completed migrations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'playtime-backup-'));
    const source = new Database(join(dir, 'db.sqlite'));
    const market = new Database(join(dir, 'market.sqlite'));
    try {
        source.exec(`CREATE TABLE hiscore(playtime INTEGER); INSERT INTO hiscore VALUES(100);
            CREATE TABLE hiscore_large(playtime INTEGER); INSERT INTO hiscore_large VALUES(200);
            CREATE TABLE _prisma_migrations(id TEXT, migration_name TEXT, finished_at TEXT, rolled_back_at TEXT);`);
        market.exec("PRAGMA journal_mode=WAL; CREATE TABLE accounts(owner TEXT,save BLOB); INSERT INTO accounts VALUES('a',x'010203')");
        mkdirSync(join(dir, 'players/main'), { recursive: true });
        writeFileSync(join(dir, 'players/main/a.sav'), new Uint8Array([1, 2, 3]));
        const backup = await backupPlaytimeMigration(dir);
        expect(backup).not.toBeNull();
        const scores = new Database(join(backup!, 'hiscores.sqlite'), { readonly: true });
        const checkpoints = new Database(join(backup!, 'market.sqlite'), { readonly: true });
        try {
            expect(scores.query('SELECT * FROM hiscore').get()).toEqual({ playtime: 100 });
            expect(checkpoints.query('SELECT hex(save) AS data FROM accounts').get()).toEqual({ data: '010203' });
        } finally { scores.close(); checkpoints.close(); }
        const archived = Bun.spawnSync(['tar', '-xOzf', join(backup!, 'players.tar.gz'), 'players/main/a.sav']);
        expect([...archived.stdout]).toEqual([1, 2, 3]);
        expect(JSON.parse(readFileSync(join(backup!, 'complete.json'), 'utf8')).counts.hiscore_large).toBe(1);
        source.exec("INSERT INTO _prisma_migrations VALUES('done','20261022000000_hiscore_playtime_ms','now',NULL)");
        expect(await backupPlaytimeMigration(dir)).toBeNull();
    } finally { source.close(); market.close(); rmSync(dir, { recursive: true, force: true }); }
});


test('normalization rescales all records uniformly and future tick rates require no data rewrite', () => {
    for (const [tickMs, hours] of [[300, 3], [400, 4], [600, 6]]) {
        expect(formatNormalizedPlaytime(36000, tickMs)).toContain(`${hours}h 00m 00s`);
        expect(formatNormalizedPlaytime(36000, tickMs)).toContain(`normalized to ${tickMs} ms per tick`);
    }
});

test('normalization index migration preserves tick counts and mixed-rate historical durations', () => {
    const db = new Database(':memory:');
    try {
        for (const table of ['hiscore', 'hiscore_large']) {
            db.exec(`CREATE TABLE ${table}(profile TEXT,type INTEGER,account_id INTEGER,level INTEGER,playtime INTEGER,playtime_ms BIGINT);
                INSERT INTO ${table} VALUES('main',1,1,99,200,25000),('main',1,2,99,100,30000);`);
        }
        const before = ['hiscore', 'hiscore_large'].map(table => db.query(`SELECT * FROM ${table}`).all());
        db.exec(readFileSync(new URL('../prisma/singleworld/migrations/20261022010000_hiscore_normalized_rank/migration.sql', import.meta.url), 'utf8'));
        for (const [i, table] of ['hiscore', 'hiscore_large'].entries()) {
            expect(db.query(`SELECT * FROM ${table}`).all()).toEqual(before[i]);
            expect(db.query(`SELECT account_id FROM ${table} ORDER BY level DESC,playtime ASC`).all()).toEqual([{account_id: 2}, {account_id: 1}]);
        }
    } finally { db.close(); }
});
