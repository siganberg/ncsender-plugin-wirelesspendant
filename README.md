# Wireless Pendant Flasher

> **IMPORTANT DISCLAIMER:** This plugin is part of my personal ncSender project.
> If you choose to use it, you do so entirely at your own risk.
> I am not responsible for any damage, malfunction, or personal injury that may
> result from the use or misuse of this plugin. Use it with caution and at your
> own discretion.

Flash ncSender wireless pendant firmware via USB or OTA (Wi-Fi).

## Installation
Install this plugin in ncSender through the Plugins interface.

## Features

### Firmware Update Notifications
- Automatically checks for new firmware releases from GitHub
- Compact notification bar shows update status at a glance
- Dedicated update details dialog with version comparison and release notes
- One-click "Download & Flash OTA" directly from the update details dialog

### Firmware Flashing
- Flash ESP32 pendant firmware via USB serial or OTA (Wi-Fi)
- File picker for selecting `.bin` firmware files
- Real-time flash progress with detailed logging
- Automatic pendant detection on the network

### USB Flashing
- Built-in esptool support for direct USB serial flashing
- Serial port auto-detection and selection
- Web Serial API support for browser-based flashing (Chromium only)
- Configurable baud rate

### OTA (Wi-Fi) Flashing
- Flash firmware over Wi-Fi to a connected pendant
- Automatic pendant IP detection via ncSender server
- HTTP-based firmware upload with progress tracking
- Pendant reboots automatically after successful flash

### License Activation
- Activate pendant license directly from the plugin
- Device ID and Installation ID display for license management
- Installation ID input with formatting
- License status reporting

### Pendant Auto-Detection
- Automatically discovers connected pendants on the network
- Displays pendant IP, firmware version, and license status
- Seamless switching between USB and OTA targets

## Usage

1. Open **Wireless Pendant Flasher** from the Tools menu
2. Select a `.bin` firmware file using the file picker
3. Choose a flashing method:
   - **USB**: Select the serial port connected to the pendant
   - **OTA (Wi-Fi)**: Ensure the pendant is connected to the same network
4. Click **Flash** and wait for the process to complete
5. The pendant will reboot automatically with the new firmware

### License Tab

1. Connect the pendant to ncSender (via Wi-Fi)
2. The pendant's Machine ID will appear automatically
3. Enter the Installation ID provided with your license
4. Click **Activate** to license the pendant

## Requirements

- ncSender v0.3.151 or later
- ESP32-based wireless pendant hardware
- USB cable (for USB flashing) or Wi-Fi network (for OTA flashing)

## Development

This plugin is part of the ncSender ecosystem: https://github.com/siganberg/ncSender

## License

This plugin is available under a **dual license** (GPL-3.0 + Commercial).

See the [LICENSE](LICENSE) file for details, or contact support@franciscreation.com for commercial licensing.

Copyright (C) 2024 Francis Marasigan
