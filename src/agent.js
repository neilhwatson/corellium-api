const WebSocket = require('ws');
const stream = require('stream');

class DownloadStream extends stream.Readable {
    constructor(options) {
        super(options);
        this.buffers = [];
    }

    _read(n) {
        while (this.buffers.length > 0) {
            let buffer = this.buffer.shift();
            if (!this.push(buffer))
                break;
        }
    }

    append(data) {
        this.buffers.push(data);
    }
}

class Agent {
    constructor(endpoint) {
        this.endpoint = endpoint;
        this.active = true;
        this.pending = new Map();
        this.id = 0;
        this.connectPromise = null;
        this.connectResolve = null;
        this.reconnect();
    }
    
    reconnect() {
        if (!this.active)
            return;

        if (!this.connectPromise) {
            this.connectPromise = new Promise(resolve => {
                this.connectResolve = resolve;
            });
        }

        this.ws = new WebSocket(this.endpoint);
        this.ws.on('message', data => {
            try {
                let message;
                let id;
                if (typeof data === 'string') {
                    message = JSON.parse(data);
                    id = message['id'];
                } else if (data.length >= 8) {
                    id = data.readUInt32LE(0);
                    message = data.slice(8);
                }

                let handler = this.pending.get(id);
                if (handler) {
                    if (handler(null, message))
                        this.pending.delete(id);
                }
            } catch (err) {
                console.error(err);
            }
        });
        
        this.ws.on('open', err => {
            this.connectResolve();
            this.connectPromise = null;
            this.connectResolve = null;
        });

        this.ws.on('error', err => {
            this.pending.forEach(handler => {
                handler(err);
            });
            this.pending = new Map();

            if (this.connectResolve) {
                let oldResolve = this.connectResolve;
                setTimeout(() => {
                    this.connectPromise = null;
                    this.connectResolve = null;
                    this.active = true;
                    this.reconnect();
                    this.connectPromise.then(oldResolve);
                }, 1000);
            } else {
                console.error(err);
                this.disconnect();
            }
        });
        
        this.ws.on('close', () => {
            this.pending.forEach(handler => {
                handler(new Error('disconnected'));
            });
            this.pending = new Map();

            this.disconnect();
        });
    }

    disconnect() {
        this.active = false;
        this.pending = new Map();
        this.ws.close();
    }

    message(message, handler) {
        let send = () => {
            ++this.id;

            let id = this.id;
            this.pending.set(id, handler);
            this.ws.send(JSON.stringify(Object.assign({}, message, {
                'id': id
            })));

            return id;
        };
        
        if (this.connectPromise)
            return this.connectPromise.then(send);

        return send();
    }

    binaryData(id, data) {
        let idBuffer = Buffer.alloc(8, 0);
        idBuffer.writeUInt32LE(0, id);
        if (data)
            this.ws.send(Buffer.concat([idBuffer, data]));
        else
            this.ws.send(idBuffer);
    }

    command(message) {
        return new Promise((resolve, reject) => {
            this.message(message, (err, message) => {
                if (err)
                    reject(err);
                else
                    resolve(message);

                return true;
            });
        });
    }

    async ready() {
        let results = await this.command({'type': 'app', 'op': 'ready'});
        if (!results['success'])
            throw new Error(results['error']);
    }

    async uninstall(bundleID) {
        let results = await this.command({'type': 'app', 'op': 'uninstall', 'bundleID': bundleID});
        if (!results['success'])
            throw new Error(results['error']);
    }

    async kill(bundleID) {
        let results = await this.command({'type': 'app', 'op': 'kill', 'bundleID': bundleID});
        if (!results['success'])
            throw new Error(results['error']);
    }

    async list() {
        let results = await this.command({'type': 'app', 'op': 'list'});
        if (!results['success'])
            throw new Error(results['error']);

        return results['apps'];
    }

    install(path, progress) {
        return new Promise((resolve, reject) => {
            return this.message({'type': 'app', 'op': 'install', 'path': path}, (err, message) => {
                if (err) {
                    reject(err);
                    return true;
                }

                if (message['success']) {
                    resolve();
                    return true;
                }

                if (progress)
                    progress(message['progress'], message['status']);

                return false;
            });
        });
    }

    async tempFile() {
        let results = await this.command({'type': 'file', 'op': 'temp'});
        if (!results['success'])
            throw new Error(results['error']);

        return results['path'];
    }

    async upload(path, stream) {
        return new Promise(async (resolve, reject) => {
            let id = await this.message({'type': 'file', 'op': 'upload', 'path': path}, (err, message) => {
                if (err) {
                    reject(err);
                    return true;
                }

                if (message['success']) {
                    resolve();
                    return true;
                }
            });

            stream.on('data', data => {
                this.binaryData(id, data);
            });

            stream.on('end', () => {
                this.binaryData(id);
            });
        });
    }

    async download(path) {
        let stream = new DownloadStream();
        this.message({'type': 'file', 'op': 'download', 'path': path}, (err, message) => {
            if (err) {
                reject(err);
                return true;
            }

            if (typeof message === 'string')
                return false;

            if (message.length === 0) {
                stream.emit('end');
                return true;
            }

            stream.append(message);
            return false;
        });

        return stream;
    }

    async installFile(stream, progress) {
        let path = await this.tempFile();
        await this.upload(path, stream);
        await this.install(path, progress);
    }

    async deleteFile(path) {
        let results = await this.command({'type': 'file', 'op': 'delete', 'path': path});
        if (!results['success'])
            throw new Error(results['error']);

        return results['path'];
    }

    crashes(bundleID, callback) {
        this.message({'type': 'crash', 'op': 'subscribe', 'bundleID': bundleID}, async (err, message) => {
            if (err) {
                reject(err);
                return true;
            }

            let crashReport = await new Promise(resolve => {
                let stream = this.download(message['file']);
                let buffers = [];

                stream.on('data', data => {
                    buffers.push(data);
                });

                stream.on('end', () => {
                    resolve(Buffer.concat(buffers));
                });
            });

            callback(crashReport.toString('utf8'));
            return false;
        });
    }
}

module.exports = Agent;
