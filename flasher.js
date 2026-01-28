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

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

function getEsptoolPath(pluginDir) {
  const platform = os.platform();
  const binName = platform === 'win32'
    ? 'esptool-win64.exe'
    : platform === 'linux'
      ? 'esptool-linux-amd64'
      : 'esptool-darwin';

  return path.join(pluginDir, 'bin', binName);
}

export function flashUSB({ binPath, port, baudRate = 460800, pluginDir }) {
  const emitter = new EventEmitter();

  (async () => {
    const esptoolPath = getEsptoolPath(pluginDir);

    try {
      await fs.chmod(esptoolPath, 0o755);
    } catch {
      emitter.emit('error', `esptool binary not found or not accessible: ${esptoolPath}`);
      return;
    }

    const args = [
      '--chip', 'esp32',
      '--port', port,
      '--baud', String(baudRate),
      'write_flash',
      '0x10000',
      binPath
    ];

    emitter.emit('message', `Running: esptool ${args.join(' ')}`);

    const proc = spawn(esptoolPath, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdoutBuffer += text;

      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        emitter.emit('message', trimmed);

        const progressMatch = trimmed.match(/Writing at 0x[\da-fA-F]+\.\.\.\s*\((\d+)\s*%\)/);
        if (progressMatch) {
          emitter.emit('progress', parseInt(progressMatch[1], 10), 'Writing firmware...');
        }

        if (trimmed.includes('Connecting')) {
          emitter.emit('progress', 0, 'Connecting to ESP32...');
        }

        if (trimmed.includes('Chip is')) {
          emitter.emit('message', trimmed);
        }

        if (trimmed.includes('Erasing flash')) {
          emitter.emit('progress', 0, 'Erasing flash...');
        }

        if (trimmed.includes('Hash of data verified')) {
          emitter.emit('progress', 100, 'Verifying...');
        }

        if (trimmed.includes('Hard resetting')) {
          emitter.emit('progress', 100, 'Resetting device...');
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrBuffer += text;

      const lines = stderrBuffer.split('\n');
      stderrBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        emitter.emit('message', `[stderr] ${trimmed}`);
      }
    });

    proc.on('close', (code) => {
      if (stdoutBuffer.trim()) {
        emitter.emit('message', stdoutBuffer.trim());
      }
      if (stderrBuffer.trim()) {
        emitter.emit('message', `[stderr] ${stderrBuffer.trim()}`);
      }

      if (code === 0) {
        emitter.emit('complete', 'Firmware flashed successfully. Device is resetting.');
      } else {
        emitter.emit('error', `esptool exited with code ${code}. Check log for details.`);
      }
    });

    proc.on('error', (err) => {
      emitter.emit('error', `Failed to start esptool: ${err.message}`);
    });
  })();

  return emitter;
}

export function flashOTA({ binPath, pendantIp }) {
  const emitter = new EventEmitter();

  (async () => {
    let firmwareData;
    try {
      firmwareData = await fs.readFile(binPath);
    } catch (err) {
      emitter.emit('error', `Cannot read firmware file: ${err.message}`);
      return;
    }

    const fileSize = firmwareData.length;
    emitter.emit('message', `Starting OTA upload to ${pendantIp}`);
    emitter.emit('message', `Firmware size: ${fileSize} bytes`);
    emitter.emit('progress', 0, 'Connecting...');

    // Build multipart/form-data body (same as curl -F "firmware=@file")
    const boundary = '------------------------' + Date.now().toString(16);
    const fileName = path.basename(binPath);

    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="firmware"; filename="${fileName}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, firmwareData, footer]);

    const options = {
      method: 'POST',
      hostname: pendantIp.split(':')[0],
      port: pendantIp.includes(':') ? parseInt(pendantIp.split(':')[1], 10) : 80,
      path: '/update',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      },
      timeout: 120000
    };

    let completed = false;

    const req = http.request(options, (res) => {
      let resBody = '';
      res.on('data', (chunk) => { resBody += chunk.toString(); });
      res.on('end', () => {
        if (completed) return;
        completed = true;
        if (res.statusCode >= 200 && res.statusCode < 300) {
          emitter.emit('complete', `OTA update successful. ${resBody || 'Device is rebooting.'}`);
        } else {
          emitter.emit('error', `OTA update failed (HTTP ${res.statusCode}): ${resBody || 'Unknown error'}`);
        }
      });
    });

    req.on('error', (err) => {
      if (completed) return;
      // EPIPE/ECONNRESET after full upload means device rebooted — that's success
      if (err.code === 'EPIPE' || err.code === 'ECONNRESET') {
        completed = true;
        emitter.emit('complete', 'OTA update sent. Device is rebooting.');
      } else {
        completed = true;
        emitter.emit('error', `OTA connection failed: ${err.message}`);
      }
    });

    req.on('timeout', () => {
      req.destroy();
      if (!completed) {
        completed = true;
        emitter.emit('error', 'OTA connection timed out');
      }
    });

    // Send in chunks for progress reporting
    const chunkSize = 16384;
    let offset = 0;

    function writeNext() {
      while (offset < body.length) {
        const end = Math.min(offset + chunkSize, body.length);
        const chunk = body.subarray(offset, end);
        offset = end;

        const percent = Math.min(Math.round((Math.max(0, offset - header.length) / fileSize) * 100), 100);
        emitter.emit('progress', percent, 'Uploading firmware...');

        if (!req.write(chunk)) {
          // Backpressure — wait for drain
          req.once('drain', writeNext);
          return;
        }
      }
      req.end();
    }

    writeNext();
  })();

  return emitter;
}
