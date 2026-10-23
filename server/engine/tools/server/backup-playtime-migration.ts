import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const migrationName = '20261022000000_hiscore_playtime_ms';

// Run with the engine stopped, before Prisma migrations. Back up the affected
// tables rather than the entire telemetry DB, plus both sources of player saves.
// Never restore these automatically: doing so after play resumes would lose progress.
export async function backupPlaytimeMigration(dataDirectory: string): Promise<string | null> {
    const directory = resolve(dataDirectory);
    const databasePath = join(directory, 'db.sqlite');
    if (!existsSync(databasePath)) return null; // fresh installation
    const db = new Database(databasePath);
    let backup: string;
    const counts: Record<string, number> = {};
    try {
        db.exec('PRAGMA busy_timeout = 10000');
        if (!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='hiscore'").get()) return null;
        const hasMigrations = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='_prisma_migrations'").get();
        if (hasMigrations && db.query('SELECT id FROM _prisma_migrations WHERE migration_name=? AND finished_at IS NOT NULL AND rolled_back_at IS NULL').get(migrationName)) return null;
        backup = join(directory, 'backups', `playtime-ms-${Date.now()}`);
        mkdirSync(backup, { recursive: true });
        db.query('ATTACH DATABASE ? AS playtime_backup').run(join(backup, 'hiscores.sqlite'));
        db.transaction(() => {
            for (const table of ['hiscore', 'hiscore_large', ...(hasMigrations ? ['_prisma_migrations'] : [])]) {
                db.exec(`CREATE TABLE playtime_backup.${table} AS SELECT * FROM main.${table}`);
                counts[table] = (db.query(`SELECT count(*) AS n FROM playtime_backup.${table}`).get() as { n: number }).n;
            }
        })();
        const check = db.query('PRAGMA playtime_backup.integrity_check').get() as { integrity_check: string };
        if (check.integrity_check !== 'ok') throw new Error('Highscore backup integrity check failed');
    } finally { db.close(); }
    const marketPath = join(directory, 'market.sqlite');
    if (existsSync(marketPath)) {
        const market = new Database(marketPath, { readonly: true });
        try { market.query('VACUUM INTO ?').run(join(backup!, 'market.sqlite')); }
        finally { market.close(); }
    }
    if (existsSync(join(directory, 'players'))) {
        const tar = Bun.spawn(['tar', '-czf', join(backup!, 'players.tar.gz'), '-C', directory, 'players'], { stdout: 'ignore', stderr: 'pipe' });
        const error = new Response(tar.stderr).text();
        if (await tar.exited !== 0) throw new Error(`Player backup failed: ${await error}`);
        await error;
    }
    await Bun.write(join(backup!, 'complete.json'), JSON.stringify({ at: new Date().toISOString(), migrationName, legacyTickMs: 300, counts,
        scope: 'Highscore tables and migration ledger, market checkpoints, player save files. Other main-DB tables are not modified by this migration.',
        rollback: 'Save version 10 requires the new loader. Do not deploy an old image against upgraded saves. Prefer a forward fix; an offline restoration of these snapshots would lose all progress since backup.'
    }, null, 2) + '\n');
    console.log(`[playtime-migration] backups complete: ${backup!}`);
    return backup!;
}

if (import.meta.main) await backupPlaytimeMigration(process.argv[2] ?? '/opt/server/data');
