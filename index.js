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

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { flashUSB, flashOTA } from './flasher.js';

const ACTIVATION_API_URL = 'https://franciscreation.com/api/license/activate';
const ACTIVATION_API_KEY = 'ncsp-2025-fc-api-key';
const FIRMWARE_RELEASES_REPO = 'siganberg/ncSender.pendant.releases';

let serialPortModule = null;

function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const num1 = parts1[i] || 0;
    const num2 = parts2[i] || 0;

    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }

  return 0;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function fetchLatestFirmwareRelease() {
  const url = `https://api.github.com/repos/${FIRMWARE_RELEASES_REPO}/releases/latest`;
  const response = await fetch(url, {
    headers: { 'Accept': 'application/vnd.github.v3+json' }
  });

  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status}`);
  }

  const release = await response.json();
  const latestVersion = (release.tag_name || '').replace(/^v/, '');
  const releaseNotes = release.body || '';
  const releaseUrl = release.html_url || '';
  const publishedAt = release.published_at || '';

  const binAsset = (release.assets || []).find(a => a.name.endsWith('.bin'));
  const downloadUrl = binAsset ? binAsset.browser_download_url : null;

  return { latestVersion, releaseNotes, downloadUrl, releaseUrl, publishedAt };
}

async function getSerialPorts() {
  if (!serialPortModule) {
    try {
      serialPortModule = await import('serialport');
    } catch {
      return [];
    }
  }
  return serialPortModule.SerialPort.list();
}

function getPluginDir() {
  return path.dirname(new URL(import.meta.url).pathname);
}

async function activateWithServer(installationId, machineId, productName) {
  const response = await fetch(ACTIVATION_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': ACTIVATION_API_KEY
    },
    body: JSON.stringify({ installationId, machineHash: machineId, product: productName })
  });

  const text = await response.text();

  if (!response.ok) {
    let message = `Activation failed (HTTP ${response.status})`;
    try {
      const err = JSON.parse(text);
      if (err.error) message = err.error;
    } catch {}
    throw new Error(message);
  }

  if (!text) {
    throw new Error('Activation server returned an empty response');
  }

  return JSON.parse(text);
}

// --- Pendant autodetection ---

class PendantTracker {
  constructor(ctx) {
    this.ctx = ctx;
  }

  getInfo() {
    const clients = this.ctx.getConnectedClients({ product: 'ncSenderPendant' });
    return clients.length > 0 ? clients[0] : null;
  }

  isConnected() {
    return this.getInfo() !== null;
  }
}

// --- Tabbed Dialog ---

function buildDialogHtml(ports, pendant, savedSettings, firmwareUpdate) {
  const portsJson = JSON.stringify(ports);
  const hasPendant = pendant !== null;
  const isLicensed = hasPendant && pendant.licensed;
  const savedInstallationId = savedSettings.lastInstallationId || '';
  const savedMethod = savedSettings.lastMethod || 'usb';

  return /* html */ `
    <style>
      .wp-tabs {
        display: flex;
        border-bottom: 1px solid var(--color-border);
        background: var(--color-surface-muted);
        padding: var(--gap-xs, 4px) var(--gap-md, 16px) 0 var(--gap-md, 16px);
        gap: 2px;
      }
      .wp-tab {
        all: unset;
        display: flex;
        align-items: center;
        gap: var(--gap-xs, 4px);
        padding: var(--gap-sm, 8px) var(--gap-md, 16px);
        background: transparent !important;
        border: none !important;
        border-radius: var(--radius-small) var(--radius-small) 0 0 !important;
        color: var(--color-text-secondary) !important;
        cursor: pointer;
        transition: all 0.2s ease;
        font-size: 0.95rem;
        font-weight: 500;
        margin-top: var(--gap-xs, 4px);
        position: relative;
        box-sizing: border-box;
      }
      .wp-tab:hover {
        background: var(--color-surface) !important;
        color: var(--color-text-primary);
        transform: translateY(-1px);
        filter: none !important;
      }
      .wp-tab.active {
        background: var(--color-surface) !important;
        color: var(--color-text-primary) !important;
        box-shadow: var(--shadow-elevated);
        border-bottom: 2px solid var(--color-accent) !important;
        filter: none !important;
      }
      .wp-tab.active::after {
        content: '';
        position: absolute;
        bottom: -1px;
        left: 0;
        right: 0;
        height: 2px;
        background: var(--gradient-accent, var(--color-accent));
        border-radius: 2px 2px 0 0;
      }
      .wp-tab:focus-visible {
        outline: 2px solid var(--color-accent);
        outline-offset: 2px;
      }
      .wp-tab-label { font-weight: 600; }
      .wp-content {
        overflow-y: auto;
        padding: 20px;
        display: flex;
        flex-direction: column;
        height: 400px;
        width: 460px;
      }
      .wp-tab-content {
        display: none;
        flex: 1;
        flex-direction: column;
        gap: 18px;
      }
      .wp-tab-content.active {
        display: flex;
      }

      .form-group {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .form-group label {
        font-size: 0.85rem;
        font-weight: 500;
        color: var(--color-text-primary);
        text-align: center;
      }
      .form-group .hint {
        font-size: 0.75rem;
        color: var(--color-text-secondary);
        text-align: center;
      }
      input[type="text"], select {
        padding: 0 10px;
        height: 36px;
        width: 100%;
        box-sizing: border-box;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-small);
        font-size: 0.85rem;
        background: var(--color-surface);
        color: var(--color-text-primary);
      }
      input:focus, select:focus {
        outline: none;
        border-color: var(--color-accent);
      }
      .readonly-field {
        padding: 8px 10px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-small);
        font-size: 0.85rem;
        font-family: monospace;
        background: var(--color-surface-muted);
        color: var(--color-text-primary);
        user-select: all;
        word-break: break-all;
        text-align: center;
      }
      .installation-id-input {
        font-family: monospace;
        font-size: 1rem;
        letter-spacing: 1px;
        text-align: center;
        text-transform: uppercase;
      }
      .status-msg {
        padding: 10px;
        border-radius: var(--radius-small);
        font-size: 0.85rem;
        text-align: center;
        display: none;
      }
      .status-msg.show { display: block; }
      .status-msg.error {
        background: #dc354520;
        border: 1px solid #dc3545;
        color: #dc3545;
      }
      .status-msg.success {
        background: #28a74520;
        border: 1px solid #28a745;
        color: #28a745;
      }
      .no-pendant {
        padding: 16px;
        text-align: center;
      }
      .no-pendant h3 {
        margin: 0 0 8px 0;
        color: var(--color-text-primary);
      }
      .no-pendant p {
        margin: 0;
        font-size: 0.85rem;
        color: var(--color-text-secondary);
      }

      .file-picker {
        display: flex;
        gap: 8px;
        align-items: stretch;
      }
      .file-picker input[type="file"] { display: none; }
      .file-picker .file-name {
        flex: 1;
        padding: 0 10px;
        height: 36px;
        box-sizing: border-box;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-small);
        font-size: 0.85rem;
        background: var(--color-surface);
        color: var(--color-text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        display: flex;
        align-items: center;
      }
      .file-picker .file-name.has-file {
        color: var(--color-text-primary);
      }
      .file-picker .browse-btn {
        padding: 0 14px;
        height: 36px;
        box-sizing: border-box;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-small);
        font-size: 0.85rem;
        font-weight: 500;
        cursor: pointer;
        background: var(--color-surface-muted);
        color: var(--color-text-primary);
        white-space: nowrap;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .file-picker .browse-btn:hover { opacity: 0.9; }
      .method-toggle {
        display: flex;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-small);
        overflow: hidden;
        height: 36px;
      }
      .method-toggle label {
        flex: 1;
        padding: 0 16px;
        height: 36px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        font-size: 0.85rem;
        font-weight: 500;
        background: var(--color-surface);
        color: var(--color-text-secondary);
        transition: background 0.2s, color 0.2s;
        border: none;
        box-sizing: border-box;
      }
      .method-toggle input[type="radio"] { display: none; }
      .method-toggle input[type="radio"]:checked + label {
        background: var(--color-accent);
        color: white;
      }
      .method-section {
        display: none;
        flex-direction: column;
        gap: 10px;
      }
      .method-section.active { display: flex; }
      .port-row {
        display: grid;
        grid-template-columns: 1fr 120px;
        gap: 8px;
      }
      .ota-warning {
        padding: 10px;
        border-radius: var(--radius-small);
        background: #1e3a5f40;
        border: 1px solid #3a7cbd;
        color: #7eb8e0;
        font-size: 0.85rem;
        text-align: center;
      }

      .plugin-dialog-footer {
        padding: 12px 16px;
        border-top: 1px solid var(--color-border);
        background: var(--color-surface);
      }
      .button-group {
        display: flex;
        gap: 10px;
        justify-content: center;
      }
      .btn {
        padding: 10px 20px;
        border: none;
        border-radius: var(--radius-small);
        font-size: 0.9rem;
        font-weight: 500;
        cursor: pointer;
        transition: opacity 0.2s;
      }
      .btn:hover { opacity: 0.9; }
      .btn-secondary {
        background: var(--color-surface-muted);
        color: var(--color-text-primary);
        border: 1px solid var(--color-border);
      }
      .btn-primary {
        background: var(--color-accent);
        color: white;
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      /* Web Serial UI */
      .ws-port-btn {
        padding: 0 14px;
        height: 36px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-small);
        font-size: 0.85rem;
        font-weight: 500;
        cursor: pointer;
        background: var(--color-accent);
        color: white;
        width: 100%;
        box-sizing: border-box;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .ws-port-btn:hover { opacity: 0.9; }
      .ws-port-btn.has-port {
        background: var(--color-surface);
        color: var(--color-text-primary);
        border-color: var(--color-accent);
      }
      .ws-warning {
        padding: 12px;
        border-radius: var(--radius-small);
        background: var(--color-surface-muted);
        border: 1px solid var(--color-border);
        color: var(--color-text-secondary);
        font-size: 0.8rem;
        text-align: left;
        line-height: 1.5;
      }
      .ws-warning-url {
        display: block;
        margin-top: 8px;
        font-family: monospace;
        font-size: 0.8rem;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-small);
        padding: 8px 10px;
        user-select: all;
        cursor: pointer;
        word-break: break-all;
        color: var(--color-text-primary);
        text-align: center;
        transition: border-color 0.2s;
      }
      .ws-warning-url:hover {
        border-color: var(--color-accent);
      }
      .ws-warning-url.copied {
        border-color: #28a745;
      }
      .ws-flash-form {
        display: flex;
        flex-direction: column;
        gap: 18px;
      }
      .ws-flash-form.hidden { display: none; }
      .ws-flash-progress {
        display: none;
        flex-direction: column;
        gap: 10px;
      }
      .ws-flash-progress.active { display: flex; }
      .ws-progress-bar-container {
        width: 100%;
        height: 8px;
        background: var(--color-surface-muted);
        border-radius: 4px;
        overflow: hidden;
      }
      .ws-progress-bar {
        height: 100%;
        width: 0%;
        background: var(--color-accent);
        border-radius: 4px;
        transition: width 0.3s ease;
      }
      .ws-progress-text {
        font-size: 0.85rem;
        color: var(--color-text-secondary);
      }
      .ws-flash-log {
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-small);
        padding: 10px;
        font-family: monospace;
        font-size: 0.8rem;
        color: var(--color-text-secondary);
        max-height: 200px;
        overflow-y: auto;
        white-space: pre-wrap;
        word-break: break-all;
      }
      .ws-flash-result {
        padding: 10px;
        border-radius: var(--radius-small);
        font-size: 0.85rem;
        text-align: center;
        display: none;
      }
      .ws-flash-result.success {
        display: block;
        background: #28a74520;
        border: 1px solid #28a745;
        color: #28a745;
      }
      .ws-flash-result.error {
        display: block;
        background: #dc354520;
        border: 1px solid #dc3545;
        color: #dc3545;
      }

      .fw-update-banner {
        padding: 12px;
        border-radius: var(--radius-small);
        font-size: 0.85rem;
        margin-bottom: 14px;
      }
      .fw-update-banner.error {
        background: #dc354520;
        border: 1px solid #dc3545;
        color: #dc3545;
        text-align: center;
      }
      .fw-update-banner.up-to-date {
        background: #28a74520;
        border: 1px solid #28a745;
        color: #28a745;
        text-align: center;
      }
      .fw-update-banner.update-available {
        background: #1e3a5f40;
        border: 1px solid #3a7cbd;
        color: var(--color-text-primary);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .fw-view-details {
        color: #7eb8e0;
        cursor: pointer;
        font-weight: 600;
        white-space: nowrap;
        text-decoration: none;
      }
      .fw-view-details:hover {
        text-decoration: underline;
      }
    </style>

    <!-- Tabs -->
    <div class="wp-tabs">
      <button class="wp-tab active" data-tab="firmware">
        <span class="wp-tab-label">Firmware</span>
      </button>
      <button class="wp-tab" data-tab="license">
        <span class="wp-tab-label">License</span>
      </button>
    </div>

    <!-- Tab Content -->
    <div class="wp-content">
      <!-- License Tab -->
      <div class="wp-tab-content" id="wp-tab-license" style="justify-content:center">
        ${hasPendant ? (isLicensed ? `
          <div class="form-group">
            <label>Pendant Machine ID</label>
            <div class="readonly-field">${pendant.machineId}</div>
          </div>
          ${savedInstallationId ? `
          <div class="form-group">
            <label>Installation ID</label>
            <div class="readonly-field">${escapeHtml(savedInstallationId)}</div>
          </div>
          ` : ''}
          <div class="status-msg show success">License active</div>
        ` : `
          <div class="form-group">
            <label>Pendant Machine ID</label>
            <div class="readonly-field">${pendant.machineId}</div>
          </div>
          <div class="form-group">
            <label>Installation ID</label>
            <input type="text" id="installationId" class="installation-id-input"
                   placeholder="XXXXXX-XXXXXX-XXXXXX-XXXXXX-XXXXXX-XXXXXX"
                   value="${savedInstallationId}" spellcheck="false" autocomplete="off" maxlength="41" />
            <span class="hint">Enter the Installation ID from your purchase email</span>
          </div>
          <div class="status-msg" id="licenseStatus"></div>
        `) : `
          <div class="no-pendant">
            <h3>No Pendant Detected</h3>
            <p>Make sure your pendant is powered on and connected to the same network as ncSender.</p>
          </div>
        `}
      </div>

      <!-- Firmware Tab -->
      <div class="wp-tab-content active" id="wp-tab-firmware" style="justify-content:center">
        ${firmwareUpdate ? (firmwareUpdate.error ? `
          <div class="fw-update-banner error">${escapeHtml(firmwareUpdate.error)}</div>
        ` : firmwareUpdate.hasUpdate ? `
          <div class="fw-update-banner update-available">
            <span>Firmware update available: v${escapeHtml(firmwareUpdate.latestVersion)}</span>
            <a class="fw-view-details" id="fwViewDetailsBtn">View Details</a>
          </div>
        ` : `
          <div class="fw-update-banner up-to-date">v${escapeHtml(firmwareUpdate.currentVersion)} &mdash; Firmware is up to date</div>
        `) : ''}
        <div class="ws-flash-form" id="wsFirmwareForm">
          <div class="form-group">
            <label>Firmware File (.bin)</label>
            <div class="file-picker">
              <span class="file-name" id="fileName">No file selected</span>
              <button type="button" class="browse-btn" onclick="document.getElementById('firmwareFile').click()">Browse</button>
              <input type="file" id="firmwareFile" accept=".bin" />
            </div>
          </div>

          <div class="form-group">
            <label>Flash Method</label>
            <div class="method-toggle">
              <input type="radio" name="method" id="methodUsb" value="usb" ${savedMethod === 'usb' ? 'checked' : ''} />
              <label for="methodUsb">USB</label>
              <input type="radio" name="method" id="methodOta" value="ota" ${savedMethod === 'ota' ? 'checked' : ''} />
              <label for="methodOta">OTA (Wi-Fi)</label>
            </div>
          </div>

          <div class="method-section ${savedMethod === 'usb' ? 'active' : ''}" id="usbSection">
            <div id="usbServerMode">
              <div class="form-group">
                <label>Serial Port</label>
                <select id="serialPort"></select>
              </div>
            </div>
            <div id="usbWebSerialMode" style="display:none">
              <div class="form-group">
                <label>Serial Port</label>
                <button type="button" class="ws-port-btn" id="wsSelectPortBtn">Select Port...</button>
              </div>
            </div>
            <div id="wsSecureWarning" class="ws-warning" style="display:none">
              Browser USB flashing requires a secure context. To enable it, open this Chrome flag and add this site's URL:
              <code class="ws-warning-url" id="wsCopyUrl" title="Click to copy">chrome://flags/#unsafely-treat-insecure-origin-as-secure</code>
              <span id="wsCopyHint" style="display:block;font-size:0.7rem;text-align:center;margin-top:4px;opacity:0.6;">Click to copy &middot; Paste in address bar &middot; Add this site &middot; Relaunch Chrome</span>
            </div>
            <div class="hint" style="text-align:center;font-size:0.78rem;font-style:italic;line-height:1.5;">Hold the BOOT button and power on the device. Start flashing while holding BOOT. Once progress reaches ~10%, release the BOOT button.</div>
          </div>

          <div class="method-section ${savedMethod === 'ota' ? 'active' : ''}" id="otaSection">
            ${hasPendant
              ? `<div class="status-msg show success">Pendant detected at ${pendant.ip}</div>`
              : '<div class="ota-warning">No pendant detected. Connect your pendant to use OTA flashing.</div>'
            }
            <div class="hint" style="text-align:center;font-size:0.78rem;font-style:italic;line-height:1.5;">OTA requires the pendant to already be running ncSender Pendant Firmware. For first-time setup, use USB.</div>
          </div>
        </div>

        <div class="ws-flash-progress" id="wsFlashProgress">
          <div class="ws-progress-bar-container">
            <div class="ws-progress-bar" id="wsProgressBar"></div>
          </div>
          <div class="ws-progress-text" id="wsProgressText">Initializing...</div>
          <div class="ws-flash-log" id="wsFlashLog"></div>
          <div class="ws-flash-result" id="wsFlashResult"></div>
        </div>
      </div>
    </div>

    <!-- Footer (changes per tab) -->
    <div class="plugin-dialog-footer">
      <div class="button-group" id="firmwareFooter">
        <button type="button" class="btn btn-secondary" id="fwCancelBtn" onclick="window.postMessage({type:'close-plugin-dialog'},'*')">Cancel</button>
        <button type="button" class="btn btn-primary" id="flashBtn" disabled>Flash Firmware</button>
        <button type="button" class="btn btn-secondary" id="wsRetryBtn" style="display:none">Retry</button>
        <button type="button" class="btn btn-primary" id="wsCloseBtn" style="display:none">Close</button>
      </div>
      <div class="button-group" id="licenseFooter" style="display:none;">
        <button type="button" class="btn btn-secondary" onclick="window.postMessage({type:'close-plugin-dialog'},'*')">Cancel</button>
        ${!isLicensed ? '<button type="button" class="btn btn-primary" id="activateBtn" disabled>Activate License</button>' : ''}
      </div>
    </div>

    <script>
      (function() {
        // --- Tab switching ---
        var tabs = document.querySelectorAll('.wp-tab');
        var tabContents = document.querySelectorAll('.wp-tab-content');
        var licenseFooter = document.getElementById('licenseFooter');
        var firmwareFooter = document.getElementById('firmwareFooter');

        tabs.forEach(function(tab) {
          tab.addEventListener('click', function() {
            if (window._wsFlashing) return;
            var target = tab.getAttribute('data-tab');
            tabs.forEach(function(t) { t.classList.remove('active'); });
            tabContents.forEach(function(c) { c.classList.remove('active'); });
            tab.classList.add('active');
            document.getElementById('wp-tab-' + target).classList.add('active');

            licenseFooter.style.display = target === 'license' ? 'flex' : 'none';
            firmwareFooter.style.display = target === 'firmware' ? 'flex' : 'none';
          });
        });

        // --- License tab ---
        var hasPendant = ${hasPendant ? 'true' : 'false'};
        var machineId = ${hasPendant ? JSON.stringify(pendant.machineId) : 'null'};
        var productName = ${hasPendant ? JSON.stringify(pendant.productName || '') : 'null'};
        var activateBtn = document.getElementById('activateBtn');
        var installationIdInput = document.getElementById('installationId');

        function formatInstallationId(raw) {
          var clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 36);
          var parts = clean.match(/.{1,6}/g);
          return parts ? parts.join('-') : '';
        }

        function isInstallationIdValid() {
          if (!installationIdInput) return false;
          var raw = installationIdInput.value.replace(/[^A-Za-z0-9]/g, '');
          return raw.length === 36;
        }

        function updateActivateBtn() {
          if (activateBtn) {
            activateBtn.disabled = !hasPendant || !isInstallationIdValid();
          }
        }

        if (installationIdInput) {
          installationIdInput.addEventListener('input', function() {
            var pos = this.selectionStart;
            var oldLen = this.value.length;
            this.value = formatInstallationId(this.value);
            var newLen = this.value.length;
            var newPos = pos + (newLen - oldLen);
            this.setSelectionRange(newPos, newPos);
            updateActivateBtn();
          });
        }

        if (activateBtn) {
          activateBtn.addEventListener('click', function() {
            var instId = installationIdInput.value.trim().toUpperCase();
            window.postMessage({
              type: 'close-plugin-dialog',
              data: { action: 'activate', machineId: machineId, installationId: instId, productName: productName }
            }, '*');
          });
        }

        updateActivateBtn();

        // --- Firmware tab ---
        var ports = ${portsJson};
        var pendantIp = ${hasPendant ? JSON.stringify(pendant.ip) : 'null'};
        var fileBase64 = null;
        var selectedFileName = null;

        var portSelect = document.getElementById('serialPort');
        var fileInput = document.getElementById('firmwareFile');
        var fileNameEl = document.getElementById('fileName');
        var flashBtn = document.getElementById('flashBtn');
        var usbSection = document.getElementById('usbSection');
        var otaSection = document.getElementById('otaSection');
        var methodRadios = document.querySelectorAll('input[name="method"]');

        // --- Web Serial detection ---
        var hasWebSerial = 'serial' in navigator;
        var isChromium = !!window.chrome;
        var useWebSerial = hasWebSerial && window.isSecureContext;
        var wsPort = null;
        var firmwareBytes = null;
        var usbServerMode = document.getElementById('usbServerMode');
        var usbWebSerialMode = document.getElementById('usbWebSerialMode');
        var wsSecureWarning = document.getElementById('wsSecureWarning');
        var wsSelectPortBtn = document.getElementById('wsSelectPortBtn');
        var wsFirmwareForm = document.getElementById('wsFirmwareForm');
        var wsFlashProgress = document.getElementById('wsFlashProgress');
        var wsProgressBar = document.getElementById('wsProgressBar');
        var wsProgressText = document.getElementById('wsProgressText');
        var wsFlashLog = document.getElementById('wsFlashLog');
        var wsFlashResult = document.getElementById('wsFlashResult');
        var wsCloseBtn = document.getElementById('wsCloseBtn');
        var wsRetryBtn = document.getElementById('wsRetryBtn');
        var fwCancelBtn = document.getElementById('fwCancelBtn');

        if (useWebSerial) {
          usbServerMode.style.display = 'none';
          usbWebSerialMode.style.display = 'block';
        } else if (isChromium && !window.isSecureContext) {
          wsSecureWarning.style.display = 'block';
          var wsCopyUrl = document.getElementById('wsCopyUrl');
          var wsCopyHint = document.getElementById('wsCopyHint');
          if (wsCopyUrl) {
            wsCopyUrl.addEventListener('click', function() {
              var ta = document.createElement('textarea');
              ta.value = wsCopyUrl.textContent.trim();
              ta.style.cssText = 'position:fixed;left:-9999px;';
              document.body.appendChild(ta);
              ta.select();
              var ok = false;
              try { ok = document.execCommand('copy'); } catch(e) {}
              document.body.removeChild(ta);
              if (ok) {
                wsCopyUrl.classList.add('copied');
                wsCopyHint.textContent = 'Copied! Paste in Chrome address bar.';
                setTimeout(function() { wsCopyUrl.classList.remove('copied'); }, 2000);
              } else {
                var range = document.createRange();
                range.selectNodeContents(wsCopyUrl);
                var sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
                wsCopyHint.textContent = 'Selected! Press Ctrl+C to copy.';
              }
            });
          }
        }

        ports.forEach(function(p) {
          var opt = document.createElement('option');
          opt.value = p.path;
          opt.textContent = p.path + (p.manufacturer ? ' (' + p.manufacturer + ')' : '');
          portSelect.appendChild(opt);
        });

        if (ports.length === 0) {
          var opt = document.createElement('option');
          opt.value = '';
          opt.textContent = 'No ports detected';
          portSelect.appendChild(opt);
        }

        function getMethod() {
          return document.querySelector('input[name="method"]:checked').value;
        }

        methodRadios.forEach(function(radio) {
          radio.addEventListener('change', function() {
            var method = getMethod();
            usbSection.classList.toggle('active', method === 'usb');
            otaSection.classList.toggle('active', method === 'ota');
            updateFlashBtn();
          });
        });

        fileInput.addEventListener('change', function() {
          var file = fileInput.files[0];
          if (!file) return;
          selectedFileName = file.name;
          fileNameEl.textContent = file.name;
          fileNameEl.classList.add('has-file');

          var reader = new FileReader();
          reader.onload = function() {
            var bytes = new Uint8Array(reader.result);
            var binary = '';
            for (var i = 0; i < bytes.length; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            fileBase64 = btoa(binary);
            firmwareBytes = binary;
            updateFlashBtn();
          };
          reader.readAsArrayBuffer(file);
        });

        function updateFlashBtn() {
          var hasFile = fileBase64 !== null;
          var method = getMethod();
          var valid = hasFile;
          if (method === 'usb') {
            if (useWebSerial) {
              valid = valid && wsPort !== null;
            } else {
              valid = valid && portSelect.value !== '';
            }
          } else {
            valid = valid && hasPendant;
          }
          flashBtn.disabled = !valid;
        }

        portSelect.addEventListener('change', updateFlashBtn);
        updateFlashBtn();

        flashBtn.addEventListener('click', function() {
          var method = getMethod();
          if (method === 'usb' && useWebSerial && wsPort) {
            doWebSerialFlash().catch(function(err) {
              console.error('Web Serial flash error:', err);
            });
            return;
          }
          var response = {
            action: 'flash',
            firmwareBase64: fileBase64,
            firmwareFileName: selectedFileName || 'firmware.bin',
            method: method
          };
          if (method === 'usb') {
            response.port = portSelect.value;
            response.baudRate = '115200';
          } else {
            response.pendantIp = pendantIp;
          }
          window.postMessage({ type: 'close-plugin-dialog', data: response }, '*');
        });

        // --- Web Serial port selection ---
        if (wsSelectPortBtn) {
          wsSelectPortBtn.addEventListener('click', async function() {
            try {
              wsPort = await navigator.serial.requestPort({
                filters: [
                  { usbVendorId: 0x10C4 },
                  { usbVendorId: 0x1A86 },
                  { usbVendorId: 0x0403 },
                  { usbVendorId: 0x303A }
                ]
              });
              var info = wsPort.getInfo();
              var label = 'Port selected';
              if (info.usbVendorId) {
                label = 'USB device (0x' + info.usbVendorId.toString(16).toUpperCase() + ')';
              }
              wsSelectPortBtn.textContent = label;
              wsSelectPortBtn.classList.add('has-port');
              updateFlashBtn();
            } catch (e) {
              // User cancelled the port picker
            }
          });
        }

        // --- Web Serial close button ---
        if (wsCloseBtn) {
          wsCloseBtn.addEventListener('click', function() {
            window.postMessage({ type: 'close-plugin-dialog', data: {
              action: 'web-serial-done',
              baudRate: '115200'
            }}, '*');
          });
        }

        // --- Web Serial retry button ---
        if (wsRetryBtn) {
          wsRetryBtn.addEventListener('click', function() {
            wsFirmwareForm.classList.remove('hidden');
            wsFlashProgress.classList.remove('active');
            wsProgressBar.style.width = '0%';
            wsProgressText.textContent = 'Initializing...';
            wsFlashLog.textContent = '';
            wsFlashResult.className = 'ws-flash-result';
            wsFlashResult.textContent = '';
            fwCancelBtn.style.display = '';
            flashBtn.style.display = '';
            wsCloseBtn.style.display = 'none';
            wsRetryBtn.style.display = 'none';
            updateFlashBtn();
          });
        }

        // --- Web Serial flash ---
        async function doWebSerialFlash() {
          window._wsFlashing = true;
          var baudrate = 115200;

          // Hide form, show inline progress
          wsFirmwareForm.classList.add('hidden');
          wsFlashProgress.classList.add('active');
          fwCancelBtn.style.display = 'none';
          flashBtn.style.display = 'none';

          function wsAppendLog(text) {
            wsFlashLog.textContent += text + '\\n';
            wsFlashLog.scrollTop = wsFlashLog.scrollHeight;
          }

          function wsShowResult(type, msg) {
            wsFlashResult.className = 'ws-flash-result ' + type;
            wsFlashResult.textContent = msg;
            wsCloseBtn.style.display = '';
            if (type === 'error') wsRetryBtn.style.display = '';
            window._wsFlashing = false;
          }

          var transport = null;

          try {
            wsAppendLog('Loading esptool-js...');
            wsProgressText.textContent = 'Loading esptool-js...';

            var esptoolModule = await import('https://esm.run/esptool-js');
            var ESPLoader = esptoolModule.ESPLoader;
            var Transport = esptoolModule.Transport;

            wsAppendLog('Creating transport...');
            wsProgressText.textContent = 'Connecting to device...';

            transport = new Transport(wsPort, true);

            var espTerminal = {
              clean: function() {},
              writeLine: function(data) { wsAppendLog(data); },
              write: function(data) { wsAppendLog(data); }
            };

            var loader = new ESPLoader({
              transport: transport,
              baudrate: baudrate,
              terminal: espTerminal
            });

            wsAppendLog('Connecting to ESP32...');
            await loader.main();
            wsAppendLog('Connected. Chip: ' + (loader.chipName || 'unknown'));

            wsProgressText.textContent = 'Flashing firmware...';
            wsAppendLog('Starting flash at address 0x10000...');

            await loader.writeFlash({
              fileArray: [{ data: firmwareBytes, address: 0x10000 }],
              flashSize: 'keep',
              compress: true,
              reportProgress: function(fileIndex, written, total) {
                var pct = Math.round((written / total) * 100);
                wsProgressBar.style.width = pct + '%';
                wsProgressText.textContent = 'Flashing... ' + pct + '%';
              }
            });

            wsProgressBar.style.width = '100%';
            wsProgressText.textContent = 'Flash complete!';
            wsAppendLog('Flash complete. Resetting device...');

            try { await loader.hardReset(); } catch(e) { wsAppendLog('Note: Hard reset skipped'); }

            wsShowResult('success', 'Firmware flashed successfully.');
          } catch (err) {
            var errMsg = (err && err.message) ? err.message : String(err);
            wsAppendLog('ERROR: ' + errMsg);
            wsProgressText.textContent = 'Flash failed';
            wsShowResult('error', 'Flash failed: ' + errMsg);
          } finally {
            if (transport) {
              try { await transport.disconnect(); } catch(e) {}
            }
          }
        }

        // --- View Details button ---
        var fwViewDetailsBtn = document.getElementById('fwViewDetailsBtn');
        if (fwViewDetailsBtn) {
          fwViewDetailsBtn.addEventListener('click', function() {
            window.postMessage({
              type: 'close-plugin-dialog',
              data: { action: 'show-update-details' }
            }, '*');
          });
        }
      })();
    </script>
  `;
}

// --- Update Details Dialog ---

function buildUpdateDetailsHtml(firmwareUpdate, pendant) {
  const hasPendant = pendant !== null;
  const pendantIp = hasPendant ? pendant.ip : null;

  let publishedLine = '';
  if (firmwareUpdate.publishedAt) {
    try {
      const d = new Date(firmwareUpdate.publishedAt);
      publishedLine = `<div class="fud-published">Published: ${d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</div>`;
    } catch {}
  }

  return /* html */ `
    <style>
      .fud-container {
        display: flex;
        flex-direction: column;
        gap: 16px;
        padding: 20px;
        max-width: 560px;
      }
      .fud-versions {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 16px;
        padding: 12px;
        background: var(--color-surface-muted);
        border-radius: var(--radius-small);
      }
      .fud-version-block {
        text-align: center;
      }
      .fud-version-label {
        font-size: 0.75rem;
        color: var(--color-text-secondary);
        margin-bottom: 4px;
      }
      .fud-version-value {
        font-family: monospace;
        font-size: 1.1rem;
        font-weight: 600;
        color: var(--color-text-primary);
      }
      .fud-arrow {
        font-size: 1.2rem;
        color: var(--color-text-secondary);
      }
      .fud-published {
        font-size: 0.8rem;
        color: var(--color-text-secondary);
        text-align: center;
      }
      .fud-notes-label {
        font-size: 0.85rem;
        font-weight: 600;
        color: var(--color-text-primary);
      }
      .fud-notes {
        max-height: 200px;
        overflow-y: auto;
        padding: 10px;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-small);
        font-size: 0.8rem;
        color: var(--color-text-secondary);
        white-space: pre-wrap;
        word-break: break-word;
        line-height: 1.5;
      }
      .fud-footer {
        display: flex;
        gap: 10px;
        justify-content: center;
        padding-top: 4px;
      }
      .fud-btn {
        padding: 10px 20px;
        border: none;
        border-radius: var(--radius-small);
        font-size: 0.9rem;
        font-weight: 500;
        cursor: pointer;
        transition: opacity 0.2s;
      }
      .fud-btn:hover { opacity: 0.9; }
      .fud-btn-primary {
        background: var(--color-accent);
        color: white;
      }
      .fud-btn-secondary {
        background: var(--color-surface-muted);
        color: var(--color-text-primary);
        border: 1px solid var(--color-border);
      }
    </style>

    <div class="fud-container">
      <div class="fud-versions">
        <div class="fud-version-block">
          <div class="fud-version-label">Current</div>
          <div class="fud-version-value">v${escapeHtml(firmwareUpdate.currentVersion)}</div>
        </div>
        <div class="fud-arrow">&rarr;</div>
        <div class="fud-version-block">
          <div class="fud-version-label">Latest</div>
          <div class="fud-version-value">v${escapeHtml(firmwareUpdate.latestVersion)}</div>
        </div>
      </div>

      ${publishedLine}

      ${firmwareUpdate.releaseNotes ? `
        <div>
          <div class="fud-notes-label">Release Notes</div>
          <div class="fud-notes">${escapeHtml(firmwareUpdate.releaseNotes)}</div>
        </div>
      ` : ''}

      <div class="fud-footer">
        <button type="button" class="fud-btn fud-btn-secondary" id="fudCloseBtn">Close</button>
        ${firmwareUpdate.downloadUrl && hasPendant ? `<button type="button" class="fud-btn fud-btn-primary" id="fudDownloadBtn">Download &amp; Flash OTA</button>` : ''}
      </div>
    </div>

    <script>
      (function() {
        var closeBtn = document.getElementById('fudCloseBtn');
        if (closeBtn) {
          closeBtn.addEventListener('click', function() {
            window.postMessage({ type: 'close-plugin-dialog' }, '*');
          });
        }

        var downloadBtn = document.getElementById('fudDownloadBtn');
        if (downloadBtn) {
          downloadBtn.addEventListener('click', function() {
            window.postMessage({
              type: 'close-plugin-dialog',
              data: {
                action: 'download-and-flash',
                downloadUrl: ${firmwareUpdate.downloadUrl ? JSON.stringify(firmwareUpdate.downloadUrl) : 'null'},
                pendantIp: ${pendantIp ? JSON.stringify(pendantIp) : 'null'},
                latestVersion: ${JSON.stringify(firmwareUpdate.latestVersion)}
              }
            }, '*');
          });
        }
      })();
    </script>
  `;
}

// --- Progress Modal ---

function buildProgressModalHtml() {
  return /* html */ `
    <style>
      .flash-progress {
        padding: 1.25rem;
      }
      .progress-bar-container {
        width: 100%;
        height: 8px;
        background: var(--color-surface-muted);
        border-radius: 4px;
        overflow: hidden;
        margin-bottom: 8px;
      }
      .progress-bar {
        height: 100%;
        width: 0%;
        background: var(--color-accent);
        border-radius: 4px;
        transition: width 0.3s ease;
      }
      .progress-text {
        font-size: 0.85rem;
        color: var(--color-text-secondary);
        margin-bottom: 12px;
      }
      .flash-log {
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-small);
        padding: 10px;
        font-family: monospace;
        font-size: 0.8rem;
        color: var(--color-text-secondary);
        max-height: 200px;
        overflow-y: auto;
        white-space: pre-wrap;
        word-break: break-all;
      }
      .flash-result {
        margin-top: 12px;
        padding: 10px;
        border-radius: var(--radius-small);
        font-size: 0.85rem;
        text-align: center;
        display: none;
      }
      .flash-result.success {
        display: block;
        background: #28a74520;
        border: 1px solid #28a745;
        color: #28a745;
      }
      .flash-result.error {
        display: block;
        background: #dc354520;
        border: 1px solid #dc3545;
        color: #dc3545;
      }
    </style>

    <div style="background: var(--color-surface); border: 1px solid var(--color-border); border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.4); min-width: 400px; max-width: 500px; overflow: hidden;">
      <div style="padding: 1rem 1.25rem; border-bottom: 1px solid var(--color-border); text-align: center;">
        <h3 id="flashTitle" style="margin: 0; font-size: 1.1rem; font-weight: 600; color: var(--color-text-primary);">Flashing Firmware...</h3>
      </div>
      <div class="flash-progress">
        <div class="progress-bar-container">
          <div class="progress-bar" id="progressBar"></div>
        </div>
        <div class="progress-text" id="progressText">Initializing...</div>
        <div class="flash-log" id="flashLog"></div>
        <div class="flash-result" id="flashResult"></div>
      </div>
      <div id="flashFooter" style="padding: 0.75rem 1.25rem; border-top: 1px solid var(--color-border); text-align: center; display: none;">
        <button onclick="window.postMessage({ type: 'close-modal' }, '*')" style="padding: 8px 32px; border-radius: var(--radius-small); background: var(--color-accent); border: none; color: white; font-size: 0.9rem; cursor: pointer;">OK</button>
      </div>
    </div>

    <script>
      (function() {
        var progressBar = document.getElementById('progressBar');
        var progressText = document.getElementById('progressText');
        var flashLog = document.getElementById('flashLog');
        var flashTitle = document.getElementById('flashTitle');
        var flashResult = document.getElementById('flashResult');
        var flashFooter = document.getElementById('flashFooter');

        function appendLog(text) {
          flashLog.textContent += text + '\\n';
          flashLog.scrollTop = flashLog.scrollHeight;
        }

        function handleMessage(type, data) {
          if (type === 'pendant-flash:progress') {
            if (data.percent !== undefined) {
              progressBar.style.width = data.percent + '%';
              progressText.textContent = (data.message || 'Flashing...') + ' (' + Math.round(data.percent) + '%)';
            } else if (data.message) {
              progressText.textContent = data.message;
            }
            if (data.log) appendLog(data.log);
          } else if (type === 'pendant-flash:complete') {
            progressBar.style.width = '100%';
            flashTitle.textContent = 'Flash Complete';
            progressText.textContent = 'Firmware flashed successfully';
            flashResult.className = 'flash-result success';
            flashResult.textContent = data.message || 'Firmware has been flashed successfully.';
            flashFooter.style.display = 'block';
            if (data.log) appendLog(data.log);
            if (ws) ws.close();
          } else if (type === 'pendant-flash:error') {
            flashTitle.textContent = 'Flash Failed';
            progressText.textContent = 'An error occurred';
            flashResult.className = 'flash-result error';
            flashResult.textContent = data.message || 'Flashing failed. Check the log for details.';
            flashFooter.style.display = 'block';
            if (data.log) appendLog(data.log);
            if (ws) ws.close();
          }
        }

        var wsUrl;
        if (window.location.port === '5174') {
          wsUrl = 'ws://' + window.location.hostname + ':8090';
        } else if (window.location.protocol === 'file:') {
          wsUrl = 'ws://localhost:8090';
        } else {
          var u = new URL(window.location.origin);
          u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
          wsUrl = u.toString();
        }

        var ws = new WebSocket(wsUrl);
        ws.onmessage = function(event) {
          try {
            var msg = JSON.parse(event.data);
            if (msg && msg.type && msg.type.startsWith('pendant-flash:')) {
              handleMessage(msg.type, msg.data || {});
            }
          } catch (e) {}
        };
        ws.onerror = function() {
          appendLog('[WebSocket error - progress updates may not display]');
        };
      })();
    </script>
  `;
}

// --- Result Modal ---

function buildResultContent(title, message, type) {
  const colorMap = {
    success: { bg: '#28a74520', border: '#28a745', text: '#28a745' },
    error: { bg: '#dc354520', border: '#dc3545', text: '#dc3545' }
  };
  const colors = colorMap[type] || colorMap.error;

  return /* html */ `
    <div style="background: var(--color-surface); border: 1px solid var(--color-border); border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.4); min-width: 340px; max-width: 450px; overflow: hidden;">
      <div style="padding: 1rem 1.25rem; border-bottom: 1px solid var(--color-border); text-align: center;">
        <h3 style="color: var(--color-text-primary); margin: 0; font-size: 1.1rem; font-weight: 600;">${title}</h3>
      </div>
      <div style="padding: 1.25rem;">
        <div style="padding: 12px; border-radius: var(--radius-small); background: ${colors.bg}; border: 1px solid ${colors.border}; color: ${colors.text}; font-size: 0.9rem; text-align: center;">
          ${message}
        </div>
      </div>
      <div style="padding: 0.75rem 1.25rem; border-top: 1px solid var(--color-border); text-align: center;">
        <button onclick="window.postMessage({ type: 'close-modal' }, '*')" style="padding: 8px 32px; border-radius: var(--radius-small); background: var(--color-accent); border: none; color: white; font-size: 0.9rem; cursor: pointer;">OK</button>
      </div>
    </div>
  `;
}

// --- Plugin Lifecycle ---

export async function onLoad(ctx) {
  ctx.log('Wireless Pendant Flasher plugin loaded');

  const tracker = new PendantTracker(ctx);

  ctx.registerEventHandler('client:connected', (data) => {
    if (data.product === 'ncSenderPendant') {
      ctx.log('Pendant connected:', data.machineId, 'ip:', data.ip);
    }
  });

  ctx.registerEventHandler('client:disconnected', (data) => {
    if (data.product === 'ncSenderPendant') {
      ctx.log('Pendant disconnected:', data.machineId);
    }
  });

  ctx.registerToolMenu('Wireless Pendant', async () => {
    const ports = await getSerialPorts();
    const savedSettings = ctx.getSettings() || {};
    const pendant = tracker.getInfo();

    let firmwareUpdate = null;
    if (pendant && pendant.version) {
      try {
        const release = await fetchLatestFirmwareRelease();
        firmwareUpdate = {
          currentVersion: pendant.version,
          latestVersion: release.latestVersion,
          hasUpdate: compareVersions(release.latestVersion, pendant.version) > 0,
          releaseNotes: release.releaseNotes,
          downloadUrl: release.downloadUrl,
          releaseUrl: release.releaseUrl,
          publishedAt: release.publishedAt
        };
      } catch (err) {
        ctx.log('Failed to check firmware updates:', err?.message || err);
        firmwareUpdate = { error: 'Could not check for firmware updates' };
      }
    }

    const dialogHtml = buildDialogHtml(ports, pendant, savedSettings, firmwareUpdate);
    const response = await ctx.showDialog('Wireless Pendant', dialogHtml, { closable: true, width: '500px' });

    if (!response || !response.action) return;

    // --- Handle: Web Serial done (browser-side flash completed) ---
    if (response.action === 'web-serial-done') {
      ctx.setSettings({
        ...savedSettings,
        lastMethod: 'usb',
        lastBaudRate: response.baudRate || savedSettings.lastBaudRate
      });
      return;
    }

    // --- Handle: Show Update Details ---
    if (response.action === 'show-update-details' && firmwareUpdate && firmwareUpdate.hasUpdate) {
      const detailsHtml = buildUpdateDetailsHtml(firmwareUpdate, pendant);
      const detailsResponse = await ctx.showDialog('Firmware Update', detailsHtml, { closable: true, width: '560px' });

      if (detailsResponse && detailsResponse.action === 'download-and-flash') {
        // Fall through to download-and-flash handler below
        Object.assign(response, detailsResponse);
      } else {
        return;
      }
    }

    // --- Handle: Download & Flash OTA ---
    if (response.action === 'download-and-flash') {
      const { downloadUrl, pendantIp, latestVersion } = response;

      ctx.log('Download & Flash OTA:', downloadUrl, 'target:', pendantIp);
      ctx.showModal(buildProgressModalHtml(), { closable: false });

      const tmpDir = os.tmpdir();
      const binPath = path.join(tmpDir, `pendant-firmware-${latestVersion}-${Date.now()}.bin`);

      const broadcastProgress = (percent, message, log) => {
        ctx.broadcast('pendant-flash:progress', { percent, message, log });
      };

      try {
        broadcastProgress(undefined, 'Downloading firmware...', `Downloading from GitHub...\nVersion: ${latestVersion}`);

        const dlResponse = await fetch(downloadUrl);
        if (!dlResponse.ok) {
          throw new Error(`Download failed (HTTP ${dlResponse.status})`);
        }

        const arrayBuffer = await dlResponse.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        await fs.writeFile(binPath, buffer);
        ctx.log('Firmware downloaded to temp file:', binPath, `(${buffer.length} bytes)`);

        broadcastProgress(0, 'Starting OTA flash...', `Target: ${pendantIp}\nFirmware size: ${buffer.length} bytes`);

        const flasher = flashOTA({ binPath, pendantIp });

        await new Promise((resolve, reject) => {
          flasher.on('progress', (percent, msg) => broadcastProgress(percent, msg));
          flasher.on('message', (msg) => broadcastProgress(undefined, msg, msg));
          flasher.on('error', (msg) => {
            ctx.broadcast('pendant-flash:error', { message: msg, log: msg });
            reject(new Error(msg));
          });
          flasher.on('complete', (msg) => {
            ctx.broadcast('pendant-flash:complete', { message: msg || 'Firmware updated successfully via OTA.' });
            resolve();
          });
        });
      } catch (err) {
        ctx.log('Download & Flash failed:', err?.message || err);
        ctx.broadcast('pendant-flash:error', {
          message: err?.message || 'Download & Flash failed',
          log: err?.message || 'Unknown error'
        });
      } finally {
        try {
          await fs.unlink(binPath);
          ctx.log('Cleaned up temp file:', binPath);
        } catch {
          // ignore cleanup errors
        }
      }
      return;
    }

    // --- Handle: Activate License ---
    if (response.action === 'activate') {
      const { machineId, installationId, productName } = response;

      ctx.setSettings({ ...savedSettings, lastInstallationId: installationId });
      ctx.log('Activating pendant license:', installationId, 'machineId:', machineId, 'product:', productName);

      ctx.showModal(/* html */ `
        <div style="background: var(--color-surface); border: 1px solid var(--color-border); border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.4); min-width: 340px; max-width: 450px; overflow: hidden;">
          <div style="padding: 1rem 1.25rem; border-bottom: 1px solid var(--color-border); text-align: center;">
            <h3 style="margin: 0; font-size: 1.1rem; font-weight: 600; color: var(--color-text-primary);">Activating License...</h3>
          </div>
          <div style="padding: 1.5rem; text-align: center;">
            <div style="margin-bottom: 12px;">
              <span style="display:inline-block;width:20px;height:20px;border:3px solid var(--color-border);border-top-color:var(--color-accent);border-radius:50%;animation:spin 0.8s linear infinite;"></span>
            </div>
            <p style="color: var(--color-text-secondary); margin: 0; font-size: 0.85rem;">Contacting activation server</p>
          </div>
        </div>
        <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
      `, { closable: false });

      try {
        const licenseData = await activateWithServer(installationId, machineId, productName);
        ctx.log('Activation server returned license data');

        ctx.emitToClient('license-data', licenseData);

        ctx.showModal(buildResultContent('License Activated', 'License data has been sent to the pendant.', 'success'));
      } catch (err) {
        ctx.log('License activation failed:', err?.message || err);
        ctx.showModal(buildResultContent('Activation Failed', err?.message || 'An unknown error occurred during activation.', 'error'));
      }
      return;
    }

    // --- Handle: Flash Firmware ---
    if (response.action === 'flash') {
      const { firmwareBase64, firmwareFileName, method, port, baudRate, pendantIp } = response;

      ctx.setSettings({
        ...savedSettings,
        lastMethod: method,
        lastBaudRate: baudRate || savedSettings.lastBaudRate
      });

      const tmpDir = os.tmpdir();
      const binPath = path.join(tmpDir, `pendant-firmware-${Date.now()}.bin`);

      try {
        const buffer = Buffer.from(firmwareBase64, 'base64');
        await fs.writeFile(binPath, buffer);
        ctx.log('Firmware written to temp file:', binPath, `(${buffer.length} bytes)`);
      } catch (err) {
        ctx.log('Failed to write firmware to temp file:', err);
        ctx.showModal(buildResultContent('Error', 'Failed to prepare firmware file for flashing.', 'error'));
        return;
      }

      ctx.showModal(buildProgressModalHtml(), { closable: false });

      const broadcastProgress = (percent, message, log) => {
        ctx.broadcast('pendant-flash:progress', { percent, message, log });
      };

      try {
        const pluginDir = getPluginDir();

        if (method === 'usb') {
          ctx.log('Starting USB flash:', port, 'baud:', baudRate);
          broadcastProgress(0, 'Starting USB flash...', `Port: ${port}\nBaud: ${baudRate}\nFile: ${firmwareFileName}`);

          const flasher = flashUSB({ binPath, port, baudRate: parseInt(baudRate, 10), pluginDir });

          await new Promise((resolve, reject) => {
            flasher.on('progress', (percent, msg) => broadcastProgress(percent, msg));
            flasher.on('message', (msg) => broadcastProgress(undefined, msg, msg));
            flasher.on('error', (msg) => {
              ctx.broadcast('pendant-flash:error', { message: msg, log: msg });
              reject(new Error(msg));
            });
            flasher.on('complete', (msg) => {
              ctx.broadcast('pendant-flash:complete', { message: msg || 'Firmware flashed successfully.' });
              resolve();
            });
          });
        } else {
          ctx.log('Starting OTA flash:', pendantIp);
          broadcastProgress(0, 'Starting OTA flash...', `Target: ${pendantIp}\nFile: ${firmwareFileName}`);

          const flasher = flashOTA({ binPath, pendantIp });

          await new Promise((resolve, reject) => {
            flasher.on('progress', (percent, msg) => broadcastProgress(percent, msg));
            flasher.on('message', (msg) => broadcastProgress(undefined, msg, msg));
            flasher.on('error', (msg) => {
              ctx.broadcast('pendant-flash:error', { message: msg, log: msg });
              reject(new Error(msg));
            });
            flasher.on('complete', (msg) => {
              ctx.broadcast('pendant-flash:complete', { message: msg || 'Firmware flashed successfully via OTA.' });
              resolve();
            });
          });
        }
      } catch (err) {
        ctx.log('Flash failed:', err?.message || err);
      } finally {
        try {
          await fs.unlink(binPath);
          ctx.log('Cleaned up temp file:', binPath);
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }, { icon: 'logo.png', clientOnly: true });
}

export async function onUnload(ctx) {
  ctx.log('Wireless Pendant Flasher plugin unloaded');
}
