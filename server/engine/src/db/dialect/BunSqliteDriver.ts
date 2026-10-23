// https://github.com/dylanblokhuis/kysely-bun-sqlite
import { Database, SQLiteError } from 'bun:sqlite';
import { CompiledQuery, DatabaseConnection, Driver, QueryResult } from 'kysely';
import { BunSqliteDialectConfig } from './BunSqliteDialectConfig.js';
import { sleep } from 'bun';

export class BunSqliteDriver implements Driver {
    readonly #config: BunSqliteDialectConfig;
    readonly #connectionMutex = new ConnectionMutex();

    #db?: Database;
    #connection?: DatabaseConnection;

    constructor(config: BunSqliteDialectConfig) {
        this.#config = { ...config };
    }

    async init(): Promise<void> {
        this.#db = this.#config.database;

        this.#connection = new BunSqliteConnection(this.#db);

        if (this.#config.onCreateConnection) {
            await this.#config.onCreateConnection(this.#connection);
        }
    }

    async acquireConnection(): Promise<DatabaseConnection> {
        // SQLite only has one single connection. We use a mutex here to wait
        // until the single connection has been released.
        await this.#connectionMutex.lock();
        return this.#connection!;
    }

    async beginTransaction(connection: DatabaseConnection): Promise<void> {
        await connection.executeQuery(CompiledQuery.raw('begin'));
    }

    async commitTransaction(connection: DatabaseConnection): Promise<void> {
        await connection.executeQuery(CompiledQuery.raw('commit'));
    }

    async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
        await connection.executeQuery(CompiledQuery.raw('rollback'));
    }

    async releaseConnection(): Promise<void> {
        this.#connectionMutex.unlock();
    }

    async destroy(): Promise<void> {
        this.#db?.close();
    }
}

class BunSqliteConnection implements DatabaseConnection {
    readonly #db: Database;

    constructor(db: Database) {
        this.#db = db;
    }

    async executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
        for (let retry = 0; retry < 3; retry++) {
            try {
                const { sql, parameters } = compiledQuery;
                const stmt = this.#db.prepare(sql);
                try {
                    if (stmt.columnNames.length > 0) {
                        return { rows: stmt.all(parameters as any) as O[] };
                    }

                    const results = stmt.run(parameters as any);
                    return {
                        insertId: BigInt(results.lastInsertRowid),
                        numAffectedRows: BigInt(results.changes),
                        rows: []
                    };
                } finally {
                    // prepare() is uncached. Its native bytecode and bound values can
                    // retain hundreds of MiB before JS GC notices these small wrappers.
                    // Release on success, query failure, and before every busy retry.
                    stmt.finalize();
                }
            } catch (err) {
                if (err instanceof SQLiteError && err.errno === 5) {
                    // database is locked, retry
                    await sleep(100);
                    continue;
                } else if (err instanceof SQLiteError) {
                    // query error
                    console.error(err.message);
                    break;
                } else {
                    console.error(err);
                    break;
                }
            }
        }

        console.warn('executeQuery failed');
        return Promise.resolve({
            insertId: 0n,
            numAffectedRows: 0n,
            rows: []
        });
    }

    async *streamQuery<R>(compiledQuery: CompiledQuery): AsyncIterableIterator<QueryResult<R>> {
        const { sql, parameters } = compiledQuery;
        const stmt = this.#db.prepare(sql);

        try {
            for (const row of stmt.iterate(parameters as any)) {
                yield { rows: [row as R] };
            }
        } finally {
            // Also runs when the consumer breaks out before exhausting the cursor.
            stmt.finalize();
        }
    }
}

class ConnectionMutex {
    #promise?: Promise<void>;
    #resolve?: () => void;

    async lock(): Promise<void> {
        while (this.#promise) {
            await this.#promise;
        }

        this.#promise = new Promise(resolve => {
            this.#resolve = resolve;
        });
    }

    unlock(): void {
        const resolve = this.#resolve;

        this.#promise = undefined;
        this.#resolve = undefined;

        resolve?.();
    }
}
