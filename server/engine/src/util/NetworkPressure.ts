type Transport = { kind: string; buffered: () => number; terminate: () => void; bytes: number };

// Native WebSocket queues do not appear in the JS heap. Bun's default is 16 MiB
// per connection: a small group of slow readers can exhaust the whole game VM.
export class NetworkPressure {
    private readonly sockets = new Map<object, Transport>();
    private total = 0;
    private peak = 0;
    private closedForPressure = 0;
    private dropped = 0;
    private skippedStates = 0;

    constructor(readonly perSocket = 2 * 1024 * 1024, readonly aggregate = 64 * 1024 * 1024) {}

    register(key: object, kind: string, buffered: () => number, terminate: () => void): void {
        this.remove(key);
        this.sockets.set(key, { kind, buffered, terminate, bytes: 0 });
    }

    remove(key: object): void {
        const entry = this.sockets.get(key);
        if (!entry) return;
        this.total -= entry.bytes;
        this.sockets.delete(key);
    }

    private measure(entry: Transport): number {
        let bytes = 0;
        try { bytes = Math.max(0, entry.buffered()); } catch { /* closed socket */ }
        this.total += bytes - entry.bytes;
        entry.bytes = bytes;
        return bytes;
    }

    private close(key: object, entry: Transport): void {
        this.closedForPressure++;
        // Remove before terminate: the runtime may synchronously call close handlers.
        this.remove(key);
        try { entry.terminate(); } catch { /* already closed */ }
    }

    private enforce(): void {
        // Drain callbacks need not fire on client-side WebSockets. Refresh estimates
        // before evicting anything so already-drained connections are never punished.
        if (this.total <= this.aggregate) return;
        for (const entry of this.sockets.values()) this.measure(entry);
        this.peak = Math.max(this.peak, this.total);
        if (this.total <= this.aggregate) return;
        for (const [key, entry] of [...this.sockets].sort((a, b) => b[1].bytes - a[1].bytes)) {
            if (this.total <= this.aggregate * 0.75) break;
            if (entry.bytes > 0) this.close(key, entry);
        }
    }

    beforeSend(key: object): boolean {
        const entry = this.sockets.get(key);
        if (!entry) return false;
        if (this.measure(entry) > this.perSocket) { this.close(key, entry); return false; }
        this.enforce();
        return this.sockets.has(key);
    }

    afterSend(key: object, result?: number | void): void {
        const entry = this.sockets.get(key);
        if (!entry) return;
        if (result === 0) {
            // An ordered game/action stream cannot recover from a dropped frame.
            this.dropped++;
            this.close(key, entry);
            return;
        }
        const bytes = this.measure(entry);
        this.peak = Math.max(this.peak, this.total);
        if (bytes > this.perSocket) this.close(key, entry);
        this.enforce();
    }

    skipState(key: object): boolean {
        const entry = this.sockets.get(key);
        if (!entry) return true;
        // SDK states are complete snapshots; the next tick replaces a stale one.
        // Action results and other ordered messages always use before/afterSend.
        if (this.measure(entry) < 256 * 1024) return false;
        this.skippedStates++;
        return true;
    }

    stats() {
        const kinds: Record<string, { connections: number; bufferedBytes: number }> = {};
        for (const entry of this.sockets.values()) {
            const bytes = this.measure(entry);
            const kind = kinds[entry.kind] ??= { connections: 0, bufferedBytes: 0 };
            kind.connections++;
            kind.bufferedBytes += bytes;
        }
        return { connections: this.sockets.size, bufferedBytes: this.total, peakBufferedBytes: this.peak,
            closedForPressure: this.closedForPressure, droppedFrames: this.dropped, skippedStates: this.skippedStates,
            perSocketLimit: this.perSocket, aggregateLimit: this.aggregate, kinds };
    }
}

export const networkPressure = new NetworkPressure();
