import { expect, test } from 'bun:test';
import { sampleStream, trial } from '../tools/bench/websocket-compression.js';

test('wire benchmark verifies complete messages for negotiated and legacy clients', async () => {
    const streams = [sampleStream(8)];
    const plain = await trial(streams, '256KB', false);
    expect(plain.responseExtensions).toBe('');
    expect(plain.frames).toBe(8);
    expect(plain.wireBytes).toBeGreaterThanOrEqual(plain.payloadBytes);
    expect(plain.wireBytes).toBeLessThan(plain.payloadBytes + 256);

    for (const compress of ['shared', '256KB'] as const) {
        const compressed = await trial(streams, compress);
        expect(compressed.frames).toBe(8);
        expect(compressed.responseExtensions).toContain('permessage-deflate');
        expect(compressed.wireBytes).toBeLessThan(plain.wireBytes);
    }
});
