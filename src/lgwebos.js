const fs = require('fs');
const fsPromises = fs.promises;
const EventEmitter = require('events').EventEmitter;
const WebSocketClient = require('websocket').client;
const pairing = require('./pairing.json');

const SOCKET_URL = 'ssap://com.webos.service.networkinput/getPointerInputSocket';
const SOCKET_OPTIONS = {
    keepalive: true,
    keepaliveInterval: 5000,
    keepaliveGracePeriod: 3000,
    dropConnectionOnKeepaliveTimeout: true
};

class SpecializedSocket {
    constructor(ws) {
        this.send = (type, payload) => {
            payload = payload || {};
            const message = Object.keys(payload).reduce((acc, k) => {
                return acc.concat([k + ':' + payload[k]]);
            }, ['type:' + type]).join('\n') + '\n\n';
            ws.send(message);
        };
        this.close = () => {
            ws.close();
        };
    }
}

class LGTV extends EventEmitter {
    constructor(config) {
        super();
        this.url = config.url;
        this.timeout = config.timeout;
        this.reconnect = config.reconnect;
        this.keyFile = config.keyFile;

        this.client = new WebSocketClient(SOCKET_OPTIONS);

        this.connection = {};
        this.specializedSockets = {};
        this.callbacks = {};
        this.isPaired = false;

        this.client.on('connectFailed', (error) => {
            if (error) {
                //this.emit('error', 'Connect to TV Failed: ${error}`);
            }

            setTimeout(() => {
                this.connect();
            }, this.reconnect);
        });

        this.client.on('connect', (connection) => {
            this.connection = connection;

            this.connection.on('error', (error) => {
                this.emit('error', `Connect to TV Error: ${error}`);
            });

            this.connection.on('close', () => {
                this.connection = {};
                Object.keys(this.callbacks).forEach((cid) => {
                    delete this.callbacks[cid];
                });
                this.emit('message', 'Disconnected.');

                setTimeout(() => {
                    this.connect();
                }, this.reconnect);
            });

            this.connection.on('message', (message) => {
                if (message.type === 'utf8') {
                    const messageUtf8Data = message.utf8Data;
                    const parsedMessage = messageUtf8Data ? JSON.parse(messageUtf8Data) : this.emit('message', `Not received UTF-8 Data: ${messageUtf8Data}`);

                    if (parsedMessage && this.callbacks[parsedMessage.id]) {
                        if (parsedMessage.payload && parsedMessage.payload.subscribed) {
                            const pushMute = (typeof parsedMessage.payload.muted !== 'undefined') ? parsedMessage.payload.changed ? parsedMessage.payload.changed.push('muted') : parsedMessage.payload.changed = ['muted'] : false;
                            const pushVolume = (typeof parsedMessage.payload.volume !== 'undefined') ? parsedMessage.payload.changed ? parsedMessage.payload.changed.push('volume') : parsedMessage.payload.changed = ['volume'] : false;
                        }
                        this.callbacks[parsedMessage.id](null, parsedMessage.payload);
                    }
                } else {
                    this.emit('message', `Received non UTF-8 Data: ${message}`);
                }
            });

            this.register();
        });

        this.connect();
    };

    register() {
        const savedPairingKey = (fs.readFileSync(this.keyFile).toString() != undefined) ? fs.readFileSync(this.keyFile).toString() : undefined;
        pairing['client-key'] = savedPairingKey;

        this.send('register', undefined, pairing, (error, res) => {
            if (!error && res) {
                const pairingKey = res['client-key'];
                if (pairingKey) {
                    if (savedPairingKey !== pairingKey) {
                        try {
                            const writeKey = fsPromises.writeFile(this.keyFile, pairingKey);
                            this.emit('message', 'Pairing Key Saved.')
                        } catch (error) {
                            this.emit('error', error)
                        }
                    }
                    this.isPaired = true;
                    this.emit('connect', 'Connected.');
                } else {
                    this.emit('message', 'Waiting on Authorization Accept...');
                }
            } else {
                this.emit('error', error);
            }
        });
    };

    getSocket(cb) {
        if (this.specializedSockets[SOCKET_URL]) {
            cb(null, this.specializedSockets[SOCKET_URL]);
            return;
        }

        this.send('request', SOCKET_URL, (err, data) => {
            if (err) {
                this.emit('error', err);
                cb(err);
                return;
            }

            const specialClient = new WebSocketClient(SOCKET_OPTIONS);
            specialClient
                .on('connect', (connection) => {
                    connection
                        .on('error', (error) => {
                            this.emit('error', `Specialized Socket Connect Error: ${error}`);
                        })
                        .on('close', () => {
                            delete this.specializedSockets[SOCKET_URL];
                            this.emit('message', 'Specialized Socket Disconnected.');
                        });

                    this.specializedSockets[SOCKET_URL] = new SpecializedSocket(connection);
                    cb(null, this.specializedSockets[SOCKET_URL]);
                    this.emit('message', 'Specialized Socket Connected.');
                })
                .on('connectFailed', (error) => {
                    this.emit('error', `Specialized Socket Connect Failed: ${error}`);
                });

            const socketPath = data.socketPath;
            specialClient.connect(socketPath);
        });
    };

    send(type, uri, payload, cb) {
        if (typeof payload === 'function') {
            cb = payload;
            payload = {};
        }

        if (!this.connection.connected) {
            if (typeof cb === 'function') {
                cb(new Error('not connected'));
            }
            return;
        }

        const cid = this.getCid();
        const json = JSON.stringify({
            id: cid,
            type: type,
            uri: uri,
            payload: payload
        });

        if (typeof cb === 'function') {
            switch (type) {
                case 'request':
                    this.callbacks[cid] = (err, res) => {
                        delete this.callbacks[cid];
                        cb(err, res);
                    };

                    // Set callback timeout
                    setTimeout(() => {
                        if (this.callbacks[cid]) {
                            cb(new Error('timeout'));
                        }
                        delete this.callbacks[cid];
                    }, this.timeout);
                    break;

                case 'subscribe':
                    this.callbacks[cid] = cb;
                    break;

                case 'register':
                    this.callbacks[cid] = cb;
                    break;

                default:
                    throw new Error('unknown type');
            }
        }
        this.connection.send(json);
    };

    getCid() {
        let cidCount = 0;
        let cidPrefix = ('0000000' + (Math.floor(Math.random() * 0xFFFFFFFF).toString(16))).slice(-8);
        return cidPrefix + ('000' + (cidCount++).toString(16)).slice(-4);
    }

    connect() {
        if (this.connection.connected && !this.isPaired) {
            this.register();
        } else if (!this.connection.connected) {
            this.connection = {};
            this.client.connect(this.url);
        }
    };

    disconnect() {
        if (this.connection) {
            this.connection.close();
        }

        Object.keys(this.specializedSockets).forEach(
            (k) => {
                this.specializedSockets[k].close();
            }
        );
    };
}
module.exports = LGTV;