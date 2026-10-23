import { describe, expect, test } from 'bun:test';
import { BotSDK } from '../index';
import { BotActions } from '../actions';
import { executionContext, executionWait } from '../execution-context';
import { executeCode, BotExecutions, EXECUTE_CODE_OUTPUT_SCHEMA, type ExecuteCodeResult } from '../../mcp/execute-code';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { formatLogArgument, installExecutionConsoleCapture } from '../../mcp/console-capture';

function harness() {
    const sdk = new BotSDK({ botUsername: 'test', password: 'test', autoLaunchBrowser: false });
    const internal = sdk as any;
    const packets: any[] = [];
    internal.state = {
        inGame: true, tick: 1,
        player: { name: 'test', worldX: 3200, worldZ: 3200, x: 128, z: 128, level: 0, lifeId: 1, combat: { inCombat: false }, animId: -1, combatLevel: 3, hp: 10, maxHp: 10, runEnergy: 100, isDead: false },
        inventory: [], skills: [], gameMessages: [], nearbyLocs: [], nearbyNpcs: [], nearbyPlayers: [], groundItems: [],
        dialog: { isOpen: false }, interface: { isOpen: false }, bank: { isOpen: false }, shop: { isOpen: false },
    };
    internal.stateReceivedAt = Date.now();
    internal.connectionState = 'connected';
    internal.ws = { readyState: WebSocket.OPEN };
    internal.send = (message: any) => {
        packets.push(message);
        // Dispatch is acknowledged, but there is no movement/state update.
        queueMicrotask(() => internal.pendingActions.get(message.actionId)?.resolve({ success: true, message: 'dispatched' }));
    };
    sdk.sendFindPath = async () => ({ success: true, reachedDestination: true, waypoints: [{ x: 3208, z: 3200, level: 0 }] });
    const bot = new BotActions(sdk);
    const connection = { sdk, bot, username: 'test', connected: true, lastShownMessageTick: -1 };
    const manager = { get: () => connection, connect: async () => connection };
    return { sdk, bot, internal, packets, manager };
}

describe('execution cancellation', () => {
    test('cancels an internal walk wait, retains diagnostics, and allows the next execution', async () => {
        const h = harness();
        const result = await executeCode(h.manager, 'test', "console.log('walking started'); await bot.walkTo(3208, 3200);", 20);
        expect(result.isError).toBeTrue();
        expect(result.content[0]!.text).toContain('walking started');
        expect(result.content[0]!.text).toContain('bot.walkTo');
        expect(result.content[0]!.text).toContain('Position: (3200, 3200)');
        expect(h.internal.stateListeners.size).toBe(0);
        expect(h.internal.pendingActions.size).toBe(0);
        expect(h.packets).toHaveLength(1);
        const next = await executeCode(h.manager, 'test', 'return await sdk.sendWalk(3201, 3200);', 100);
        expect(next.isError).toBeUndefined();
        expect(h.packets).toHaveLength(2);
    });

    test('blocks dispatch from a detached continuation after its execution finishes', async () => {
        const h = harness();
        const controller = new AbortController();
        let release!: () => void;
        const paused = new Promise<void>(resolve => { release = resolve; });
        const old = executionContext.run({ signal: controller.signal }, async () => {
            await paused;
            return h.sdk.sendWalk(3210, 3200);
        });
        controller.abort(new Error('old execution cancelled'));
        release();
        await expect(old).rejects.toThrow('old execution cancelled');
        expect(h.packets).toHaveLength(0);
    });

    test('cancellation disposes state and dispatch waits without waiting for their timers', async () => {
        const h = harness();
        h.internal.send = (message: unknown) => h.packets.push(message);
        const controller = new AbortController();
        const scope = { signal: controller.signal };
        const waits = executionContext.run(scope, () => [h.sdk.waitForTicks(10), h.sdk.waitForCondition(() => false), h.sdk.sendWalk(3201, 3200)]);
        const settled = Promise.allSettled(waits);
        controller.abort(new Error('stop'));
        for (const result of await settled) {
            expect(result.status).toBe('rejected');
            if (result.status === 'rejected') expect(result.reason.message).toBe('stop');
        }
        expect(h.internal.stateListeners.size).toBe(0);
        expect(h.internal.pendingActions.size).toBe(0);
    });

    test('a newer call cancels the running one and starts after it unwinds', async () => {
        const executions = new BotExecutions();
        const order: string[] = [];
        const first = executions.run('Test', undefined, async controller => {
            order.push('first');
            await new Promise(resolve => controller.signal.addEventListener('abort', resolve));
            await Bun.sleep(5);
            order.push('first unwound');
            throw controller.signal.reason;
        });
        await Bun.sleep(1);
        const second = executions.run('test', undefined, async () => { order.push('second'); });
        await expect(first).rejects.toThrow('Superseded');
        await second;
        expect(order).toEqual(['first', 'first unwound', 'second']);
    });

    test('explicit client cancellation stops a running action', async () => {
        const h = harness();
        const controller = new AbortController();
        const work = executeCode(h.manager, 'test', 'await bot.walkTo(3208, 3200);', 1000, controller.signal);
        await new Promise(resolve => setTimeout(resolve, 5));
        controller.abort(new Error('client interrupted'));
        const result = await work;
        expect(result.isError).toBeTrue();
        expect(result.content[0]!.text).toContain('client interrupted');
        expect(h.internal.stateListeners.size).toBe(0);
        expect(h.packets).toHaveLength(1);
    });

    test('a newer execute_code supersedes a running walk without overlapping it', async () => {
        const h = harness();
        const executions = new BotExecutions();
        const first = executeCode(h.manager, 'test', 'await bot.walkTo(3208, 3200);', 1000, undefined, executions);
        await Bun.sleep(5);
        const second = executeCode(h.manager, 'test', 'return await sdk.sendWalk(3210, 3200);', 1000, undefined, executions);
        const [old, next] = await Promise.all([first, second]);
        expect(old.isError).toBeTrue();
        expect(old.content[0]!.text).toContain('Superseded');
        expect(next.isError).toBeUndefined();
        expect(h.packets).toHaveLength(2);
        expect(h.internal.stateListeners.size).toBe(0);
    });

    test('disconnect supersedes the running execution', async () => {
        const h = harness();
        const executions = new BotExecutions();
        const work = executeCode(h.manager, 'test', 'await bot.walkTo(3208, 3200);', 1000, undefined, executions);
        await Bun.sleep(5);
        let disconnected = false;
        await executions.run('TEST', undefined, async () => { disconnected = true; });
        const result = await work;
        expect(disconnected).toBeTrue();
        expect(result.isError).toBeTrue();
        expect(result.content[0]!.text).toContain('Superseded');
    });

    test('cancelled code that swallows errors parks instead of starving the event loop', async () => {
        const h = harness();
        const started = Date.now();
        let timerLag = -1;
        setTimeout(() => { timerLag = Date.now() - started; }, 20);
        const result = await executeCode(h.manager, 'test',
            'while (true) { try { await sdk.waitForTicks(1); } catch {} }', 10);
        expect(result.content[0]!.text).toContain('timed out');
        await Bun.sleep(40);
        expect(timerLag).toBeGreaterThan(0);
        expect(timerLag).toBeLessThan(200);
    });

    test('concurrent bots keep their SDK logs in their own execution', async () => {
        const a = harness();
        const b = harness();
        a.sdk.sendWait = async () => { console.log('SDK alpha'); await Bun.sleep(10); return { success: true, message: 'alpha' }; };
        b.sdk.sendWait = async () => { console.log('SDK beta'); await Bun.sleep(5); return { success: true, message: 'beta' }; };
        const restore = installExecutionConsoleCapture();
        try {
            const [first, second] = await Promise.all([
                executeCode(a.manager, 'alpha', 'await sdk.sendWait();', 100),
                executeCode(b.manager, 'beta', 'await sdk.sendWait();', 100),
            ]);
            expect(first.content[0]!.text).toContain('SDK alpha');
            expect(first.content[0]!.text).not.toContain('SDK beta');
            expect(second.content[0]!.text).toContain('SDK beta');
            expect(second.content[0]!.text).not.toContain('SDK alpha');
        } finally { restore(); }
    });

    test('TypeScript annotations are stripped and user-code errors retain their logs', async () => {
        const h = harness();
        const result = await executeCode(h.manager, 'test', "const pattern: RegExp = /copper ore/i; console.log(pattern); throw new Error('diagnostic failure');", 100);
        expect(result.isError).toBeTrue();
        expect(result.content[0]!.text).toContain('/copper ore/i');
        expect(result.content[0]!.text).toContain('diagnostic failure');
    });

    test('cleans a wait even if its setup completes synchronously', async () => {
        let cleaned = false;
        expect(await executionWait<number>(resolve => { resolve(7); return () => { cleaned = true; }; })).toBe(7);
        expect(cleaned).toBeTrue();
    });

    test('formats regexes and redacts credentials without losing useful diagnostics', () => {
        expect(formatLogArgument(/copper ore/i)).toBe('/copper ore/i');
        const log = formatLogArgument({ pattern: /^iron ore$/, url: 'https://example.com/bot?bot=test&password=abc123' });
        expect(log).toContain('/^iron ore$/');
        expect(log).toContain('password=[REDACTED]');
        expect(log).not.toContain('abc123');
    });

    test('walk deadlines terminate an otherwise stalled helper', async () => {
        const h = harness();
        const result = await h.bot.walkTo(3208, 3200, 0, { timeout: 15 });
        expect(result).toMatchObject({ success: false, reason: 'timeout' });
        expect(h.internal.stateListeners.size).toBe(0);
        expect(h.packets).toHaveLength(1);
    });

    test('does not send movement packets when no fresh state can be obtained', async () => {
        const h = harness();
        h.internal.stateReceivedAt = Date.now() - 20_000;
        h.sdk.waitForStateChange = async () => { throw new Error('No state'); };
        const result = await h.bot.walkTo(3208, 3200);
        expect(result).toMatchObject({ success: false, reason: 'stale_state' });
        expect(h.packets).toHaveLength(0);
    });

    test('MCP warns about stale state but still runs the code', async () => {
        const h = harness();
        h.internal.stateReceivedAt = Date.now() - 20_000;
        h.sdk.waitForStateChange = async () => { throw new Error('No fresh state'); };
        const result = await executeCode(h.manager, 'test', 'return sdk.getStateAge() > 10_000;', 100);
        expect(result.isError).toBeUndefined();
        expect(result.content[0]!.text).toContain('[warn] No fresh in-game state (No fresh state)');
        expect(result.content[0]!.text).toContain('── Result ──\ntrue');
    });

    test('MCP keeps the existing brief world-state output', async () => {
        const h = harness();
        h.internal.state.skills = [{ name: 'Attack', level: 1, baseLevel: 1, experience: 0 }];
        const result = await executeCode(h.manager, 'test', 'return "ok";', 100);
        expect(result.content[0]!.text).toContain('Position: (3200, 3200)');
        expect(result.content[0]!.text).not.toContain('Attack: 1 (0 xp)');
    });
});

/** The shipped schema is lenient; a strict copy catches fields the summary gained or lost without the schema. */
function strict(schema: any): any {
    if (Array.isArray(schema)) return schema.map(strict);
    if (!schema || typeof schema !== 'object') return schema;
    const copy = Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, strict(value)]));
    return copy.type === 'object' && copy.properties ? { ...copy, additionalProperties: false } : copy;
}
const validate = new AjvJsonSchemaValidator().getValidator(strict(EXECUTE_CODE_OUTPUT_SCHEMA));
const structured = (result: { structuredContent?: unknown }) => {
    const check = validate(result.structuredContent);
    if (!check.valid) throw new Error(`structuredContent violates the output schema: ${check.errorMessage}`);
    return result.structuredContent as ExecuteCodeResult;
};

describe('execute_code structured results', () => {
    test('a full world summary matches the output schema', async () => {
        const h = harness();
        h.internal.state.skills = [{ name: 'Attack', level: 1, baseLevel: 1, experience: 0 }];
        h.internal.state.inventory = [{ slot: 0, id: 1511, name: 'Logs', count: 1, optionsWithIndex: [] }];
        h.internal.state.nearbyNpcs = Array.from({ length: 12 }, (_, i) => ({
            kind: 'npc', id: 1, index: i, name: 'Man', combatLevel: 2, x: 3201, z: 3200, distance: 1,
            hp: null, maxHp: null, inCombat: false, options: ['Talk-to'], reachable: true,
        }));
        h.internal.state.nearbyLocs = [{ id: 1276, name: 'Tree', x: 3202, z: 3200, level: 0, distance: 2, options: ['Chop down'] }];
        h.internal.state.dialog = { isOpen: true, isWaiting: false, text: 'Hello', options: [{ index: 1, text: 'Yes' }] };
        h.internal.state.interface = { isOpen: true, interfaceId: 2400, options: [{ index: 1, text: 'Make', componentId: 2401 }] };
        h.internal.state.gameMessages = [
            { type: 0, text: 'You can\'t reach that!', sender: '', tick: 1, fromSelf: false },
            { type: 3, text: '@red@hi', sender: 'friend', tick: 1, fromSelf: false },
        ];

        const brief = structured(await executeCode(h.manager, 'test', 'return { n: 1 };', 100));
        expect(brief).toMatchObject({ ok: true, result: { n: 1 }, error: null });
        expect(brief.world!.nearby.npcs).toMatchObject({ total: 12 });
        expect(brief.world!.nearby.npcs.items).toHaveLength(10);
        expect(brief.world!.messages).toEqual({ chat: [{ from: 'friend', text: 'hi', private: true }], system: ['You can\'t reach that!'] });
        expect(brief.world!.modal).toEqual({ kind: 'interface', interfaceId: 2400, options: [{ componentId: 2401, text: 'Make' }] });

        const full = structured(await executeCode(h.manager, 'test', 'return null;', 100, undefined, undefined, { world: 'full' }));
        expect(full.world!.nearby.npcs.items).toHaveLength(12);
        expect(full.world!.messages.system).toEqual([]); // already shown by the previous call
    });

    test('args reach the code and may be redeclared', async () => {
        const h = harness();
        const result = structured(await executeCode(h.manager, 'test', 'const args2 = args; { const args = 1; } return [args2.x, typeof bot.walkTo];', 100, undefined, undefined, { args: { x: 5 } }));
        expect(result.result).toEqual([5, 'function']);
        const shadow = structured(await executeCode(h.manager, 'test', 'const args = "mine"; return args;', 100, undefined, undefined, { args: 1 }));
        expect(shadow.result).toBe('mine');
    });

    test('world: none omits the snapshot', async () => {
        const h = harness();
        const result = await executeCode(h.manager, 'test', 'return 1;', 100, undefined, undefined, { world: 'none' });
        expect(structured(result).world).toBeNull();
        expect(result.content[0]!.text).not.toContain('World State');
    });

    test('errors carry a kind', async () => {
        const h = harness();
        const kind = async (...call: Parameters<typeof executeCode>) => {
            const result = await executeCode(...call);
            expect(result.isError).toBeTrue();
            return structured(result).error!.kind;
        };
        expect(await kind(h.manager, 'test', "throw new Error('boom');", 100)).toBe('exception');
        expect(await kind(h.manager, 'test', 'await bot.walkTo(3208, 3200);', 20)).toBe('timeout');
        expect(await kind(h.manager, 'test', 'return 10n;', 100)).toBe('unserializable_result');
        const down = { get: () => undefined, connect: async () => { throw new Error('no bot.env'); } };
        expect(await kind(down, 'test', 'return 1;', 100)).toBe('not_connected');
        const controller = new AbortController();
        const cancelled = kind(h.manager, 'test', 'await bot.walkTo(3208, 3200);', 1000, controller.signal);
        await Bun.sleep(5);
        controller.abort();
        expect(await cancelled).toBe('cancelled');

        const executions = new BotExecutions();
        const first = kind(h.manager, 'test', 'await bot.walkTo(3208, 3200);', 1000, undefined, executions);
        await Bun.sleep(5);
        const second = executeCode(h.manager, 'test', 'return 1;', 1000, undefined, executions);
        expect(await first).toBe('superseded');
        expect(structured(await second).ok).toBeTrue();
    });

    test('results are redacted as data, not as text', async () => {
        const h = harness();
        const result = structured(await executeCode(h.manager, 'test', 'return { url: "wss://h/x?password=hunter2", password: "p", note: "a@b:c" };', 100));
        expect(result.result).toEqual({ url: 'wss://h/x?password=[REDACTED]', password: '[REDACTED]', note: 'a@b:c' });
    });

    test('runs a script module and refuses a bare runScript file', async () => {
        const h = harness();
        const dir = mkdtempSync(join(tmpdir(), 'exec-script-'));
        const good = join(dir, 'good.ts');
        writeFileSync(good, 'export default async ({ sdk, args }: any) => ({ age: typeof sdk.getStateAge(), doubled: args * 2 });\n');
        expect(structured(await executeCode(h.manager, 'test', { script: good }, 100, undefined, undefined, { args: 21 })).result).toEqual({ age: 'number', doubled: 42 });

        writeFileSync(good, 'export default async () => "edited";\n');
        expect(structured(await executeCode(h.manager, 'test', { script: good }, 100)).result).toBe('edited');

        const bare = join(dir, 'bare.ts');
        writeFileSync(bare, 'import { runScript } from "x";\nrunScript(async () => {});\n');
        const refused = structured(await executeCode(h.manager, 'test', { script: bare }, 100));
        expect(refused.error).toMatchObject({ kind: 'invalid_input' });
        expect(structured(await executeCode(h.manager, 'test', { script: join(dir, 'missing.ts') }, 100)).error).toMatchObject({ kind: 'invalid_input' });
    });
});
