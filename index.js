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

async function activatePendant(pendantIp, licenseData) {
  const url = `http://${pendantIp}/api/activate`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(licenseData),
    signal: AbortSignal.timeout(10000)
  });

  const text = await response.text();

  if (!response.ok) {
    let message = `Pendant activation failed (HTTP ${response.status})`;
    try {
      const err = JSON.parse(text);
      if (err.error || err.message) message = err.error || err.message;
    } catch {}
    throw new Error(message);
  }

  return text ? JSON.parse(text) : { success: true };
}

// --- Main Dialog ---

function buildDialogHtml(ports, savedSettings) {
  const portsJson = JSON.stringify(ports);
  const savedIp = savedSettings.lastPendantIp || '';
  const savedInstallationId = savedSettings.lastInstallationId || '';

  return /* html */ `
    <style>
      .wp-container {
        padding: 20px;
        display: flex;
        flex-direction: column;
        gap: 16px;
        width: 480px;
        position: relative;
      }
      .form-group {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .form-group label {
        font-size: 0.85rem;
        font-weight: 500;
        color: var(--color-text-primary);
      }
      .form-group .hint {
        font-size: 0.75rem;
        color: var(--color-text-secondary);
        text-align: center;
      }
      .form-row {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .form-row input {
        flex: 1;
      }
      .form-row .btn {
        flex-shrink: 0;
      }
      input[type="text"], select {
        padding: 0 10px;
        height: 36px;
        width: 100%;
        box-sizing: border-box;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-small);
        font-size: 0.9rem;
        background: var(--color-surface);
        color: var(--color-text-primary);
      }
      input:focus, select:focus {
        outline: none;
        border-color: var(--color-accent);
      }
      .btn {
        padding: 0 16px;
        height: 36px;
        border: none;
        border-radius: var(--radius-small);
        font-size: 0.85rem;
        font-weight: 500;
        cursor: pointer;
        transition: opacity 0.2s;
        white-space: nowrap;
        text-align: center;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
      }
      .btn:hover { opacity: 0.9; }
      .btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .btn-primary { background: var(--color-accent); color: white; }
      .btn-secondary {
        background: var(--color-surface-muted);
        color: var(--color-text-primary);
        border: 1px solid var(--color-border);
      }
      .btn-success { background: #28a745; color: white; }
      .btn-full { width: 100%; }

      .status-msg {
        padding: 10px;
        border-radius: var(--radius-small);
        font-size: 0.85rem;
        text-align: center;
        margin-bottom: 12px;
      }
      .status-msg.error { background: #dc354520; border: 1px solid #dc3545; color: #dc3545; }
      .status-msg.success { background: #28a74520; border: 1px solid #28a745; color: #28a745; }
      .status-msg.info { background: #17a2b820; border: 1px solid #17a2b8; color: #17a2b8; }

      .device-info {
        background: var(--color-surface-muted);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-small);
        padding: 12px;
      }
      .device-info-row {
        display: flex;
        justify-content: space-between;
        padding: 4px 0;
        font-size: 0.85rem;
      }
      .device-info-label { color: var(--color-text-secondary); }
      .device-info-value { color: var(--color-text-primary); font-weight: 500; font-family: monospace; }
      .device-info-value.licensed { color: #28a745; }
      .device-info-value.not-licensed { color: #dc3545; }

      .action-buttons {
        display: flex;
        gap: 10px;
        justify-content: center;
        margin-top: 8px;
      }

      .section-divider {
        border-top: 1px solid var(--color-border);
        margin: 8px 0;
      }

      .activation-form {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .installation-id-input {
        font-family: monospace;
        font-size: 0.95rem;
        letter-spacing: 0.5px;
        text-transform: uppercase;
      }

      .accordion-trigger {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        padding: 12px 14px;
        background: var(--color-surface-muted);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-small);
        cursor: pointer;
        transition: all 0.2s ease;
        box-sizing: border-box;
      }
      .accordion-trigger:hover {
        background: var(--color-surface);
        border-color: var(--color-text-secondary);
      }
      .accordion-trigger.expanded {
        border-color: var(--color-accent);
        border-bottom-left-radius: 0;
        border-bottom-right-radius: 0;
        border-bottom-color: transparent;
      }
      .accordion-trigger-content {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .accordion-trigger-icon {
        width: 20px;
        height: 20px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        flex-shrink: 0;
      }
      .accordion-trigger-icon.activate {
        background: #28a74530;
        color: #28a745;
      }
      .accordion-trigger-icon.flash {
        background: var(--color-accent-muted, rgba(100, 180, 200, 0.2));
        color: var(--color-accent);
      }
      .accordion-trigger-label {
        font-size: 0.9rem;
        font-weight: 500;
        color: var(--color-text-primary);
      }
      .accordion-trigger-chevron {
        width: 16px;
        height: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--color-text-secondary);
        transition: transform 0.2s ease;
      }
      .accordion-trigger.expanded .accordion-trigger-chevron {
        transform: rotate(180deg);
      }
      .accordion-content {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 14px;
        background: var(--color-surface);
        border: 1px solid var(--color-accent);
        border-top: none;
        border-bottom-left-radius: var(--radius-small);
        border-bottom-right-radius: var(--radius-small);
        overflow: hidden;
        max-height: 0;
        opacity: 0;
        padding-top: 0;
        padding-bottom: 0;
        transition: all 0.25s ease;
      }
      .accordion-content.expanded {
        max-height: 400px;
        opacity: 1;
        padding-top: 14px;
        padding-bottom: 14px;
      }
      .file-picker {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .file-picker input[type="file"] { display: none; }
      .file-picker .file-name {
        flex: 1;
        padding: 0 12px;
        height: 36px;
        box-sizing: border-box;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-small);
        font-size: 0.85rem;
        background: var(--color-surface);
        color: var(--color-text-secondary);
        display: flex;
        align-items: center;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .file-picker .file-name.has-file { color: var(--color-text-primary); }
      .file-picker .btn { flex-shrink: 0; }

      .method-toggle {
        display: flex;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-small);
        overflow: hidden;
        height: 36px;
      }
      .method-toggle label {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        text-align: center;
        cursor: pointer;
        font-size: 0.85rem;
        font-weight: 500;
        background: var(--color-surface);
        color: var(--color-text-secondary);
        transition: background 0.2s, color 0.2s;
        padding: 0;
        margin: 0;
        box-sizing: border-box;
      }
      .method-toggle input[type="radio"] { display: none; }
      .method-toggle input[type="radio"]:checked + label {
        background: var(--color-accent);
        color: white;
      }

      .usb-options { margin-top: 8px; }

      .hidden { display: none !important; }

      /* In-dialog modal overlay */
      .dialog-overlay {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 100;
        opacity: 0;
        visibility: hidden;
        transition: opacity 0.2s ease, visibility 0.2s ease;
      }
      .dialog-overlay.visible {
        opacity: 1;
        visibility: visible;
      }
      .dialog-modal {
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-medium, 8px);
        padding: 20px 24px;
        min-width: 280px;
        max-width: 360px;
        text-align: center;
        box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      }
      .dialog-modal-title {
        font-size: 1rem;
        font-weight: 600;
        color: var(--color-text-primary);
        margin-bottom: 16px;
      }
      .dialog-modal-spinner {
        width: 32px;
        height: 32px;
        border: 3px solid var(--color-border);
        border-top-color: var(--color-accent);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
        margin: 0 auto 12px;
      }
      .dialog-modal-text {
        font-size: 0.85rem;
        color: var(--color-text-secondary);
        margin-bottom: 0;
      }
      .dialog-modal-icon {
        margin-bottom: 12px;
      }
      .dialog-modal-icon svg {
        width: 40px;
        height: 40px;
      }
      .dialog-modal-message {
        font-size: 0.9rem;
        color: var(--color-text-secondary);
        line-height: 1.5;
        margin: 0;
      }
      .dialog-modal-btn {
        margin-top: 16px;
        padding: 8px 24px;
        border: none;
        border-radius: var(--radius-small);
        font-size: 0.85rem;
        font-weight: 500;
        cursor: pointer;
        background: var(--color-accent);
        color: white;
      }
      .dialog-modal-progress {
        width: 100%;
        height: 6px;
        background: var(--color-surface-muted);
        border-radius: 3px;
        overflow: hidden;
        margin: 12px 0;
      }
      .dialog-modal-progress-bar {
        height: 100%;
        width: 0%;
        background: var(--color-accent);
        border-radius: 3px;
        transition: width 0.3s ease;
      }

      .spinner {
        display: inline-block;
        width: 14px;
        height: 14px;
        border: 2px solid rgba(255,255,255,0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
        margin-right: 6px;
        flex-shrink: 0;
      }
      @keyframes spin { to { transform: rotate(360deg); } }

      .plugin-dialog-footer {
        padding: 12px 16px;
        border-top: 1px solid var(--color-border);
        background: var(--color-surface);
        display: flex;
        justify-content: center;
      }
    </style>

    <div class="wp-container">
      <!-- Connect Section -->
      <div id="connectSection">
        <div id="connectStatus" class="status-msg hidden"></div>
        <div class="form-group">
          <label>Pendant IP Address</label>
          <div class="form-row">
            <input type="text" id="pendantIp" placeholder="192.168.1.100" value="${escapeHtml(savedIp)}" />
            <button type="button" class="btn btn-primary" id="connectBtn">Connect</button>
          </div>
          <span class="hint">Enter the IP address shown on your pendant display</span>
        </div>
      </div>

      <!-- Device Info Section (shown after connect) -->
      <div id="deviceSection" class="hidden">
        <div class="device-info">
          <div class="device-info-row">
            <span class="device-info-label">Device ID</span>
            <span class="device-info-value" id="deviceIdDisplay">-</span>
          </div>
          <div class="device-info-row">
            <span class="device-info-label">Model</span>
            <span class="device-info-value" id="deviceModelDisplay">-</span>
          </div>
          <div class="device-info-row">
            <span class="device-info-label">Firmware</span>
            <span class="device-info-value" id="firmwareDisplay">-</span>
          </div>
          <div class="device-info-row">
            <span class="device-info-label">License</span>
            <span class="device-info-value" id="licenseDisplay">-</span>
          </div>
        </div>

        <!-- Activation Section (shown if not licensed) -->
        <div id="activationSection" class="hidden">
          <div class="section-divider"></div>
          <div class="accordion-trigger" id="showActivateBtn">
            <div class="accordion-trigger-content">
              <span class="accordion-trigger-icon activate">&#9919;</span>
              <span class="accordion-trigger-label">Activate License</span>
            </div>
            <span class="accordion-trigger-chevron">&#9662;</span>
          </div>
          <div id="activateForm" class="accordion-content">
            <div class="form-group">
              <label>Installation ID</label>
              <input type="text" id="installationId" class="installation-id-input"
                     placeholder="XXXXXX-XXXXXX-XXXXXX-XXXXXX-XXXXXX-XXXXXX"
                     value="${escapeHtml(savedInstallationId)}" spellcheck="false" autocomplete="off" maxlength="41" />
              <span class="hint">Enter the Installation ID from your purchase email</span>
            </div>
            <button type="button" class="btn btn-success btn-full" id="activateBtn" disabled>Activate</button>
          </div>
          <div id="activateStatus" class="status-msg hidden"></div>
        </div>

        <!-- Flash Section -->
        <div id="flashSection">
          <div class="section-divider"></div>
          <div class="accordion-trigger" id="showFlashBtn">
            <div class="accordion-trigger-content">
              <span class="accordion-trigger-icon flash">&#8623;</span>
              <span class="accordion-trigger-label">Flash Firmware</span>
            </div>
            <span class="accordion-trigger-chevron">&#9662;</span>
          </div>

          <div id="flashForm" class="accordion-content">
            <div class="form-group">
              <label>Firmware File</label>
              <div class="file-picker">
                <span class="file-name" id="fileName">No file selected</span>
                <button type="button" class="btn btn-secondary" onclick="document.getElementById('firmwareFile').click()">Browse</button>
                <input type="file" id="firmwareFile" accept=".bin" />
              </div>
            </div>

            <div class="form-group">
              <label>Flash Method</label>
              <div class="method-toggle">
                <input type="radio" name="method" id="methodOta" value="ota" checked />
                <label for="methodOta">OTA (Wi-Fi)</label>
                <input type="radio" name="method" id="methodUsb" value="usb" />
                <label for="methodUsb">USB</label>
              </div>
            </div>

            <div id="usbOptions" class="usb-options hidden">
              <div class="form-group">
                <label>Serial Port</label>
                <select id="serialPort"></select>
              </div>
            </div>

            <button type="button" class="btn btn-primary btn-full" id="flashBtn" disabled>Flash</button>
          </div>
          <div id="flashStatus" class="status-msg hidden"></div>
        </div>
      </div>
    </div>

    <!-- In-dialog modal overlay -->
    <div class="dialog-overlay" id="dialogOverlay">
      <div class="dialog-modal">
        <div class="dialog-modal-icon hidden" id="overlayIcon"></div>
        <div id="overlaySpinner" class="dialog-modal-spinner"></div>
        <div class="dialog-modal-title" id="overlayTitle">Processing...</div>
        <div class="dialog-modal-progress hidden" id="overlayProgress">
          <div class="dialog-modal-progress-bar" id="overlayProgressBar"></div>
        </div>
        <p class="dialog-modal-message" id="overlayText">Please wait</p>
        <button type="button" class="dialog-modal-btn hidden" id="overlayCloseBtn">OK</button>
      </div>
    </div>

    <div class="plugin-dialog-footer">
      <button type="button" class="btn btn-secondary" onclick="window.postMessage({type:'close-plugin-dialog'},'*')">Close</button>
    </div>

    <script>
      (function() {
        var ports = ${portsJson};
        var deviceInfo = null;
        var fileBase64 = null;
        var selectedFileName = null;

        // Elements
        var pendantIpInput = document.getElementById('pendantIp');
        var connectBtn = document.getElementById('connectBtn');
        var connectStatus = document.getElementById('connectStatus');
        var connectSection = document.getElementById('connectSection');
        var deviceSection = document.getElementById('deviceSection');
        var activationSection = document.getElementById('activationSection');
        var showActivateBtn = document.getElementById('showActivateBtn');
        var activateForm = document.getElementById('activateForm');
        var flashSection = document.getElementById('flashSection');
        var showFlashBtn = document.getElementById('showFlashBtn');
        var flashForm = document.getElementById('flashForm');
        var installationIdInput = document.getElementById('installationId');
        var activateBtn = document.getElementById('activateBtn');
        var activateStatus = document.getElementById('activateStatus');
        var flashBtn = document.getElementById('flashBtn');
        var flashStatus = document.getElementById('flashStatus');
        var fileInput = document.getElementById('firmwareFile');
        var fileNameEl = document.getElementById('fileName');
        var portSelect = document.getElementById('serialPort');
        var usbOptions = document.getElementById('usbOptions');
        var methodRadios = document.querySelectorAll('input[name="method"]');

        // Overlay elements
        var dialogOverlay = document.getElementById('dialogOverlay');
        var overlayIcon = document.getElementById('overlayIcon');
        var overlayTitle = document.getElementById('overlayTitle');
        var overlaySpinner = document.getElementById('overlaySpinner');
        var overlayProgress = document.getElementById('overlayProgress');
        var overlayProgressBar = document.getElementById('overlayProgressBar');
        var overlayText = document.getElementById('overlayText');
        var overlayCloseBtn = document.getElementById('overlayCloseBtn');

        var successIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="#28a745" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>';
        var errorIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="#dc3545" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';

        // Overlay functions
        function showOverlay(title, text) {
          overlayIcon.classList.add('hidden');
          overlaySpinner.classList.remove('hidden');
          overlayTitle.textContent = title;
          overlayText.textContent = text;
          overlayText.classList.remove('hidden');
          overlayProgress.classList.add('hidden');
          overlayCloseBtn.classList.add('hidden');
          dialogOverlay.classList.add('visible');
        }

        function showOverlayProgress(title, text, percent) {
          overlayIcon.classList.add('hidden');
          overlaySpinner.classList.add('hidden');
          overlayTitle.textContent = title;
          overlayText.textContent = text;
          overlayText.classList.remove('hidden');
          overlayProgress.classList.remove('hidden');
          overlayProgressBar.style.width = percent + '%';
          overlayCloseBtn.classList.add('hidden');
          dialogOverlay.classList.add('visible');
        }

        function showOverlayResult(title, message, isSuccess, callback) {
          overlayIcon.innerHTML = isSuccess ? successIcon : errorIcon;
          overlayIcon.classList.remove('hidden');
          overlaySpinner.classList.add('hidden');
          overlayProgress.classList.add('hidden');
          overlayTitle.textContent = title;
          overlayText.textContent = message;
          overlayText.classList.remove('hidden');
          overlayCloseBtn.classList.remove('hidden');
          overlayCloseBtn.onclick = function() {
            hideOverlay();
            if (callback) callback();
          };
        }

        function hideOverlay() {
          dialogOverlay.classList.remove('visible');
        }

        // Populate port dropdown
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

        // Accordion toggle functions
        function collapseAll() {
          showActivateBtn.classList.remove('expanded');
          activateForm.classList.remove('expanded');
          showFlashBtn.classList.remove('expanded');
          flashForm.classList.remove('expanded');
        }

        function toggleSection(trigger, content) {
          var isExpanded = content.classList.contains('expanded');
          collapseAll();
          if (!isExpanded) {
            trigger.classList.add('expanded');
            content.classList.add('expanded');
          }
        }

        // Activate section toggle
        showActivateBtn.addEventListener('click', function() {
          toggleSection(showActivateBtn, activateForm);
        });

        // Flash section toggle
        showFlashBtn.addEventListener('click', function() {
          toggleSection(showFlashBtn, flashForm);
        });

        // Method toggle
        methodRadios.forEach(function(radio) {
          radio.addEventListener('change', function() {
            var method = document.querySelector('input[name="method"]:checked').value;
            usbOptions.classList.toggle('hidden', method !== 'usb');
            updateFlashBtn();
          });
        });

        // File picker
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
            updateFlashBtn();
          };
          reader.readAsArrayBuffer(file);
        });

        function showStatus(el, msg, type) {
          el.textContent = msg;
          el.className = 'status-msg ' + type;
          el.classList.remove('hidden');
        }

        function hideStatus(el) {
          el.classList.add('hidden');
        }

        // --- Connect ---
        connectBtn.addEventListener('click', async function() {
          var ip = pendantIpInput.value.trim();
          if (!ip) {
            showStatus(connectStatus, 'Please enter an IP address', 'error');
            return;
          }

          connectBtn.disabled = true;
          connectBtn.innerHTML = '<span class="spinner"></span>Connecting...';
          hideStatus(connectStatus);

          try {
            var response = await fetch('http://' + ip + '/api/info', {
              signal: AbortSignal.timeout(5000)
            });

            if (!response.ok) {
              throw new Error('HTTP ' + response.status);
            }

            deviceInfo = await response.json();
            deviceInfo._ip = ip;

            // Update UI
            document.getElementById('deviceIdDisplay').textContent = deviceInfo.deviceIdFormatted || deviceInfo.deviceId || '-';
            document.getElementById('deviceModelDisplay').textContent = deviceInfo.deviceModel || '-';
            document.getElementById('firmwareDisplay').textContent = 'v' + (deviceInfo.firmwareVersion || '-');

            var licenseEl = document.getElementById('licenseDisplay');
            if (deviceInfo.licensed) {
              licenseEl.textContent = 'Active';
              licenseEl.className = 'device-info-value licensed';
              activationSection.classList.add('hidden');
            } else {
              licenseEl.textContent = 'Not Activated';
              licenseEl.className = 'device-info-value not-licensed';
              activationSection.classList.remove('hidden');
            }

            deviceSection.classList.remove('hidden');
            showStatus(connectStatus, 'Connected to pendant at ' + ip, 'success');
            updateFlashBtn();

          } catch (err) {
            showStatus(connectStatus, 'Failed to connect: ' + (err.message || 'Connection refused'), 'error');
            deviceSection.classList.add('hidden');
          } finally {
            connectBtn.disabled = false;
            connectBtn.textContent = 'Connect';
          }
        });

        // --- Installation ID formatting ---
        function formatInstallationId(raw) {
          var clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 36);
          var parts = clean.match(/.{1,6}/g);
          return parts ? parts.join('-') : '';
        }

        function isInstallationIdValid() {
          var raw = installationIdInput.value.replace(/[^A-Za-z0-9]/g, '');
          return raw.length === 36;
        }

        installationIdInput.addEventListener('input', function() {
          var pos = this.selectionStart;
          var oldLen = this.value.length;
          this.value = formatInstallationId(this.value);
          var newLen = this.value.length;
          var newPos = pos + (newLen - oldLen);
          this.setSelectionRange(newPos, newPos);
          activateBtn.disabled = !isInstallationIdValid();
        });

        activateBtn.disabled = !isInstallationIdValid();

        // --- Activate ---
        activateBtn.addEventListener('click', function() {
          if (!deviceInfo) return;

          var instId = installationIdInput.value.trim().toUpperCase();
          window.postMessage({
            type: 'close-plugin-dialog',
            data: {
              action: 'activate',
              pendantIp: deviceInfo._ip,
              deviceId: deviceInfo.deviceId,
              installationId: instId
            }
          }, '*');
        });

        // --- Flash ---
        function updateFlashBtn() {
          var hasFile = fileBase64 !== null;
          var method = document.querySelector('input[name="method"]:checked').value;
          var valid = hasFile && deviceInfo;
          if (method === 'usb') {
            valid = hasFile && portSelect.value !== '';
          }
          flashBtn.disabled = !valid;
        }

        portSelect.addEventListener('change', updateFlashBtn);

        flashBtn.addEventListener('click', async function() {
          if (!fileBase64) return;

          var method = document.querySelector('input[name="method"]:checked').value;

          // USB flashing needs server-side esptool
          if (method === 'usb') {
            window.postMessage({
              type: 'close-plugin-dialog',
              data: {
                action: 'flash',
                firmwareBase64: fileBase64,
                firmwareFileName: selectedFileName || 'firmware.bin',
                method: 'usb',
                port: portSelect.value,
                baudRate: '115200'
              }
            }, '*');
            return;
          }

          // OTA flashing - do client-side
          var pendantIp = deviceInfo ? deviceInfo._ip : pendantIpInput.value.trim();
          if (!pendantIp) {
            alert('No pendant IP address');
            return;
          }

          showOverlayProgress('Flashing Firmware', 'Preparing upload...', 0);

          try {
            // Decode base64 to binary
            var binaryStr = atob(fileBase64);
            var bytes = new Uint8Array(binaryStr.length);
            for (var i = 0; i < binaryStr.length; i++) {
              bytes[i] = binaryStr.charCodeAt(i);
            }

            var fileName = selectedFileName || 'firmware.bin';
            var boundary = '------------------------' + Date.now().toString(16);

            // Build multipart body
            var header = '--' + boundary + '\\r\\n' +
              'Content-Disposition: form-data; name="firmware"; filename="' + fileName + '"\\r\\n' +
              'Content-Type: application/octet-stream\\r\\n\\r\\n';
            var footer = '\\r\\n--' + boundary + '--\\r\\n';

            var headerBytes = new TextEncoder().encode(header);
            var footerBytes = new TextEncoder().encode(footer);

            var body = new Uint8Array(headerBytes.length + bytes.length + footerBytes.length);
            body.set(headerBytes, 0);
            body.set(bytes, headerBytes.length);
            body.set(footerBytes, headerBytes.length + bytes.length);

            showOverlayProgress('Flashing Firmware', 'Uploading to pendant...', 10);

            var response = await fetch('http://' + pendantIp + '/update', {
              method: 'POST',
              headers: {
                'Content-Type': 'multipart/form-data; boundary=' + boundary
              },
              body: body
            });

            showOverlayProgress('Flashing Firmware', 'Upload complete, waiting for reboot...', 90);

            if (response.ok) {
              showOverlayResult('Flash Complete', 'Firmware flashed successfully. Device is rebooting.', true, function() {
                // Device will reboot, wait a bit then try to reconnect
                setTimeout(function() {
                  connectBtn.click();
                }, 3000);
                collapseAll();
              });
            } else {
              var errText = await response.text();
              throw new Error('HTTP ' + response.status + ': ' + (errText || 'Upload failed'));
            }

          } catch (err) {
            // Connection reset after upload often means success (device rebooted)
            if (err.name === 'TypeError' && err.message.includes('Failed to fetch')) {
              showOverlayResult('Flash Complete', 'Firmware uploaded. Device is rebooting.', true, function() {
                setTimeout(function() { connectBtn.click(); }, 3000);
                collapseAll();
              });
            } else {
              showOverlayResult('Flash Failed', err.message || 'An unknown error occurred', false);
            }
          }
        });

        // Auto-connect if IP is saved
        if (pendantIpInput.value.trim()) {
          setTimeout(function() { connectBtn.click(); }, 100);
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
  const isSuccess = type === 'success';
  const iconColor = isSuccess ? '#28a745' : '#dc3545';
  const icon = isSuccess
    ? `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="${iconColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>`
    : `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="${iconColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;

  return /* html */ `
    <div style="background: var(--color-surface); border: 1px solid var(--color-border); border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.4); min-width: 320px; max-width: 400px; overflow: hidden;">
      <div style="padding: 24px 24px 20px; text-align: center;">
        <div style="margin-bottom: 16px;">${icon}</div>
        <h3 style="color: var(--color-text-primary); margin: 0 0 8px; font-size: 1.1rem; font-weight: 600;">${title}</h3>
        <p style="color: var(--color-text-secondary); margin: 0; font-size: 0.9rem; line-height: 1.5;">${message}</p>
      </div>
      <div style="padding: 12px 24px 20px; text-align: center;">
        <button onclick="window.postMessage({ type: 'close-modal' }, '*')" style="padding: 10px 40px; border-radius: var(--radius-small); background: var(--color-accent); border: none; color: white; font-size: 0.9rem; font-weight: 500; cursor: pointer;">OK</button>
      </div>
    </div>
  `;
}

// --- Plugin Lifecycle ---

export async function onLoad(ctx) {
  ctx.log('Wireless Pendant Flasher plugin loaded');

  ctx.registerToolMenu('Wireless Pendant', async () => {
    const ports = await getSerialPorts();
    const savedSettings = ctx.getSettings() || {};

    const dialogHtml = buildDialogHtml(ports, savedSettings);
    const response = await ctx.showDialog('Wireless Pendant', dialogHtml, { closable: true, width: '520px' });

    if (!response || !response.action) return;

    // --- Handle: Activate License ---
    if (response.action === 'activate') {
      const { pendantIp, deviceId, installationId } = response;

      const savedSettings = ctx.getSettings() || {};
      ctx.setSettings({ ...savedSettings, lastInstallationId: installationId, lastPendantIp: pendantIp });
      ctx.log('Activating pendant license:', installationId, 'deviceId:', deviceId, 'pendantIp:', pendantIp);

      // Show spinner modal
      ctx.showModal(/* html */ `
        <div style="background: var(--color-surface); border: 1px solid var(--color-border); border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.4); min-width: 300px; max-width: 380px; overflow: hidden;">
          <div style="padding: 28px 24px; text-align: center;">
            <div style="width: 40px; height: 40px; border: 3px solid var(--color-border); border-top-color: var(--color-accent); border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px;"></div>
            <h3 style="color: var(--color-text-primary); margin: 0 0 8px; font-size: 1.1rem; font-weight: 600;">Activating License</h3>
            <p style="color: var(--color-text-secondary); margin: 0; font-size: 0.9rem;">Contacting activation server...</p>
          </div>
        </div>
        <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
      `, { closable: false });

      try {
        const licenseData = await activateWithServer(installationId, deviceId, 'ncSenderPendant');
        ctx.log('Activation server returned license data');

        ctx.log('Sending license to pendant at:', pendantIp);
        await activatePendant(pendantIp, licenseData);
        ctx.log('Pendant activated successfully');

        await ctx.showModal(buildResultContent('License Activated', 'License has been activated on the pendant.', 'success'), { closable: true });
      } catch (err) {
        ctx.log('License activation failed:', err?.message || err);
        await ctx.showModal(buildResultContent('Activation Failed', err?.message || 'An unknown error occurred during activation.', 'error'), { closable: true });
      }
      return;
    }

    // --- Handle: Flash Firmware (USB only - OTA is handled client-side) ---
    if (response.action === 'flash') {
      const { firmwareBase64, firmwareFileName, method, port, baudRate, pendantIp } = response;

      ctx.setSettings({
        ...savedSettings,
        lastPendantIp: pendantIp || savedSettings.lastPendantIp
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
