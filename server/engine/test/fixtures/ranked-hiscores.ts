import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { db } from '../../src/db/query.js';
import { loadRankedList } from '../../src/web/pages/RankedHiscores.js';
import { handleHiscoresPlayerPage, handleHiscoresPage, getRankedList } from '../../src/web/pages/hiscores.js';

const database = new Database('db.sqlite');
database.exec(`CREATE TABLE account(id INTEGER PRIMARY KEY,username TEXT,staffmodlevel INTEGER);
    CREATE TABLE hiscore(profile TEXT,account_id INTEGER,type INTEGER,level INTEGER,value INTEGER,playtime INTEGER);
    CREATE TABLE hiscore_large(profile TEXT,account_id INTEGER,type INTEGER,level INTEGER,value INTEGER,playtime INTEGER);
    INSERT INTO account VALUES(1,'Alice',0),(2,'Bob',0),(3,'hidden',0),(4,'staff',2);
    INSERT INTO hiscore_large VALUES('main',1,0,100,1,200),('main',2,0,100,1,100),('main',3,0,999,1,1),('main',4,0,999,1,1),('iron',1,0,200,1,1),('iron',2,0,100,1,1);
    INSERT INTO hiscore SELECT profile,account_id,1,level,value,playtime FROM hiscore_large;
    INSERT INTO hiscore SELECT profile,account_id,100,level,value,playtime FROM hiscore_large;`);

for (const migration of ['20261011000000_hiscore_rank_indexes', '20261022000000_hiscore_playtime_ms', '20261022010000_hiscore_normalized_rank']) {
    database.exec(readFileSync(new URL(`../../prisma/singleworld/migrations/${migration}/migration.sql`, import.meta.url), 'utf8'));
}

const rank = async (name: string, profile = 'main') => {
    const response = await handleHiscoresPlayerPage(new URL(`http://localhost/hiscores/player/${name}?profile=${profile}`));
    assert.ok(response);
    const html = await response.text();
    return { status: response.status, html, rank: html.match(/>Overall<\/a><\/td>\s*<td align="right">(\d+)<\/td>/)?.[1] };
};
try {
    assert.equal((await rank('Alice')).rank, '2');
    assert.ok((await rank('Alice')).html.includes('1m 20s'), 'legacy 200 ticks normalize to 80 seconds at 400ms');
    assert.equal((await rank('Bob')).rank, '1');
    assert.equal((await rank('Alice', 'iron')).rank, '1');
    assert.ok((await rank('Alice', 'iron')).html.includes('1 ticks normalized to 400 ms per tick'));
    assert.equal(((await rank('Alice')).html.match(/200 ticks normalized to 400 ms per tick/g) || []).length, 3, 'overall, skill and quest stamps use the same pace');
    assert.equal((await rank('hidden')).status, 404);
    assert.equal((await rank('staff')).status, 404);
    database.exec("UPDATE hiscore_large SET playtime_ms=25000 WHERE account_id=1 AND profile='main'");
    assert.equal((await loadRankedList('main', 0))[0].username, 'Bob', 'historical duration does not bias normalized tick rankings');
    assert.ok((await rank('Alice')).html.includes('1m 20s'), 'mixed-rate duration does not affect display');
    for (const path of ['/hiscores', '/hiscores?category=1', '/hiscores?category=100', '/hiscores?player=alice']) {
        const response = await handleHiscoresPage(new URL(`http://localhost${path}`));
        assert.ok(response);
        const html = await response.text();
        assert.ok(html.includes('1m 20s'), `${path} normalizes Alice's time`);
        assert.ok(html.includes('200 ticks normalized to 400 ms per tick'));
    }
    database.exec("UPDATE hiscore_large SET playtime_ms=60000 WHERE account_id=1 AND profile='main'");
    database.exec("UPDATE hiscore_large SET level=300 WHERE account_id=1 AND profile='main'");
    assert.equal((await rank('Alice')).rank, '2', 'Existing cached snapshot remains consistent');
    const now = Date.now;
    const future = now() + 60001;
    try {
        Date.now = () => future;
        assert.equal((await rank('Alice')).rank, '2', 'Serve the old complete snapshot during refresh');
        for (let i = 0; i < 100 && (await rank('Alice')).rank !== '1'; i++) await Bun.sleep(10);
        assert.equal((await rank('Alice')).rank, '1', 'Background refresh builds a fresh rank index');
        assert.equal((await rank('Bob')).rank, '2');
        database.exec('DROP TABLE hiscore_large');
        await assert.rejects(loadRankedList('main', 0));
        Date.now = () => future + 60001;
        assert.equal((await getRankedList('main', 0))[0].username, 'Alice', 'Refresh failure retains the complete snapshot');
        await assert.rejects(loadRankedList('main', 0));
        assert.equal((await getRankedList('main', 0))[1].username, 'Bob');
    } finally {
        Date.now = now;
    }
} finally {
    database.close();
    await db.destroy();
}
