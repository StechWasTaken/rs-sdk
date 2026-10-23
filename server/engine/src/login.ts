import LoginServer from '#/server/login/LoginServer.js';
import { startMemoryDiagnostics } from '#/util/MemoryDiagnostics.js';

startMemoryDiagnostics('login');
new LoginServer();
