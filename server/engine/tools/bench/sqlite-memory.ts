// Run in a fresh process before/after changes: bun tools/bench/sqlite-memory.ts
// Update one row so database growth cannot explain retained process memory.
import { Database } from 'bun:sqlite';
import { CompiledQuery } from 'kysely';
import { BunSqliteDriver } from '../../src/db/dialect/BunSqliteDriver.js';

const database = new Database(':memory:');
database.run('CREATE TABLE sample (id INTEGER PRIMARY KEY, payload BLOB)');
database.run('INSERT INTO sample VALUES (1, zeroblob(32768))');
const driver = new BunSqliteDriver({ database });
await driver.init();
const connection = await driver.acquireConnection();
const payload = new Uint8Array(32768).fill(42);
const query = CompiledQuery.raw('UPDATE sample SET payload = ? WHERE id = 1', [payload]);
const start = process.memoryUsage().rss;
let peak = start;
const started = performance.now();
for (let i = 0; i < 6000; i++) {
    await connection.executeQuery(query);
    if (i % 100 === 0) peak = Math.max(peak, process.memoryUsage().rss);
}
peak = Math.max(peak, process.memoryUsage().rss);
console.log(JSON.stringify({ bun: Bun.version, queries: 6000, payloadBytes: payload.length,
    elapsedMs: Math.round(performance.now() - started), startRSSMiB: start / 1048576,
    peakRSSMiB: peak / 1048576, growthMiB: (peak - start) / 1048576,
    heapUsedMiB: process.memoryUsage().heapUsed / 1048576 }));
await driver.releaseConnection();
await driver.destroy();
