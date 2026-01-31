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

const TRANSPORT_ID = 'ble-pendant';
const RECONNECT_DELAY_MS = 5000;

// Nordic UART Service UUIDs
const NUS_SERVICE_UUID = '6e400001b5a3f393e0a9e50e24dcca9e';
const NUS_RX_CHAR_UUID = '6e400002b5a3f393e0a9e50e24dcca9e'; // Write to this (server → pendant)
const NUS_TX_CHAR_UUID = '6e400003b5a3f393e0a9e50e24dcca9e'; // Notifications from this (pendant → server)

export class BLEManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.noble = null;
    this.connectedPeripheral = null;
    this.rxCharacteristic = null;
    this.txCharacteristic = null;
    this.connectedDevice = null;
    this.clientId = null;
    this.buffer = '';
    this.reconnectTimer = null;
    this.isShuttingDown = false;
    this.isScanning = false;
  }

  async initialize() {
    // Check if BLE is disabled via environment variable
    if (process.env.NCSENDER_DISABLE_BLE === '1') {
      this.ctx.log('BLE disabled via NCSENDER_DISABLE_BLE environment variable');
      return false;
    }

    // On macOS standalone mode, BLE requires special permission handling
    // The noble module accesses Bluetooth immediately on import, which will crash
    // if TCC permissions aren't properly granted for ad-hoc signed apps
    if (process.platform === 'darwin') {
      const isElectron = !!(process.versions && process.versions.electron);
      if (!isElectron) {
        this.ctx.log('BLE: Running in standalone mode on macOS');
        this.ctx.log('BLE: If the app crashes, you have two options:');
        this.ctx.log('  1. Run with Electron: npm run dev (for Bluetooth permissions)');
        this.ctx.log('  2. Disable BLE: NCSENDER_DISABLE_BLE=1 npm run server:ble');
      }
    }

    try {
      const nobleModule = await import('@stoprocent/noble');
      this.noble = nobleModule.default || nobleModule;

      if (!this.noble) {
        this.ctx.log('BLE module loaded but noble object is undefined');
        return false;
      }
    } catch (err) {
      const msg = err?.message || String(err);
      if (msg.includes('TCC') || msg.includes('privacy') || msg.includes('Bluetooth')) {
        this.ctx.log('BLE initialization failed - Bluetooth permission denied');
        this.ctx.log('Grant permission in: System Settings > Privacy & Security > Bluetooth');
        return false;
      }
      this.ctx.log('BLE module (noble) not available:', msg);
      return false;
    }

    try {
      this.ctx.registerClientTransport(TRANSPORT_ID, {
        onBroadcast: (type, message) => this.sendToDevice(message),
        onShutdown: () => this.shutdown()
      });

      // Handle noble state changes
      this.noble.on('stateChange', (state) => {
        this.ctx.log('BLE adapter state:', state);
        if (state === 'poweredOn') {
          const savedDevice = this.ctx.getSettings()?.bleDevice;
          const autoConnect = this.ctx.getSettings()?.bleAutoConnect !== false;
          if (savedDevice?.id && autoConnect) {
            this.ctx.log('BLE powered on, will auto-connect to:', savedDevice.name || savedDevice.id);
            this.scheduleReconnect();
          }
        }
      });

      return true;
    } catch (err) {
      this.ctx.log('BLE initialization failed:', err?.message || err);
      return false;
    }
  }

  async scanDevices(duration = 10000) {
    if (!this.noble) {
      throw new Error('BLE not initialized');
    }

    if (this.noble.state !== 'poweredOn') {
      throw new Error('Bluetooth adapter is not powered on');
    }

    if (this.isScanning) {
      throw new Error('Already scanning');
    }

    return new Promise((resolve, reject) => {
      const devices = [];
      const deviceMap = new Map();

      this.isScanning = true;

      const onDiscover = (peripheral) => {
        // Filter for devices advertising NUS service or named ncSenderPendant
        const dominated = peripheral.advertisement?.localName?.toLowerCase()?.includes('ncsender') ||
                         peripheral.advertisement?.serviceUuids?.includes(NUS_SERVICE_UUID);

        if (peripheral.advertisement?.localName || dominated) {
          const id = peripheral.id || peripheral.uuid;
          if (!deviceMap.has(id)) {
            const device = {
              id,
              name: peripheral.advertisement?.localName || 'Unknown BLE Device',
              address: peripheral.address || id,
              rssi: peripheral.rssi,
              type: 'ble'
            };
            deviceMap.set(id, device);
            devices.push(device);
            this.ctx.log('BLE device found:', device.name, device.address);
          }
        }
      };

      this.noble.on('discover', onDiscover);

      const stopScan = () => {
        this.isScanning = false;
        this.noble.stopScanning();
        this.noble.removeListener('discover', onDiscover);
        resolve(devices);
      };

      const timeout = setTimeout(stopScan, duration);

      this.noble.startScanning([NUS_SERVICE_UUID], false, (err) => {
        if (err) {
          clearTimeout(timeout);
          this.isScanning = false;
          this.noble.removeListener('discover', onDiscover);
          reject(new Error('Failed to start BLE scan: ' + err.message));
        }
      });
    });
  }

  async connect(deviceId, deviceName) {
    if (!this.noble) {
      throw new Error('BLE not initialized');
    }

    this.clearReconnectTimer();

    if (this.connectedPeripheral) {
      await this.disconnect();
    }

    this.ctx.log('BLE connecting to:', deviceId);

    // Find the peripheral
    const peripheral = await this.findPeripheral(deviceId);
    if (!peripheral) {
      throw new Error('Device not found. Try scanning again.');
    }

    await this.connectToPeripheral(peripheral);

    this.connectedDevice = {
      id: deviceId,
      name: deviceName || peripheral.advertisement?.localName || 'BLE Device',
      address: peripheral.address || deviceId,
      type: 'ble'
    };
    this.clientId = `ble-${deviceId.replace(/[:-]/g, '')}`;

    this.ctx.setSettings({
      bleDevice: this.connectedDevice,
      bleAutoConnect: true
    });

    this.ctx.log('BLE connected:', this.connectedDevice.name);
  }

  async findPeripheral(deviceId, timeout = 10000) {
    return new Promise((resolve) => {
      let found = null;
      let scanTimeout;

      const onDiscover = (peripheral) => {
        const id = peripheral.id || peripheral.uuid;
        if (id === deviceId || peripheral.address === deviceId) {
          found = peripheral;
          cleanup();
          resolve(peripheral);
        }
      };

      const cleanup = () => {
        clearTimeout(scanTimeout);
        this.noble.stopScanning();
        this.noble.removeListener('discover', onDiscover);
      };

      scanTimeout = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeout);

      this.noble.on('discover', onDiscover);
      this.noble.startScanning([], false);
    });
  }

  async connectToPeripheral(peripheral) {
    return new Promise((resolve, reject) => {
      const connectTimeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, 15000);

      peripheral.connect(async (err) => {
        if (err) {
          clearTimeout(connectTimeout);
          reject(new Error('Connection failed: ' + err.message));
          return;
        }

        try {
          // Discover services and characteristics
          const { characteristics } = await this.discoverCharacteristics(peripheral);

          this.rxCharacteristic = characteristics.find(c => c.uuid === NUS_RX_CHAR_UUID);
          this.txCharacteristic = characteristics.find(c => c.uuid === NUS_TX_CHAR_UUID);

          if (!this.rxCharacteristic || !this.txCharacteristic) {
            peripheral.disconnect();
            clearTimeout(connectTimeout);
            reject(new Error('Device does not support Nordic UART Service'));
            return;
          }

          // Subscribe to TX notifications (pendant → server)
          this.txCharacteristic.on('data', (data) => {
            this.handleData(data);
          });

          this.txCharacteristic.subscribe((err) => {
            if (err) {
              this.ctx.log('Failed to subscribe to BLE notifications:', err);
            }
          });

          // Handle disconnect
          peripheral.on('disconnect', () => {
            if (!this.isShuttingDown) {
              this.handleDisconnect();
            }
          });

          this.connectedPeripheral = peripheral;
          clearTimeout(connectTimeout);
          resolve();
        } catch (e) {
          peripheral.disconnect();
          clearTimeout(connectTimeout);
          reject(e);
        }
      });
    });
  }

  discoverCharacteristics(peripheral) {
    return new Promise((resolve, reject) => {
      peripheral.discoverSomeServicesAndCharacteristics(
        [NUS_SERVICE_UUID],
        [NUS_RX_CHAR_UUID, NUS_TX_CHAR_UUID],
        (err, services, characteristics) => {
          if (err) {
            reject(new Error('Failed to discover characteristics: ' + err.message));
          } else {
            resolve({ services, characteristics });
          }
        }
      );
    });
  }

  handleData(data) {
    this.buffer += data.toString('utf8');

    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (!line) continue;

      try {
        const message = JSON.parse(line);
        this.ctx.submitClientMessage(TRANSPORT_ID, this.clientId, message);
      } catch (err) {
        this.ctx.log('BLE message parse error:', err?.message || err, 'line:', line);
      }
    }
  }

  sendToDevice(message) {
    if (!this.rxCharacteristic || !this.connectedPeripheral) {
      return;
    }

    try {
      const data = JSON.stringify(message) + '\n';
      const buffer = Buffer.from(data, 'utf8');

      // BLE has MTU limits, may need to chunk large messages
      const chunkSize = 20; // Safe BLE chunk size
      for (let i = 0; i < buffer.length; i += chunkSize) {
        const chunk = buffer.slice(i, Math.min(i + chunkSize, buffer.length));
        this.rxCharacteristic.write(chunk, true, (err) => {
          if (err) {
            this.ctx.log('BLE write error:', err);
          }
        });
      }
    } catch (err) {
      this.ctx.log('BLE send error:', err?.message || err);
    }
  }

  handleDisconnect() {
    this.ctx.log('BLE disconnected');
    this.connectedPeripheral = null;
    this.rxCharacteristic = null;
    this.txCharacteristic = null;
    this.connectedDevice = null;
    this.clientId = null;
    this.buffer = '';

    if (!this.isShuttingDown) {
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    this.clearReconnectTimer();

    const savedDevice = this.ctx.getSettings()?.bleDevice;
    const autoConnect = this.ctx.getSettings()?.bleAutoConnect !== false;

    if (!savedDevice?.id || !autoConnect) {
      return;
    }

    this.ctx.log('Scheduling BLE reconnect in', RECONNECT_DELAY_MS, 'ms');
    this.reconnectTimer = setTimeout(async () => {
      if (this.isShuttingDown || this.connectedPeripheral) {
        return;
      }

      try {
        await this.connect(savedDevice.id, savedDevice.name);
      } catch (err) {
        this.ctx.log('BLE reconnect failed:', err?.message || err);
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

    if (this.connectedPeripheral) {
      try {
        this.connectedPeripheral.disconnect();
      } catch (err) {
        this.ctx.log('BLE disconnect error:', err?.message || err);
      }
    }

    this.connectedPeripheral = null;
    this.rxCharacteristic = null;
    this.txCharacteristic = null;
    this.connectedDevice = null;
    this.clientId = null;
    this.buffer = '';
  }

  shutdown() {
    this.isShuttingDown = true;
    if (this.isScanning && this.noble) {
      this.noble.stopScanning();
    }
    this.disconnect();
    this.ctx.log('BLE manager shutdown');
  }

  getStatus() {
    return {
      initialized: !!this.noble,
      connected: this.connectedPeripheral !== null,
      device: this.connectedDevice,
      clientId: this.clientId,
      type: 'ble'
    };
  }
}
