/*
 * This file is part of ncSender.
 *
 * ncSender is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * ncSender is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with ncSender. If not, see <https://www.gnu.org/licenses/>.
 */

const TRANSPORT_ID = 'bluetooth-pendant';
const RECONNECT_DELAY_MS = 5000;

export class BluetoothManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.btSerial = null;
    this.connectedDevice = null;
    this.clientId = null;
    this.buffer = '';
    this.reconnectTimer = null;
    this.isShuttingDown = false;
    this.BluetoothSerialPort = null;
  }

  async initialize() {
    try {
      const btModule = await import('bluetooth-serial-port');
      this.BluetoothSerialPort = btModule.BluetoothSerialPort;
      this.btSerial = new this.BluetoothSerialPort();
    } catch (err) {
      this.ctx.log('Bluetooth module not available:', err?.message || err);
      return false;
    }

    this.ctx.registerClientTransport(TRANSPORT_ID, {
      onBroadcast: (type, message) => this.sendToDevice(message),
      onShutdown: () => this.shutdown()
    });

    const savedDevice = this.ctx.getSettings()?.bluetoothDevice;
    const autoConnect = this.ctx.getSettings()?.bluetoothAutoConnect !== false;

    if (savedDevice?.address && autoConnect) {
      this.ctx.log('Auto-connecting to saved Bluetooth device:', savedDevice.address);
      this.tryConnect(savedDevice.address, savedDevice.channel).catch(() => {
        this.scheduleReconnect();
      });
    }

    return true;
  }

  async scanDevices() {
    if (!this.btSerial) {
      throw new Error('Bluetooth not initialized');
    }

    return new Promise((resolve, reject) => {
      const devices = [];
      const timeout = setTimeout(() => {
        resolve(devices);
      }, 15000);

      this.btSerial.inquire();

      this.btSerial.on('found', (address, name) => {
        devices.push({ address, name: name || 'Unknown Device' });
      });

      this.btSerial.on('finished', () => {
        clearTimeout(timeout);
        resolve(devices);
      });
    });
  }

  async findChannel(address) {
    return new Promise((resolve, reject) => {
      this.btSerial.findSerialPortChannel(address, (channel) => {
        resolve(channel);
      }, (err) => {
        reject(new Error(err || 'Failed to find SPP channel'));
      });
    });
  }

  async tryConnect(address, channel) {
    if (!this.btSerial) {
      throw new Error('Bluetooth not initialized');
    }

    if (!channel) {
      channel = await this.findChannel(address);
    }

    return new Promise((resolve, reject) => {
      this.btSerial.connect(address, channel, () => {
        this.connectedDevice = { address, channel };
        this.clientId = `bt-${address.replace(/:/g, '')}`;
        this.buffer = '';

        this.btSerial.on('data', (buffer) => {
          this.handleData(buffer);
        });

        this.btSerial.on('closed', () => {
          if (!this.isShuttingDown) {
            this.handleDisconnect();
          }
        });

        this.btSerial.on('failure', (err) => {
          this.ctx.log('Bluetooth connection failure:', err);
          if (!this.isShuttingDown) {
            this.handleDisconnect();
          }
        });

        this.ctx.log('Bluetooth connected:', address, 'channel:', channel);
        resolve();
      }, (err) => {
        reject(new Error(err || 'Connection failed'));
      });
    });
  }

  async connect(address, channel) {
    this.clearReconnectTimer();

    if (this.connectedDevice) {
      await this.disconnect();
    }

    await this.tryConnect(address, channel);

    this.ctx.setSettings({
      bluetoothDevice: { address, channel, name: this.connectedDevice?.name },
      bluetoothAutoConnect: true
    });
  }

  handleData(buffer) {
    this.buffer += buffer.toString('utf8');

    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (!line) continue;

      try {
        const message = JSON.parse(line);
        this.ctx.submitClientMessage(TRANSPORT_ID, this.clientId, message);
      } catch (err) {
        this.ctx.log('Bluetooth message parse error:', err?.message || err, 'line:', line);
      }
    }
  }

  sendToDevice(message) {
    if (!this.btSerial?.isOpen?.()) {
      return;
    }

    try {
      const data = JSON.stringify(message) + '\n';
      this.btSerial.write(Buffer.from(data, 'utf8'), (err) => {
        if (err) {
          this.ctx.log('Bluetooth write error:', err);
        }
      });
    } catch (err) {
      this.ctx.log('Bluetooth send error:', err?.message || err);
    }
  }

  handleDisconnect() {
    this.ctx.log('Bluetooth disconnected');
    this.connectedDevice = null;
    this.clientId = null;
    this.buffer = '';

    if (!this.isShuttingDown) {
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    this.clearReconnectTimer();

    const savedDevice = this.ctx.getSettings()?.bluetoothDevice;
    const autoConnect = this.ctx.getSettings()?.bluetoothAutoConnect !== false;

    if (!savedDevice?.address || !autoConnect) {
      return;
    }

    this.ctx.log('Scheduling Bluetooth reconnect in', RECONNECT_DELAY_MS, 'ms');
    this.reconnectTimer = setTimeout(async () => {
      if (this.isShuttingDown || this.connectedDevice) {
        return;
      }

      try {
        await this.tryConnect(savedDevice.address, savedDevice.channel);
      } catch (err) {
        this.ctx.log('Bluetooth reconnect failed:', err?.message || err);
        this.scheduleReconnect();
      }
    }, RECONNECT_DELAY_MS);
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  disconnect() {
    this.clearReconnectTimer();

    if (this.btSerial?.isOpen?.()) {
      try {
        this.btSerial.close();
      } catch (err) {
        this.ctx.log('Bluetooth close error:', err?.message || err);
      }
    }

    this.connectedDevice = null;
    this.clientId = null;
    this.buffer = '';
  }

  shutdown() {
    this.isShuttingDown = true;
    this.disconnect();
    this.ctx.log('Bluetooth manager shutdown');
  }

  getStatus() {
    return {
      initialized: !!this.btSerial,
      connected: this.connectedDevice !== null,
      device: this.connectedDevice,
      clientId: this.clientId
    };
  }
}
