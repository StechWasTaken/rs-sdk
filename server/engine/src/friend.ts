import { FriendServer } from '#/server/friend/FriendServer.js';
import { startMemoryDiagnostics } from '#/util/MemoryDiagnostics.js';

startMemoryDiagnostics('friend');
const server = new FriendServer();
await server.start();
