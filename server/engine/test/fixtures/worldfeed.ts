// Run in a subprocess with WORLD_FEED=true and a temporary cwd; no worker or network service starts.
import { afterEach, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';

class TestWorker extends EventEmitter {
    postMessage() {}
}
mock.module('worker_threads', () => ({ Worker: TestWorker }));

const { default: World } = await import('../../src/engine/World.js');
const { NetworkPlayer } = await import('../../src/engine/entity/NetworkPlayer.js');
const { default: NullClientSocket } = await import('../../src/server/NullClientSocket.js');
const { Visibility } = await import('../../src/network/rsbuf/visibility.js');
const { checkWorldFeedUpgrade, cycleWorldFeed, onWorldFeedClose, onWorldFeedMessage, onWorldFeedOpen, getPlayerPositionsJson } = await import('../../src/web/worldfeed.js');

type Message = { t: string; [key: string]: any };

const viewers: { close: () => void }[] = [];

afterEach(() => {
    World.zonesTracking.clear();
    for (const v of viewers.splice(0)) {
        v.close();
    }
    for (const player of World.playerLoop.all()) {
        player.unlink();
    }
});

function viewer(area?: { x: number; z: number; w: number; h: number }) {
    const sent: string[] = [];
    const ws = { data: { isWorldFeed: true }, send: (msg: string) => sent.push(msg), getBufferedAmount: () => 0 } as any;
    onWorldFeedOpen(ws);
    if (area) {
        onWorldFeedMessage(ws, JSON.stringify({ t: 'sub', ...area }));
    }
    const v = {
        ws,
        sent,
        last: (): Message => JSON.parse(sent[sent.length - 1]),
        close: () => onWorldFeedClose(ws)
    };
    viewers.push(v);
    return v;
}

function addPlayer(slot: number, x: number, z: number) {
    const player = new NetworkPlayer('feed' + slot, BigInt(slot), BigInt(slot), new NullClientSocket());
    player.slot = slot;
    player.x = player.lastTickX = x;
    player.z = player.lastTickZ = z;
    player.level = player.lastLevel = 0;
    player.isActive = true;
    player.appearanceBuf = Uint8Array.of(0, 0, 1, 2, 3);
    World.playerLoop.add(BigInt(slot), player);
    World.players[slot] = player;
    return player;
}

// What the engine does between ticks: cleanup resets the per-tick state.
function endTick() {
    for (const player of World.playerLoop.all()) {
        player.lastTickX = player.x;
        player.lastTickZ = player.z;
        player.lastLevel = player.level;
        player.walkDir = player.runDir = -1;
        player.tele = player.jump = false;
        player.masks = 0;
    }
    World.currentTick++;
}

const AREA = { x: 3200, z: 3200, w: 64, h: 64 };

test('first sight, shared step deltas, hidden players and leaving the area', () => {
    World.currentTick = 1;
    const a = viewer(AREA);
    const b = viewer(AREA);
    const outside = viewer({ x: 0, z: 0, w: 8, h: 8 });
    expect(JSON.parse(a.sent[0])).toMatchObject({ t: 'hello', v: 1 });

    const player = addPlayer(5, 3210, 3210);
    const hidden = addPlayer(6, 3211, 3211);
    hidden.visibility = Visibility.HARD;

    cycleWorldFeed();
    expect(a.last().p).toEqual([{ i: 5, f: 1, x: 3210, z: 3210, l: 0, ap: Buffer.from([0, 0, 1, 2, 3]).toString('base64') }]);
    expect(outside.last().p).toBeUndefined();
    endTick();

    // Idle: a tick with nothing in it.
    cycleWorldFeed();
    expect(a.last()).toEqual({ t: 'tick', k: 2, ms: expect.any(Number) });
    endTick();

    // Runs two steps east then north-east: both viewers get the same steps.
    player.x = 3212;
    player.z = 3211;
    player.walkDir = 4;
    player.runDir = 2;
    cycleWorldFeed();
    expect(a.last().p).toEqual([{ i: 5, x: 3212, z: 3211, l: 0, m: [4, 2] }]);
    expect(a.sent[a.sent.length - 1]).toBe(b.sent[b.sent.length - 1]);
    endTick();

    // Teleports out of the subscribed area: removed.
    player.x = 3300;
    player.tele = true;
    cycleWorldFeed();
    expect(a.last().rp).toEqual([5]);
    expect(a.last().p).toBeUndefined();
});

test('roster lists visible players every few ticks', () => {
    World.currentTick = 10;
    const v = viewer();
    onWorldFeedMessage(v.ws, JSON.stringify({ t: 'roster', on: true }));
    const player = addPlayer(7, 3222, 3218);

    cycleWorldFeed();
    const roster = v.sent.map(s => JSON.parse(s)).find(m => m.t === 'roster');
    expect(roster.p).toEqual([[7, 'Feed7', 3222, 3218, 0, 3]]);
    expect(player.isActive).toBe(true);
});

test('upgrade checks the token when one is configured', () => {
    expect(checkWorldFeedUpgrade(new URL('http://localhost/worldfeed'))).toBeUndefined();
});


test('map snapshots are shared for a second and roster work runs every ten ticks', () => {
    const player = addPlayer(22, 3210, 3210);
    const first = getPlayerPositionsJson(1000);
    player.x++;
    expect(getPlayerPositionsJson(1999)).toBe(first);
    expect(JSON.parse(getPlayerPositionsJson(2000))[0].x).toBe(3211);
    const v = viewer();
    onWorldFeedMessage(v.ws, JSON.stringify({ t: 'roster', on: true }));
    World.currentTick = 15;
    cycleWorldFeed();
    expect(v.sent.some(s => JSON.parse(s).t === 'roster')).toBe(false);
    World.currentTick = 20;
    cycleWorldFeed();
    expect(v.last().t).toBe('roster');
});

test('zone membership stays cached until movement, map origin, plane or clear changes it', () => {
    const player = addPlayer(23, 3210, 3210);
    player.originX = player.x; player.originZ = player.z;
    const area = player.buildArea;
    let clears = 0;
    const clear = area.activeZones.clear.bind(area.activeZones);
    area.activeZones.clear = () => { clears++; clear(); };
    area.rebuildZones(); area.rebuildZones();
    player.x++; area.rebuildZones();
    expect(clears).toBe(1);
    player.x += 8; area.rebuildZones();
    player.originX += 8; area.rebuildZones();
    player.level++; area.rebuildZones();
    expect(clears).toBe(4);
    area.clear(false); area.rebuildZones();
    expect(clears).toBe(6);
    expect(area.activeZones.size).toBeGreaterThan(0);
});

test('loaded unchanged zones skip writes, new zones and private events retain delivery', () => {
    const player = addPlayer(24, 3210, 3210);
    const zone = World.gameMap.getZone(3210, 3210, 0);
    player.buildArea.activeZones.add(zone.index);
    const written: any[] = [];
    player.write = message => { written.push(message); };
    player.updateZones();
    expect(written.length).toBeGreaterThan(0); // First sight always sends a full update.
    written.length = 0;
    player.updateZones();
    expect(written).toEqual([]);
    const mine = { marker: 'mine' }, theirs = { marker: 'theirs' };
    // ZoneEventType.FOLLOWS = 1; use actual zone filtering with capture-only output.
    (zone as any).events.add({ type: 1, receiver64: player.hash64, message: mine });
    (zone as any).events.add({ type: 1, receiver64: 999n, message: theirs });
    World.trackZone(zone);
    player.updateZones();
    expect(written).toContain(mine);
    expect(written).not.toContain(theirs);
    zone.reset();
    player.buildArea.activeZones.clear(); player.updateZones();
    expect(player.buildArea.loadedZones.size).toBe(0);
});

test('stable areas visit only tracked zones, including private events, and fall back for busy ticks', () => {
    const player = addPlayer(25, 3240, 3240);
    player.originX = player.x; player.originZ = player.z;
    player.buildArea.rebuildZones();
    const written: any[] = [];
    player.write = message => { written.push(message); };
    player.updateZones();
    expect(player.buildArea.zonesChanged).toBe(false);
    expect(player.buildArea.loadedZones.size).toBe(49);
    const zone = World.gameMap.getZone(player.x, player.z, 0);
    const outside = World.gameMap.getZone(3400, 3400, 0);
    const mine = { marker: 'fast-private' }, theirs = { marker: 'fast-other' }, publicEvent = { marker: 'public' };
    (zone as any).events.add({ type: 1, receiver64: player.hash64, message: mine });
    (zone as any).events.add({ type: 1, receiver64: 999n, message: theirs });
    (zone as any).events.add({ type: 1, receiver64: -1n, message: publicEvent });
    (zone as any).shared = Uint8Array.of(1, 2, 3);
    World.trackZone(zone);
    World.trackZone(outside);
    written.length = 0;
    player.updateZones();
    const fast = [...written];
    expect(fast).toContain(mine);
    expect(fast).toContain(publicEvent);
    expect(fast[0].constructor.name).toBe('UpdateZonePartialEnclosed');
    expect(fast).not.toContain(theirs);
    // The previous full scan is also the fallback when many zones change.
    for (let i = 0; i < 60; i++) World.trackZone(World.gameMap.getZone(4000 + i * 8, 4000, 0));
    written.length = 0;
    player.updateZones();
    expect(written).toEqual(fast);
    for (const changed of World.zonesTracking) changed.reset();
    World.zonesTracking.clear();
    written.length = 0;
    player.updateZones();
    expect(written).toEqual([]);
});

test('zone movement, plane changes and reconnect rebuilds reload the required zones', () => {
    const player = addPlayer(26, 3240, 3240);
    player.originX = player.x; player.originZ = player.z;
    player.write = () => {};
    const area = player.buildArea;
    area.rebuildZones();
    player.updateZones();
    const previous = new Set(area.loadedZones);
    player.x += 8;
    area.rebuildZones();
    expect(area.zonesChanged).toBe(true);
    player.updateZones();
    expect(area.loadedZones).toEqual(area.activeZones);
    expect([...previous].some(index => !area.loadedZones.has(index))).toBe(true);
    player.level = 1;
    area.rebuildZones();
    player.updateZones();
    expect(area.loadedZones).toEqual(area.activeZones);
    expect([...area.loadedZones].every(index => index >>> 22 === 1)).toBe(true);
    area.rebuildNormal(true);
    expect(area.loadedZones.size).toBe(0);
    expect(area.zonesChanged).toBe(true);
    area.rebuildZones();
    player.updateZones();
    expect(area.loadedZones).toEqual(area.activeZones);
    expect(area.zonesChanged).toBe(false);
    area.clear(false);
    area.rebuildZones();
    player.updateZones();
    expect(area.loadedZones.size).toBeGreaterThan(0);
});
