import LoggerServer from '#/server/logger/LoggerServer.js';
import { startMemoryDiagnostics } from '#/util/MemoryDiagnostics.js';

startMemoryDiagnostics('logger');
new LoggerServer();
