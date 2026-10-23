import { networkPressure } from '../util/NetworkPressure.js';

type Payload = string | Buffer;
// The engine's pinned DOM types predate Bun's nodebuffer WebSocket extension.
export type UpstreamSocket = Omit<WebSocket, 'binaryType'> & { binaryType: BinaryType | 'nodebuffer' };
type Downstream = {
    send(data: Payload, compress?: boolean): number;
    close(code?: number, reason?: string): void;
    terminate(): void;
    getBufferedAmount(): number;
};

// Ordered frames (game packets and spectator deltas) must never be discarded.
// Close slow connections so clients reconnect/resync instead of growing queues.
export class WebSocketBridge {
    private closed = false;
    private ready = false;
    private pending: Payload[] = [];
    private pendingBytes = 0;
    private readonly timeout: ReturnType<typeof setTimeout>;

    constructor(private downstream: Downstream, private upstream: UpstreamSocket, private compress: boolean) {
        networkPressure.register(downstream, 'transport-out', () => downstream.getBufferedAmount(), () => this.close(true));
        networkPressure.register(upstream, 'transport-in', () => upstream.bufferedAmount, () => this.close(true));
        upstream.binaryType = 'nodebuffer';
        this.timeout = setTimeout(() => this.close(true), 10000);
        this.timeout.unref();
        upstream.onopen = () => {
            if (this.closed) return;
            this.ready = true;
            clearTimeout(this.timeout);
            const pending = this.pending;
            this.pending = [];
            this.pendingBytes = 0;
            for (const frame of pending) this.message(frame);
        };
        upstream.onmessage = event => {
            if (this.closed || !networkPressure.beforeSend(downstream)) return;
            try { networkPressure.afterSend(downstream, downstream.send(event.data as Payload, this.compress)); }
            catch { this.close(true); }
        };
        upstream.onclose = event => this.close(false, event.code, event.reason);
        upstream.onerror = () => this.close(true);
    }

    message(frame: Payload): void {
        if (this.closed) return;
        if (!this.ready) {
            // Count retained memory, including UTF-16 strings, not just wire bytes.
            const bytes = typeof frame === 'string' ? frame.length * 2 : frame.byteLength;
            if (this.pending.length >= 64 || this.pendingBytes + bytes > 512 * 1024) { this.close(true); return; }
            this.pending.push(typeof frame === 'string' ? frame : Buffer.from(frame));
            this.pendingBytes += bytes;
            return;
        }
        if (this.upstream.readyState !== WebSocket.OPEN || !networkPressure.beforeSend(this.upstream)) { this.close(true); return; }
        try {
            this.upstream.send(frame);
            networkPressure.afterSend(this.upstream);
        } catch { this.close(true); }
    }

    close(force = true, code = 1000, reason = ''): void {
        if (this.closed) return;
        this.closed = true;
        clearTimeout(this.timeout);
        this.pending = [];
        this.pendingBytes = 0;
        networkPressure.remove(this.downstream);
        networkPressure.remove(this.upstream);
        this.upstream.onopen = this.upstream.onmessage = this.upstream.onclose = this.upstream.onerror = null;
        // 1005/1006/1015 are observations, not legal close-frame status codes.
        const sendCode = (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999) ? code : 1000;
        try { if (force) this.upstream.terminate(); else this.upstream.close(sendCode, reason); } catch { /* already closed */ }
        try { if (force) this.downstream.terminate(); else this.downstream.close(sendCode, reason); } catch { /* already closed */ }
    }
}
