const fs = require('fs');
const EventEmitter = require('events').EventEmitter;
const WebSocketClient = require('websocket').client;
const pairing = require('./pairing.json');

const SOCKET_URL = 'ssap://com.webos.service.networkinput/getPointerInputSocket';

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

        const options = {
            keepalive: true,
            keepaliveInterval: 10000,
            dropConnectionOnKeepaliveTimeout: true,
            keepaliveGracePeriod: 5000
        };
        this.client = new WebSocketClient(options);

        this.connection = {};
        this.specializedSockets = {};
        this.callbacks = {};
        this.isPaired = false;
        this.autoReconnect = config.reconnect;

        let lastError;

        this.client.on('connectFailed', (error) => {
            if (lastError !== error.toString()) {
                this.emit('error', error);
            }
            lastError = error.toString();

            if (this.reconnect) {
                setTimeout(() => {
                    const autoReconnect = this.autoReconnect ? this.connect() : false;
                }, this.reconnect);
            }
        });

        this.client.on('connect', (connection) => {
            this.connection = connection;

            this.connection.on('error', (error) => {
                this.emit('error', error);
            });

            this.connection.on('close', () => {
                this.connection = {};
                Object.keys(this.callbacks).forEach((cid) => {
                    delete this.callbacks[cid];
                });
                this.emit('message', 'Disconnected.');
                if (this.reconnect) {
                    setTimeout(() => {
                        const autoReconnect = this.autoReconnect ? this.connect() : false;
                    }, this.reconnect);
                }
            });

            this.connection.on('message', (message) => {
                if (message.type === 'utf8') {
                    const messageUtf8Data = message.utf8Data;
                    const parsedMessage = messageUtf8Data ? JSON.parse(messageUtf8Data) : this.emit('message', 'JSON Parse Error: ' + messageUtf8Data);

                    if (parsedMessage && this.callbacks[parsedMessage.id]) {
                        if (parsedMessage.payload && parsedMessage.payload.subscribed) {
                            const pushMuteMessage = (typeof parsedMessage.payload.muted !== 'undefined' && parsedMessage.payload.changed) ? parsedMessage.payload.changed.push('muted') : parsedMessage.payload.changed = ['muted'];
                            const pushVolumeMessage = (typeof parsedMessage.payload.volume !== 'undefined' && parsedMessage.payload.changed) ? parsedMessage.payload.changed.push('volume') : parsedMessage.payload.changed = ['volume'];
                        }
                        this.callbacks[parsedMessage.id](null, parsedMessage.payload);
                    }
                } else {
                    this.emit('message', 'Received Non utf8 Message: ' + message.toString());
                }
            });

            this.isPaired = false;
            this.register();
        });
    };

    register() {
        const pairingKey = (fs.readFileSync(this.keyFile).toString() != undefined) ? fs.readFileSync(this.keyFile).toString() : undefined;
        pairing['client-key'] = pairingKey;

        this.send('register', undefined, pairing, (err, res) => {
            if (!err && res) {
                if (res['client-key']) {
                    this.saveKey(res['client-key'], (err) => {
                        const emitMessage = err ? this.emit('error', err) : this.emit('info', 'Pairing Key Saved.');
                    });
                    this.isPaired = true;
                    this.emit('connect', 'Connected.');
                } else {
                    this.emit('message', 'Waiting on Aithorization Accept...');
                }
            } else {
                this.emit('error', err);
            }
        });
    };

    saveKey(key, cb) {
        fs.writeFile(this.keyFile, key, cb);
    };

    request(uri, payload, cb) {
        this.send('request', uri, payload, cb);
    };

    subscribe(uri, payload, cb) {
        this.send('subscribe', uri, payload, cb);
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

    getSocket(cb) {
        if (this.specializedSockets[SOCKET_URL]) {
            cb(null, this.specializedSockets[SOCKET_URL]);
            return;
        }

        this.request(SOCKET_URL, (err, data) => {
            if (err) {
                this.emit('error', err);
                cb(err);
                return;
            }

            const specialClient = new WebSocketClient();
            specialClient
                .on('connect', (connection) => {
                    connection
                        .on('error', (error) => {
                            this.emit('error', error);
                        })
                        .on('close', () => {
                            delete this.specializedSockets[SOCKET_URL];
                            this.emit('message', 'Specjalized Socket Disconnected.');
                        });

                    this.specializedSockets[SOCKET_URL] = new SpecializedSocket(connection);
                    cb(null, this.specializedSockets[SOCKET_URL]);
                    this.emit('message', 'Specjalized Socket Connected.');
                })
                .on('connectFailed', (error) => {
                    this.emit('error', error);
                });

            const socketPath = data.socketPath;
            specialClient.connect(socketPath);
        });
    };

    connect() {
        this.autoReconnect = true;
        if (this.connection.connected && !this.isPaired) {
            this.register();
        } else if (!this.connection.connected) {
            //this.emit('message', 'Connecting...');
            this.connection = {};
            this.client.connect(this.url);
        }
    };

    disconnect() {
        if (this.connection && this.connection.close) {
            this.connection.close();
        }
        this.autoReconnect = false;

        Object.keys(this.specializedSockets).forEach(
            (k) => {
                this.specializedSockets[k].close();
            }
        );
    };
}
module.exports = LGTV;