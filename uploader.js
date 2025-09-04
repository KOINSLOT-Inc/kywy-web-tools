const uploadBtn = document.getElementById('upload-btn');
const statusDiv = document.getElementById('status');
const libraryGrid = document.getElementById('library-grid');
const localInput = document.getElementById('local-uf2');
let selectedUF2 = null; // remote URL
let selectedUF2Buffer = null; // ArrayBuffer for local file
let selectedUF2Name = null; // filename for writing to UF2 drive
let selectedUF2Api = null; // GitHub API asset URL
let selectedUF2Browser = null; // browser_download_url fallback

const repos = [
    'KOINSLOT-Inc/kywy',
    'KOINSLOT-Inc/kywy-rust'
];
const splashRepo = 'KOINSLOT-Inc/kywy-loader';
const splashPath = 'splash';

function normalizeKey(name) {
    return name.replace(/\.ino$/i, '').replace(/\.uf2$/i, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function fetchSplashList() {
    try {
        const url = `https://api.github.com/repos/${splashRepo}/contents/${splashPath}`;
        const res = await fetch(url);
        if (!res.ok) return [];
        const items = await res.json();
        return items.filter(i => i.type === 'file').map(i => i.name);
    } catch (e) {
        return [];
    }
}

async function fetchUF2Assets() {
    const all = [];
    for (const repo of repos) {
        try {
            const url = `https://api.github.com/repos/${repo}/releases`;
            const res = await fetch(url);
            if (!res.ok) continue;
            const rels = await res.json();
            for (const r of rels) {
                for (const a of r.assets || []) {
                    if (a.name && a.name.toLowerCase().endsWith('.uf2')) {
                        // keep both the browser_download_url and the API asset url/id
                        all.push({ name: a.name, url: a.browser_download_url, id: a.id, apiUrl: a.url, repo });
                    }
                }
            }
        } catch (e) {
            // ignore per-repo errors
        }
    }
    return all;
}

function makeCard(displayName, imgSrc, highlight = false) {
    const card = document.createElement('div');
    card.className = 'uf2-card';
    card.style.border = highlight ? '2px solid #007bff' : '2px solid #ccc';
    card.style.borderRadius = '8px';
    card.style.padding = '8px';
    card.style.width = '160px';
    card.style.height = '220px';
    card.style.display = 'flex';
    card.style.flexDirection = 'column';
    card.style.alignItems = 'center';
    card.style.justifyContent = 'center';
    card.style.textAlign = 'center';
    card.style.cursor = 'pointer';
    card.style.background = '#f9f9f9';
    card.style.boxShadow = '0 2px 8px rgba(0,0,0,0.08)';

    const img = document.createElement('img');
    img.src = imgSrc || `https://raw.githubusercontent.com/${splashRepo}/main/${splashPath}/default.bmp`;
    img.alt = displayName;
    img.width = 144;
    img.height = 168;
    img.style.objectFit = 'contain';
    img.style.display = 'block';
    img.style.margin = '0 auto';

    const label = document.createElement('div');
    label.textContent = displayName;
    label.style.marginTop = '8px';
    label.style.fontWeight = 'bold';

    card.appendChild(img);
    card.appendChild(label);
    return card;
}

async function loadLibrary() {
    statusDiv.textContent = '';
    libraryGrid.innerHTML = '';
    selectedUF2 = null;
    selectedUF2Buffer = null;
    uploadBtn.disabled = true;

    const splashFiles = await fetchSplashList();
    const splashMap = new Map();
    for (const f of splashFiles) {
        const key = f.replace(/\.(png|bmp)$/i, '').toLowerCase().replace(/[^a-z0-9]/g, '');
        splashMap.set(key, f);
    }

    const assets = await fetchUF2Assets();
    // dedupe by normalized key
    const seen = new Set();
    const unique = [];
    for (const a of assets) {
        const key = normalizeKey(a.name);
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(a);
        }
    }

    if (unique.length === 0) {
        statusDiv.textContent = 'No UF2 files found.';
        return;
    }

    for (const file of unique) {
        const displayName = file.name.replace(/\.uf2$/i, '');
        const key = normalizeKey(displayName);
        const splashFile = splashMap.get(key) || 'default.bmp';
        const imgSrc = `https://raw.githubusercontent.com/${splashRepo}/main/${splashPath}/${splashFile}`;
        const card = makeCard(displayName, imgSrc);
                        card.addEventListener('click', () => {
                        Array.from(libraryGrid.children).forEach(c => c.style.border = '2px solid #ccc');
                        card.style.border = '2px solid #007bff';
                        selectedUF2 = null;
                        selectedUF2Buffer = null;
                        selectedUF2Api = file.apiUrl || null;
                        selectedUF2Browser = file.url || null;
                        selectedUF2Name = file.name; // remember filename for writing to UF2 drive
                        uploadBtn.disabled = false;
                    });
        libraryGrid.appendChild(card);
    }
}

// --- Device finder UI wiring ---
const findDevicesBtn = document.getElementById('find-devices-btn');
const devicesPanel = document.getElementById('devices-panel');
const selectedDeviceLabel = document.getElementById('selected-device');
let discoveredSerialPorts = [];
let chosenDevice = null; // { type: 'serial'|'mass', port/fileHandle, name }
let autoSearchInterval = null;
let autoSearchTimeout = null;

async function listSerialPorts() {
    if (!('serial' in navigator)) return [];
    // getPorts returns ports the site already has permission for
    const ports = await navigator.serial.getPorts();
    return ports;
}

function renderDevicesPanel(serialPorts, opts = {}) {
    devicesPanel.innerHTML = '';
    const title = document.createElement('div');
    title.textContent = 'Detected devices';
    title.style.fontWeight = 'bold';
    title.style.marginBottom = '8px';
    devicesPanel.appendChild(title);

    if (opts.autoSearching) {
        const autoNote = document.createElement('div');
        autoNote.textContent = 'Auto-searching for RP2040 devices... (will stop after a short time)';
        autoNote.style.fontSize = '13px';
        autoNote.style.color = '#444';
        autoNote.style.marginBottom = '8px';
        devicesPanel.appendChild(autoNote);
        const stopBtn = document.createElement('button');
        stopBtn.textContent = 'Stop search';
        stopBtn.addEventListener('click', stopAutoSearch);
        devicesPanel.appendChild(stopBtn);
        const spacer = document.createElement('div');
        spacer.style.height = '8px';
        devicesPanel.appendChild(spacer);
    }

    // Serial devices
    const serialSection = document.createElement('div');
    serialSection.textContent = 'Serial ports:';
    serialSection.style.marginBottom = '6px';
    devicesPanel.appendChild(serialSection);
    if (serialPorts.length === 0) {
        const none = document.createElement('div');
        none.textContent = 'No serial ports available (or permission not granted).';
        none.style.fontSize = '13px';
        none.style.color = '#666';
        devicesPanel.appendChild(none);
    }
    serialPorts.forEach((p, idx) => {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.gap = '8px';
        row.style.alignItems = 'center';
        row.style.marginBottom = '6px';
        const name = document.createElement('div');
        name.textContent = p.getInfo ? `Port ${idx + 1}` : `Serial port ${idx + 1}`;
        name.style.flex = '1';
        const selectBtn = document.createElement('button');
        selectBtn.textContent = 'Select';
        selectBtn.addEventListener('click', () => {
            chosenDevice = { type: 'serial', port: p, name: `Serial ${idx + 1}` };
            selectedDeviceLabel.textContent = `Selected: ${chosenDevice.name}`;
            devicesPanel.style.display = 'none';
        });
        const resetBtn = document.createElement('button');
        resetBtn.textContent = 'Reset to bootloader';
        resetBtn.addEventListener('click', async () => {
            try {
                // open at 1200 baud then close
                await p.open({ baudRate: 1200 });
                await p.close();
                selectedDeviceLabel.textContent = 'Bootloader triggered. Please select the UF2 drive when mounted.';
            } catch (err) {
                selectedDeviceLabel.textContent = 'Failed to reset via serial: ' + err.message;
            }
        });
        row.appendChild(name);
        row.appendChild(selectBtn);
        row.appendChild(resetBtn);
        devicesPanel.appendChild(row);
    });

    // Mass-storage section (user will pick a directory when they want to write)
    const massSection = document.createElement('div');
    massSection.style.marginTop = '12px';
    massSection.textContent = 'Mass storage / UF2 drive:';
    devicesPanel.appendChild(massSection);
    const pickDriveBtn = document.createElement('button');
    pickDriveBtn.textContent = 'Pick UF2 drive now';
    pickDriveBtn.addEventListener('click', async () => {
        try {
            const dir = await window.showDirectoryPicker();
            chosenDevice = { type: 'mass', dirHandle: dir, name: 'UF2 Drive (picked)' };
            selectedDeviceLabel.textContent = `Selected: ${chosenDevice.name}`;
            devicesPanel.style.display = 'none';
        } catch (err) {
            selectedDeviceLabel.textContent = 'Drive pick cancelled or not available.';
        }
    });
    devicesPanel.appendChild(pickDriveBtn);

    // Provide an instruction to clear paired permissions (cannot be done programmatically)
    const clearRow = document.createElement('div');
    clearRow.style.marginTop = '10px';
    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'Clear paired permissions';
    clearBtn.addEventListener('click', () => {
        statusDiv.innerHTML = 'To remove paired/remembered serial devices, open your browser settings → Privacy & security → Site settings → Serial devices (or similar), and remove permissions for this site. There is no programmatic API to revoke serial permissions.';
    });
    clearRow.appendChild(clearBtn);
    devicesPanel.appendChild(clearRow);

    devicesPanel.style.display = 'block';
}

findDevicesBtn.addEventListener('click', async () => {
    // Start auto-search for RP2040-like devices
    startAutoSearch();
});

function startAutoSearch() {
    if (!('serial' in navigator) && !('showDirectoryPicker' in window)) {
        statusDiv.textContent = 'Browser does not support Serial or File System APIs required for auto-search.';
        return;
    }
    // clear any previous search
    stopAutoSearch();
    devicesPanel.style.display = 'block';
    renderDevicesPanel([], { autoSearching: true });
    // We'll poll getPorts every 2s for up to 20s
    let attempts = 0;
    autoSearchInterval = setInterval(async () => {
        attempts++;
        let ports = [];
        try {
            ports = await listSerialPorts();
        } catch (_) { ports = []; }
        // filter ports for RP2040 vendor if available
        // Some browsers expose vendor/product via getInfo()
        const rpPorts = ports.filter(p => {
            try {
                const info = p.getInfo ? p.getInfo() : {};
                return info.usbVendorId === 0x2e8a || info.vendorId === 0x2e8a;
            } catch (_) {
                return false;
            }
        });
        if (rpPorts.length > 0) {
            renderDevicesPanel(rpPorts);
            stopAutoSearch();
            return;
        }
        // if none found, show available ports
        renderDevicesPanel(ports, { autoSearching: true });
        if (attempts > 10) {
            stopAutoSearch();
        }
    }, 2000);
    // safety stop after 22s
    autoSearchTimeout = setTimeout(() => stopAutoSearch(), 22000);
}

function stopAutoSearch() {
    if (autoSearchInterval) { clearInterval(autoSearchInterval); autoSearchInterval = null; }
    if (autoSearchTimeout) { clearTimeout(autoSearchTimeout); autoSearchTimeout = null; }
}

// If user picks a device elsewhere (e.g. clicking a card) we can use chosenDevice
// when writing the UF2 drive: modify writeToPickedDirectory to accept a dirHandle if provided
const originalWriteToPickedDirectory = writeToPickedDirectory;
async function writeToPickedDirectory(buf, filename) {
    if (chosenDevice && chosenDevice.type === 'mass' && chosenDevice.dirHandle) {
        const dirHandle = chosenDevice.dirHandle;
        const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(buf);
        await writable.close();
        return;
    }
    return originalWriteToPickedDirectory(buf, filename);
}

// Attempt direct WebUSB upload. Returns true on success, false if the device
// doesn't accept this transfer pattern. Throws on unexpected errors.
async function attemptWebUSBUpload(arrayBuffer) {
    if (!('usb' in navigator)) throw new Error('WebUSB not available');
    // Ask user to pick a device; broad filter to let user select the RP2040
    // or related boards. We don't know the specific interface, so user will
    // need to pick the correct device.
    const filters = [{ vendorId: 0x2e8a }];
    const device = await navigator.usb.requestDevice({ filters });
    await device.open();
    try {
        if (device.configuration === null) await device.selectConfiguration(1);
        // Try to claim interface 0
        await device.claimInterface(0);
    } catch (err) {
        // If we couldn't claim, close and return false (not supported)
        try { await device.close(); } catch (_) {}
        return false;
    }

    // Find an OUT endpoint to transfer data
    const cfg = device.configuration;
    const iface = cfg.interfaces.find(i => i.interfaceClass !== undefined) || cfg.interfaces[0];
    const endpoint = (iface && iface.alternate.endpoints.find(e => e.direction === 'out')) ? iface.alternate.endpoints.find(e => e.direction === 'out') : null;
    if (!endpoint) {
        await device.releaseInterface(0).catch(() => {});
        await device.close().catch(() => {});
        return false;
    }

    const chunkSize = 64;
    const total = Math.ceil(arrayBuffer.byteLength / chunkSize);
    for (let i = 0; i < total; i++) {
        const chunk = new Uint8Array(arrayBuffer, i * chunkSize, Math.min(chunkSize, arrayBuffer.byteLength - i * chunkSize));
        await device.transferOut(endpoint.endpointNumber, chunk);
        statusDiv.textContent = `Uploading (direct): ${i + 1}/${total}`;
    }

    await device.releaseInterface(0).catch(() => {});
    await device.close().catch(() => {});
    return true;
}

// local file input
localInput.addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (!f.name.toLowerCase().endsWith('.uf2')) {
        statusDiv.textContent = 'Please select a .uf2 file.';
        return;
    }
    selectedUF2 = null;
    selectedUF2Buffer = await f.arrayBuffer();
    selectedUF2Name = f.name;
    uploadBtn.disabled = false;
    // prepend card
    const card = makeCard(f.name.replace(/\.uf2$/i, ''), '');
    // simple placeholder
    card.querySelector('img').style.background = '#fff';
    Array.from(libraryGrid.children).forEach(c => c.style.border = '2px solid #ccc');
    card.style.border = '2px solid #007bff';
    libraryGrid.prepend(card);
});

// initial load
loadLibrary();

uploadBtn.addEventListener('click', async () => {
    // Require either a remote selection (API or browser URL) or a local UF2 buffer
    if (!selectedUF2Api && !selectedUF2Browser && !selectedUF2Buffer) {
        statusDiv.textContent = 'Please select a program from the library or choose a local .uf2 file.';
        return;
    }

    statusDiv.textContent = 'Preparing UF2...';
    let uf2ArrayBuffer = selectedUF2Buffer;
    if (!uf2ArrayBuffer) {
        // Try GitHub API asset download (this uses the asset API URL and requests the binary)
        if (selectedUF2Api) {
            try {
                const res = await fetch(selectedUF2Api, { headers: { Accept: 'application/octet-stream' } });
                if (!res.ok) throw new Error('API download failed: ' + res.status);
                uf2ArrayBuffer = await res.arrayBuffer();
            } catch (e) {
                // CORS or other failure — fall back to opening the browser download URL so user can save manually
                if (selectedUF2Browser) {
                    statusDiv.textContent = 'Automatic download blocked by CORS. Opening download link — please save the .uf2 and then use "Find devices" → pick drive to write it.';
                    window.open(selectedUF2Browser, '_blank');
                    return;
                }
                statusDiv.textContent = 'Error downloading UF2 file: ' + e.message;
                return;
            }
        } else if (selectedUF2Browser) {
            // If we only have a browser URL, open it for manual download
            statusDiv.textContent = 'Opening download link — please save the .uf2 and then use "Find devices" → pick drive to write it.';
            window.open(selectedUF2Browser, '_blank');
            return;
        } else {
            statusDiv.textContent = 'No remote UF2 selected.';
            return;
        }
    }

        // New flow: trigger RP2040 bootloader via 1200 baud 'knock' (Web Serial),
        // then write the UF2 file into the mounted mass-storage using the
        // File System Access API (user selects the drive directory).

        // Helper: attempt to open serial, set 1200 baud, then close to trigger bootloader.
        async function triggerBootloaderViaSerial() {
            if (!('serial' in navigator)) throw new Error('Web Serial API not available in this browser');
            // Prefer filtering by vendor id (user may still need to pick the port)
            const filters = [{ usbVendorId: 0x2e8a }];
            let port;
            try {
                port = await navigator.serial.requestPort({ filters });
            } catch (err) {
                // try without filters as a fallback
                port = await navigator.serial.requestPort();
            }
            await port.open({ baudRate: 1200 });
            // Some boards require a small pause; close quickly to trigger reset
            await port.close();
        }

        // Helper: write the UF2 ArrayBuffer into a user-picked directory (the mounted UF2 drive)
        async function writeToPickedDirectory(buf, filename) {
            if (!('showDirectoryPicker' in window)) {
                throw new Error('File System Access API is not available in this browser');
            }
            statusDiv.textContent = 'Please choose the mounted UF2 drive folder when prompted...';
            const dirHandle = await window.showDirectoryPicker();
            // create or overwrite the file
            const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(buf);
            await writable.close();
        }

        // Prepare filename
        const fileName = selectedUF2Name || 'update.uf2';

        // First, try direct WebUSB streaming upload (works only if the device
        // exposes a vendor/bulk interface that accepts UF2). This avoids needing
        // to mount a mass-storage drive. If it fails, fall back to the bootloader
        // knock + mass-storage write flow.
        statusDiv.textContent = 'Attempting direct USB upload (if supported by device)...';
        try {
            const directOk = await attemptWebUSBUpload(uf2ArrayBuffer);
            if (directOk) {
                statusDiv.textContent = 'Direct upload complete! Device should reboot.';
                return;
            }
            // otherwise continue to bootloader/mass-storage flow
        } catch (err) {
            // fall through to bootloader flow
            statusDiv.textContent = 'Direct USB upload not available: ' + err.message + ' — falling back to UF2 drive method.';
        }

        // Trigger bootloader (user will be prompted to choose serial port)
        statusDiv.textContent = 'Triggering bootloader (opening serial at 1200 baud)...';
        try {
            await triggerBootloaderViaSerial();
        } catch (err) {
            statusDiv.textContent = 'Serial knock failed: ' + err.message + '. You can put the board into bootloader mode manually and then pick the drive.';
        }

        // Give the OS a short moment to re-enumerate and mount the UF2 drive
        statusDiv.textContent = 'Waiting for the UF2 drive to appear (please allow a few seconds)...';
        await new Promise(r => setTimeout(r, 1500));

        // Ask user to pick the drive and write the UF2 file into it
        try {
            await writeToPickedDirectory(uf2ArrayBuffer, fileName);
            statusDiv.textContent = `Successfully wrote ${fileName} to the selected drive. The board should reboot into the new firmware.`;
        } catch (err) {
            // If File System Access isn't available or user cancels, provide fallback instructions
            statusDiv.textContent = `Failed to write to drive: ${err.message}. If your browser doesn't support automatic drive access, manually copy ${fileName} to the mounted UF2 drive.`;
        }
});



