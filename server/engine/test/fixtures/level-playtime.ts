import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

class TestWorker extends EventEmitter { postMessage() {} }
mock.module('worker_threads', () => ({ Worker: TestWorker }));
await import('../../src/engine/World.js');
const { default: InvType } = await import('../../src/cache/config/InvType.js');
const { default: ObjType } = await import('../../src/cache/config/ObjType.js');
const { default: VarPlayerType } = await import('../../src/cache/config/VarPlayerType.js');
const { default: Player } = await import('../../src/engine/entity/Player.js');
const { PlayerLoading } = await import('../../src/engine/entity/PlayerLoading.js');
const { PlayerStat } = await import('../../src/engine/entity/PlayerStat.js');
const { default: Packet } = await import('../../src/io/Packet.js');
const { updateHiscores } = await import('../../src/server/login/LoginServer.js');
const { db } = await import('../../src/db/query.js');
InvType.load(process.env.BANK_TEST_CACHE!);
ObjType.load(process.env.BANK_TEST_CACHE!);
VarPlayerType.load(process.env.BANK_TEST_CACHE!);

const database = new Database('db.sqlite');
database.exec('CREATE TABLE hiscore (account_id INTEGER, profile TEXT, type INTEGER, level INTEGER, value INTEGER, playtime INTEGER DEFAULT 0, date TEXT)');
database.exec('CREATE TABLE hiscore_large (account_id INTEGER, profile TEXT, type INTEGER, level INTEGER, value INTEGER, playtime INTEGER DEFAULT 0, date TEXT)');
database.exec('CREATE TABLE hiscore_outfit (account_id INTEGER, profile TEXT, value INTEGER, items TEXT, appearance TEXT, date TEXT)');
database.exec('CREATE TABLE hiscore_bank (account_id INTEGER, profile TEXT, value INTEGER, items TEXT, date TEXT)');
for (const migration of ['20261011000000_hiscore_rank_indexes', '20261022000000_hiscore_playtime_ms']) {
    database.exec(readFileSync(new URL(`../../prisma/singleworld/migrations/${migration}/migration.sql`, import.meta.url), 'utf8'));
}
const account = { id: 1, staffmodlevel: 0, banned_until: null };
const row = (type: number) => database.query('SELECT level, playtime, playtime_ms FROM hiscore WHERE account_id=1 AND type=?').get(type) as { level: number; playtime: number; playtime_ms: number };
const total = () => database.query('SELECT level, playtime, playtime_ms FROM hiscore_large WHERE account_id=1 AND type=0').get() as { level: number; playtime: number; playtime_ms: number };
const reload = (player: InstanceType<typeof Player>) => PlayerLoading.load(player.username, new Packet(player.save(false)), null);

try {
    const player = reload(new Player('stamper', 1n, 1n));
    player.playtime = 1000; player.playtimeMs = 300000;
    player.addXp(PlayerStat.WOODCUTTING, 10_000_000, false);
    assert.equal(player.levelPlaytime[PlayerStat.WOODCUTTING], 1000);
    player.playtime = 1500; player.playtimeMs = 500000;
    player.addXp(PlayerStat.FISHING, 10_000_000, false);
    player.playtime = 9999; player.playtimeMs = 3899600; // keeps playing; logs out much later

    // The stamps survive a save round-trip and the boards record the level-up ticks, not logout.
    let saved = reload(player);
    assert.equal(saved.levelPlaytime[PlayerStat.WOODCUTTING], 1000);
    assert.equal(saved.levelPlaytime[PlayerStat.FISHING], 1500);
    await updateHiscores(account, saved, 'main');
    assert.equal(row(PlayerStat.WOODCUTTING + 1).playtime, 1000);
    assert.equal(row(PlayerStat.FISHING + 1).playtime, 1500);
    assert.equal(total().playtime, 1500);
    assert.equal(row(PlayerStat.WOODCUTTING + 1).playtime_ms, 300000);
    assert.equal(row(PlayerStat.FISHING + 1).playtime_ms, 500000);
    assert.equal(total().playtime_ms, 500000);

    // XP without a level-up keeps the earlier stamps.
    player.playtime = 20000; player.playtimeMs = 7899600;
    player.addXp(PlayerStat.WOODCUTTING, 1, false);
    await updateHiscores(account, reload(player), 'main');
    assert.equal(row(PlayerStat.WOODCUTTING + 1).playtime, 1000);
    assert.equal(total().playtime, 1500);
    assert.equal(row(PlayerStat.WOODCUTTING + 1).playtime_ms, 300000);
    assert.equal(row(PlayerStat.FISHING + 1).playtime_ms, 500000);
    assert.equal(total().playtime_ms, 500000);

    // Saves from before stamps existed fall back to logout playtime.
    const legacy = reload(new Player('legacy', 2n, 2n));
    legacy.baseLevels[PlayerStat.MINING] = 20;
    legacy.playtime = 4242; legacy.playtimeMs = 1272600;
    await updateHiscores({ ...account, id: 2 }, legacy, 'main');
    assert.equal((database.query('SELECT playtime FROM hiscore WHERE account_id=2 AND type=?').get(PlayerStat.MINING + 1) as { playtime: number }).playtime, 4242);
    assert.equal((database.query('SELECT playtime FROM hiscore_large WHERE account_id=2').get() as { playtime: number }).playtime, 4242);
    // Derive a real v9 binary (old layout + checksum), then load it with a
    // different current rate. Conversion must always use the frozen legacy 300ms.
    const oldSource = new Player('old', 3n, 3n);
    oldSource.playtime = 10000;
    oldSource.levelPlaytime[PlayerStat.MINING] = 6000;
    const v10 = oldSource.save(false);
    const old = new Packet(new Uint8Array(v10.length - 22 * 8));
    old.data.set(v10.subarray(0, old.data.length - 4));
    old.pos = 2; old.p2(9);
    old.pos = old.data.length - 4; old.p4(Packet.getcrc(old.data, 0, old.pos));
    assert.equal(PlayerLoading.verify(new Packet(old.data)), true);
    const converted = PlayerLoading.load('old', new Packet(old.data), null);
    assert.equal(converted.playtimeMs, 3000000);
    assert.equal(converted.levelPlaytimeMs[PlayerStat.MINING], 1800000);
    converted.advancePlaytime(400);
    converted.advancePlaytime(600);
    assert.equal(converted.playtime, 10002);
    assert.equal(converted.playtimeMs, 3001000);
    assert.equal(reload(reload(converted)).playtimeMs, 3001000, 'no double conversion');
    assert.equal(reload(converted).levelPlaytimeMs[PlayerStat.MINING], 1800000);
    converted.playtimeMs = 100 * 24 * 60 * 60 * 1000;
    converted.levelPlaytimeMs[PlayerStat.MINING] = converted.playtimeMs - 400;
    assert.equal(reload(converted).playtimeMs, converted.playtimeMs, 'duration exceeds signed 32-bit milliseconds');
    assert.equal(reload(converted).levelPlaytimeMs[PlayerStat.MINING], converted.levelPlaytimeMs[PlayerStat.MINING]);
    // Pre-v9 saves have no level stamps and must retain the logout-time fallback.
    const v8 = new Packet(new Uint8Array(old.data.length - 21 * 4));
    v8.data.set(old.data.subarray(0, v8.data.length - 4));
    v8.pos = 2; v8.p2(8);
    v8.pos = v8.data.length - 4; v8.p4(Packet.getcrc(v8.data, 0, v8.pos));
    const unstamped = PlayerLoading.load('unstamped', new Packet(v8.data), null);
    assert.equal(unstamped.playtimeMs, 3000000);
    assert.equal(unstamped.levelPlaytimeMs[PlayerStat.MINING], 0);
    console.log('Level playtime checks passed');
} finally {
    database.close();
    await db.destroy();
}
// World imports initialize recurring timers; this isolated fixture has completed.
process.exit(0);
