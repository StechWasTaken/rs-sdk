import type { ServerWebSocket } from 'bun';
import World from '#/engine/World.js';
import OnDemand from '#/engine/OnDemand.js';
import { LoggerEventType } from '#/server/logger/LoggerEventType.js';
import NullClientSocket from '#/server/NullClientSocket.js';
import WSClientSocket from '#/server/ws/WSClientSocket.js';
import Environment from '#/util/Environment.js';
import { gatewayLabelQuery, getIp } from './utils.js';
import { checkWorldFeedUpgrade, isWorldFeedPath, onWorldFeedClose, onWorldFeedMessage, onWorldFeedOpen } from './worldfeed.js';
import { AgentRelay } from './AgentRelay.js';
import { networkPressure } from '#/util/NetworkPressure.js';

export type WebSocketData = {
    client: WSClientSocket,
    remoteAddress: string,
    isAgentProxy?: boolean,
    agentRelay?: AgentRelay,
    agentLabel?: string,
    isWorldFeed?: boolean
};


export function handleWebSocketUpgrade(
    req: Request,
    server: any,
    url: URL
): Response | undefined {
    const upgradeHeader = req.headers.get('upgrade');
    if (upgradeHeader?.toLowerCase() !== 'websocket') {
        return undefined;
    }

    // Gateway SDK WebSocket proxy endpoint
    if (url.pathname === '/gateway' || url.pathname === '/gateway/') {
        const upgraded = server.upgrade(req, {
            data: {
                client: new WSClientSocket(),
                remoteAddress: getIp(req),
                isAgentProxy: true,
                agentLabel: gatewayLabelQuery(req)
            }
        });

        if (upgraded) {
            return undefined;
        }
        return new Response(null, { status: 404 });
    }

    // Read-only live world feed for external viewers
    if (isWorldFeedPath(url.pathname)) {
        const refused = checkWorldFeedUpgrade(url);
        if (refused) {
            return refused;
        }

        const upgraded = server.upgrade(req, {
            data: {
                client: new WSClientSocket(),
                remoteAddress: getIp(req),
                isWorldFeed: true
            }
        });

        if (upgraded) {
            return undefined;
        }
        return new Response(null, { status: 404 });
    }

    // Regular client WebSocket
    if (url.pathname === '/' || url.pathname === '/bot' || url.pathname === '/bot/') {
        const upgraded = server.upgrade(req, {
            data: {
                client: new WSClientSocket(),
                remoteAddress: getIp(req)
            }
        });

        if (upgraded) {
            return undefined;
        }
        return new Response(null, { status: 404 });
    }

    return undefined;
}

export function handleGatewayEndpointGet(url: URL): Response | null {
    if (url.pathname === '/gateway' || url.pathname === '/gateway/') {
        return new Response('WebSocket endpoint for SDK connections', { status: 200 });
    }
    return null;
}

export const websocketHandlers = {
    // Negotiated for every socket (Bun can't opt out per upgrade), but only relay
    // frames are sent compressed; game packets go out as before. Clients that offer
    // the extension (browsers, Bun, Node ws) also compress what they publish.
    perMessageDeflate: true,
    backpressureLimit: 2 * 1024 * 1024,
    closeOnBackpressureLimit: true,
    open(ws: ServerWebSocket<WebSocketData>) {
        if (ws.data.isWorldFeed) {
            onWorldFeedOpen(ws);
            return;
        }

        // Handle agent SDK proxy connections
        if (ws.data.isAgentProxy) {
            // Always compress negotiated relay sockets, including during busy ticks.
            // Bun preserves uncompressed delivery for clients without the extension.
            ws.data.agentRelay = new AgentRelay(ws, new WebSocket(`ws://localhost:7780/${ws.data.agentLabel ?? ''}`), () => true);
            return;
        }

        ws.data.client.init(ws, ws.data.remoteAddress ?? ws.remoteAddress);
    },

    message(ws: ServerWebSocket<WebSocketData>, message: Buffer) {
        if (ws.data.isWorldFeed) {
            onWorldFeedMessage(ws, message);
            return;
        }

        // Handle agent SDK proxy connections
        if (ws.data.isAgentProxy) {
            try {
                ws.data.agentRelay?.message(message.toString());
            } catch (err) {
                console.error('Agent SDK proxy message error:', err);
                ws.close();
            }
            return;
        }

        try {
            const { client } = ws.data;
            if (client.state === -1 || client.remaining <= 0) {
                client.terminate();
                return;
            }

            client.buffer(message);

            if (client.state === 0) {
                World.onClientData(client);
            } else if (client.state === 2) {
                if (Environment.NODE_WS_ONDEMAND) {
                    OnDemand.onClientData(client);
                } else {
                    client.terminate();
                }
            }
        } catch (_) {
            ws.terminate();
        }
    },

    close(ws: ServerWebSocket<WebSocketData>) {
        networkPressure.remove(ws);
        if (ws.data.isWorldFeed) {
            onWorldFeedClose(ws);
            return;
        }

        // Handle agent SDK proxy connections
        if (ws.data.isAgentProxy) {
            ws.data.agentRelay?.close();
            ws.data.agentRelay = undefined;
            return;
        }

        const { client } = ws.data;
        client.state = -1;
        client.discard();
        OnDemand.onClientClosed(client);

        if (client.player && client.player.client === client) {
            client.player.addSessionLog(LoggerEventType.ENGINE, 'WS socket closed');
            client.player.client = new NullClientSocket();
        }
    }
};
