import { parentPort } from 'node:worker_threads';
import { db } from '#/db/query.js';
import Environment from '#/util/Environment.js';
import { startMemoryDiagnostics } from '#/util/MemoryDiagnostics.js';

startMemoryDiagnostics('rankings');

// The general SQLite adapter logs errors and returns empty rows. Rankings must
// propagate failures instead, so an unavailable DB cannot erase a good snapshot.
const sqlite = Environment.db.backend !== 'sqlite' ? null : typeof Bun !== 'undefined'
    ? new (await import('bun:sqlite')).Database('db.sqlite', { readonly: true })
    : new (await import('node:sqlite')).DatabaseSync('db.sqlite', { readOnly: true });
sqlite?.exec('PRAGMA busy_timeout = 5000');

parentPort!.on('message', async ({ id, profile, category }) => {
    try {
        const table = category === 0 ? 'hiscore_large' : 'hiscore';
        let query = db.selectFrom(table).innerJoin('account', 'account.id', `${table}.account_id`)
            .select(['account.username', `${table}.level`, `${table}.playtime`])
            .where(`${table}.profile`, '=', profile).where(`${table}.type`, '=', category)
            .where('account.staffmodlevel', '<=', 1)
            .orderBy(`${table}.level`, 'desc').orderBy(`${table}.playtime`, 'asc');
        if (Environment.HISCORES_HIDDEN_NAMES.length) {
            query = query.where(eb => eb.not(eb(eb.fn('lower', ['account.username']), 'in', Environment.HISCORES_HIDDEN_NAMES)));
        }
        const compiled = query.compile();
        const statement = sqlite?.prepare(compiled.sql);
        try {
            const rows = statement ? statement.all(...compiled.parameters as any[]) : await query.execute();
            parentPort!.postMessage({ id, rows });
        } finally {
            if (statement && 'finalize' in statement) statement.finalize();
        }
    } catch (error) {
        parentPort!.postMessage({ id, error: String(error) });
    }
});
// Bun may drop messages sent while top-level async imports are still loading.
parentPort!.postMessage({ ready: true });
