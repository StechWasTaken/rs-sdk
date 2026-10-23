import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database, SQLiteError, type Statement } from 'bun:sqlite';
import { CompiledQuery } from 'kysely';
import { BunSqliteDriver } from '../src/db/dialect/BunSqliteDriver.js';

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

async function setup() {
    const db = new Database(':memory:');
    databases.push(db);
    db.run('CREATE TABLE sample (id INTEGER PRIMARY KEY, payload BLOB)');
    const statements: Statement[] = [];
    const prepare = db.prepare.bind(db);
    spyOn(db, 'prepare').mockImplementation((...args) => {
        const statement = prepare(...args);
        statements.push(statement);
        return statement;
    });
    const driver = new BunSqliteDriver({ database: db });
    await driver.init();
    const connection = await driver.acquireConnection();
    return { db, driver, connection, statements };
}

test('queries release native statements while returned blobs and transaction semantics remain valid', async () => {
    const { driver, connection, statements } = await setup();
    await driver.beginTransaction(connection);
    const inserted = await connection.executeQuery(CompiledQuery.raw('INSERT INTO sample VALUES (?, ?)', [1, Uint8Array.of(4, 5, 6)]));
    expect(inserted.insertId).toBe(1n);
    expect(inserted.numAffectedRows).toBe(1n);
    const result = await connection.executeQuery<{ payload: Uint8Array }>(CompiledQuery.raw('SELECT payload FROM sample'));
    expect([...result.rows[0].payload]).toEqual([4, 5, 6]);
    await driver.rollbackTransaction(connection);
    expect((await connection.executeQuery(CompiledQuery.raw('SELECT * FROM sample'))).rows).toEqual([]);
    expect(statements.every(s => s.toString() === '')).toBe(true);
    expect([...result.rows[0].payload]).toEqual([4, 5, 6]);
    await driver.releaseConnection();
});

test('failed writes finalize their statement', async () => {
    const { connection, statements } = await setup();
    await connection.executeQuery(CompiledQuery.raw('INSERT INTO sample VALUES (1, NULL)'));
    const error = spyOn(console, 'error').mockImplementation(() => {});
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
        await connection.executeQuery(CompiledQuery.raw('INSERT INTO sample VALUES (1, NULL)'));
        expect(statements.length).toBe(2);
        expect(statements.every(s => s.toString() === '')).toBe(true);
    } finally { error.mockRestore(); warn.mockRestore(); }
});

test('busy retries finalize failed attempts before preparing another statement', async () => {
    const { db, connection } = await setup();
    // Use a real SQLite busy error from a second connection holding a write lock.
    const path = `/tmp/rs-sqlite-busy-${process.pid}-${crypto.randomUUID()}.sqlite`;
    const holder = new Database(path);
    const contender = new Database(path);
    holder.run('CREATE TABLE t (n INTEGER)');
    holder.run('BEGIN EXCLUSIVE');
    let busy: SQLiteError;
    try { contender.run('INSERT INTO t VALUES (1)'); throw Error('Expected lock'); }
    catch (err) { if (!(err instanceof SQLiteError)) throw err; busy = err; }
    finally {
        holder.run('ROLLBACK'); holder.close(); contender.close();
        (await import('node:fs')).unlinkSync(path);
    }
    let attempts = 0;
    const finalized: boolean[] = [];
    spyOn(db, 'prepare').mockImplementation(() => {
        if (attempts) expect(finalized[attempts - 1]).toBe(true);
        const index = attempts++;
        // Make an independent real statement so we exercise finalize even on failure.
        const stmt = new Database(':memory:'); databases.push(stmt);
        const s = stmt.prepare('SELECT 1 AS n');
        const release = s.finalize.bind(s);
        spyOn(s, 'finalize').mockImplementation(() => { release(); finalized[index] = true; });
        if (index === 0) spyOn(s, 'all').mockImplementation(() => { throw busy; });
        return s;
    });
    const result = await connection.executeQuery(CompiledQuery.raw('SELECT 1 AS n'));
    expect(result.rows).toEqual([{ n: 1 }]);
    expect(attempts).toBe(2);
    expect(finalized).toEqual([true, true]);
});

test('streaming releases the cursor on completion and early cancellation', async () => {
    const { connection, statements } = await setup();
    const query = CompiledQuery.raw('SELECT 1 AS n UNION ALL SELECT 2 AS n');
    for await (const result of connection.streamQuery(query)) {
        expect(result.rows).toEqual([{ n: 1 }]);
        break;
    }
    expect(statements.at(-1)!.toString()).toBe('');
    const rows = [];
    for await (const result of connection.streamQuery(query)) rows.push(...result.rows);
    expect(rows).toEqual([{ n: 1 }, { n: 2 }]);
    expect(statements.every(s => s.toString() === '')).toBe(true);
});
