import { parentPort, workerData } from 'node:worker_threads';
import { startWebTransportServer, type WebTransportOptions } from './WebTransportServer.js';
import { startMemoryDiagnostics } from '../util/MemoryDiagnostics.js';

if (!parentPort) throw new Error('Web transport must run in a worker');
const server = startWebTransportServer(workerData as WebTransportOptions);
startMemoryDiagnostics('web-transport', () => ({ requests: server.pendingRequests, websockets: server.pendingWebSockets }));
parentPort.postMessage({ type: 'ready', port: server.port });
