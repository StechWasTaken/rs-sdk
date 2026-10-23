import { networkPressure } from '../util/NetworkPressure.js';

type Downstream = { send(data: any, compress?: boolean): number; close(): void; terminate(): void; getBufferedAmount(): number };
type Upstream = Pick<WebSocket, 'readyState' | 'bufferedAmount' | 'send' | 'close' | 'onopen' | 'onmessage' | 'onclose' | 'onerror'> & { terminate?: () => void };
const MAX_PENDING_BYTES = 512 * 1024;
const MAX_PENDING_FRAMES = 64;

// Own both ends together. A late open or failed send must not leave a loopback
// socket pumping state into a dead downstream connection for another 30 seconds.
export class AgentRelay {
    private closed = false;
    private ready = false;
    private pending: string[] = [];
    private pendingBytes = 0;
    private timeout: ReturnType<typeof setTimeout>;

    constructor(private readonly downstream: Downstream, private readonly upstream: Upstream, compress: () => boolean) {
        networkPressure.register(downstream, 'relay-out', () => downstream.getBufferedAmount(), () => this.close(true));
        networkPressure.register(upstream, 'relay-in', () => upstream.bufferedAmount, () => this.close(true));
        this.timeout = setTimeout(() => this.close(true), 10_000);
        this.timeout.unref();
        upstream.onopen = () => {
            if (this.closed) return;
            this.ready = true;
            clearTimeout(this.timeout);
            const pending = this.pending;
            this.pending = [];
            this.pendingBytes = 0;
            for (const message of pending) this.message(message);
        };
        upstream.onmessage = event => {
            if (this.closed || !networkPressure.beforeSend(downstream)) return;
            try { networkPressure.afterSend(downstream, downstream.send(event.data, compress())); }
            catch { this.close(true); }
        };
        upstream.onclose = () => this.close(false);
        upstream.onerror = () => this.close(true);
    }

    message(message: string): void {
        if (this.closed) return;
        if (!this.ready) {
            // Count UTF-16 storage as well as frames, not only wire bytes.
            const bytes = message.length * 2;
            if (this.pending.length >= MAX_PENDING_FRAMES || this.pendingBytes + bytes > MAX_PENDING_BYTES) {
                this.close(true);
                return;
            }
            this.pending.push(message);
            this.pendingBytes += bytes;
            return;
        }
        if (this.upstream.readyState !== 1 || !networkPressure.beforeSend(this.upstream)) { this.close(true); return; }
        try {
            this.upstream.send(message);
            networkPressure.afterSend(this.upstream);
        } catch { this.close(true); }
    }

    close(force = true): void {
        if (this.closed) return;
        this.closed = true;
        clearTimeout(this.timeout);
        this.pending = [];
        this.pendingBytes = 0;
        networkPressure.remove(this.downstream);
        networkPressure.remove(this.upstream);
        this.upstream.onopen = this.upstream.onmessage = this.upstream.onclose = this.upstream.onerror = null;
        try {
            if (force && this.upstream.terminate) this.upstream.terminate(); else this.upstream.close();
        } catch { /* already closed */ }
        try { if (force) this.downstream.terminate(); else this.downstream.close(); } catch { /* already closed */ }
    }
}
