import { WebSocketBridge, type UpstreamSocket } from './WebSocketBridge.js';
import { gatewayLabelQuery, getIp } from './utils.js';
import { TRANSPORT_KEY, TRANSPORT_PEER } from './transportAuth.js';

export interface WebTransportOptions {
    port: number;
    hostname?: string;
    engineOrigin: string;
    gatewayOrigin: string;
    secret: string;
    behindFly: boolean;
    worldFeed: { enabled: boolean; token: string; maxClients: number };
}
type SocketData = { url: string; headers: Record<string, string>; compress: boolean; feed: boolean; bridge?: WebSocketBridge };
// Bun accepts these connection options; the engine's pinned types still expose
// only the browser constructor. Keep the runtime extension narrowly typed.
const BunWebSocket = WebSocket as unknown as {
    new(url: string, options: { headers: Record<string, string>; perMessageDeflate: boolean }): UpstreamSocket;
};

function stripHopHeaders(headers: Headers): void {
    for (const name of (headers.get('connection') ?? '').split(',')) if (name.trim()) headers.delete(name.trim());
    for (const name of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']) headers.delete(name);
}

export function startWebTransportServer(options: WebTransportOptions) {
    let feeds = 0;
    return Bun.serve<SocketData, {}>({
        hostname: options.hostname ?? '0.0.0.0', port: options.port,
        // Match the engine's default request limit; stream bodies instead of buffering.
        maxRequestBodySize: 128 * 1024 * 1024,
        async fetch(req, server) {
            const url = new URL(req.url);
            const headers = new Headers(req.headers);
            const peer = getIp(req, options.behindFly) ?? server.requestIP(req)?.address ?? '';
            stripHopHeaders(headers);
            headers.set(TRANSPORT_KEY, options.secret);
            headers.set(TRANSPORT_PEER, peer);
            // Outside Fly, arbitrary client-supplied Fly headers have no authority.
            if (!options.behindFly) { headers.delete('fly-region'); headers.delete('fly-client-ip'); }
            if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
                const gateway = /^\/gateway\/?$/.test(url.pathname);
                const feed = /^\/worldfeed\/?$/.test(url.pathname);
                const game = url.pathname === '/' || /^\/bot\/?$/.test(url.pathname);
                if (!gateway && !feed && !game) return new Response(null, { status: 404 });
                if (feed) {
                    if (!options.worldFeed.enabled) return new Response('World feed disabled', { status: 404 });
                    if (options.worldFeed.token && url.searchParams.get('token') !== options.worldFeed.token) return new Response('Forbidden', { status: 403 });
                    if (feeds >= options.worldFeed.maxClients) return new Response('Too many world feed clients', { status: 503 });
                }
                // New handshake, with no loopback compression. Never copy client keys
                // or extension negotiation into the independently owned upstream socket.
                for (const name of [...headers.keys()]) if (name.startsWith('sec-websocket-')) headers.delete(name);
                const destination = gateway
                    ? options.gatewayOrigin + '/' + gatewayLabelQuery(new Request(req.url, { headers }))
                    : options.engineOrigin.replace(/^http/, 'ws') + url.pathname + url.search;
                if (feed) feeds++;
                const upgraded = server.upgrade(req, { data: { url: destination, headers: Object.fromEntries(headers), compress: gateway || feed, feed } });
                if (upgraded) return;
                if (feed) feeds--;
                return new Response('WebSocket upgrade failed', { status: 400 });
            }
            // HTTP remains served by the engine. Preserve redirects, content encoding,
            // cookies, query strings and streamed request/response bodies.
            server.timeout(req, 60);
            try {
                const requestOptions = {
                    method: req.method, headers, body: req.body, signal: req.signal,
                    redirect: 'manual' as const, decompress: false
                };
                const response = await fetch(options.engineOrigin + url.pathname + url.search, requestOptions);
                const responseHeaders = new Headers(response.headers);
                stripHopHeaders(responseHeaders);
                return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
            } catch {
                return new Response('Upstream unavailable', { status: 502 });
            }
        },
        websocket: {
            perMessageDeflate: true,
            backpressureLimit: 2 * 1024 * 1024,
            closeOnBackpressureLimit: true,
            open(ws) {
                try {
                    const upstream = new BunWebSocket(ws.data.url, { headers: ws.data.headers, perMessageDeflate: false });
                    ws.data.bridge = new WebSocketBridge(ws, upstream, ws.data.compress);
                } catch { ws.terminate(); }
            },
            message(ws, message) { ws.data.bridge?.message(message); },
            close(ws, code, reason) {
                if (ws.data.feed) feeds--;
                ws.data.bridge?.close(false, code, reason);
                ws.data.bridge = undefined;
            }
        }
    });
}
