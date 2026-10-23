import net from 'net';

import ClientSocket from '#/server/ClientSocket.js';
import { networkPressure } from '#/util/NetworkPressure.js';

export default class TcpClientSocket extends ClientSocket {
    socket: net.Socket;

    constructor(socket: net.Socket, remoteAddress: string) {
        super();

        this.socket = socket;
        this.remoteAddress = remoteAddress;
        networkPressure.register(socket, 'game-tcp', () => socket.writableLength, () => this.terminate());
        socket.on('close', () => networkPressure.remove(socket));
    }

    send(src: Uint8Array): void {
        if (!networkPressure.beforeSend(this.socket)) return;
        this.socket.write(src);
        networkPressure.afterSend(this.socket);
    }

    close(): void {
        // rs-sdk: keep the pre-289 1s delay (upstream now ends immediately). Same as
        // WSClientSocket: a reconnect closes the old socket before ownership moves to
        // the new one, and the close event must not detach the replacement
        // (test/fixtures/reconnect-lifecycle.ts).
        this.state = -1;
        setTimeout(() => this.socket.end(), 1000);
    }

    terminate(): void {
        this.state = -1;
        networkPressure.remove(this.socket);
        this.socket.destroy();
    }
}
