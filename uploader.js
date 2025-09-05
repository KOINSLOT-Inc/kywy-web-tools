/**
 * KYWY UF2 Uploader Tool
 * 
 * This tool is designed to work both locally (with browser downloads) and 
 * when hosted on GitHub Pages at tools.kywy.io (with direct downloads).
 * 
 * Features:
 * - Direct download from GitHub releases when hosted
 * - Browser download fallback for local usage
 * - File System Access API for writing to UF2 drives
 * - Web Serial API for automatic bootloader triggering
 * - WebUSB support for compatible devices
 */

const uploadBtn = document.getElementById('upload-btn');
const statusDiv = document.getElementById('status');
const libraryGrid = document.getElementById('library-grid');
const localInput = document.getElementById('local-uf2');
const multiUploadCheckbox = document.getElementById('multi-upload-checkbox');
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

// Helper: determine if we're running locally and need to use browser downloads
function needsBrowserDownload() {
    // GitHub blocks CORS on release downloads for all origins, so we always need browser downloads for remote files
    // Only exception would be if we had our own proxy server or the files were hosted elsewhere
    return true; // Always use browser download for GitHub releases due to CORS
}

// Helper: trigger browser download for files that can't be fetched due to CORS
function triggerBrowserDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
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
    const spinner = document.getElementById('library-spinner');
    const grid = document.getElementById('library-grid');
    if (spinner) spinner.style.display = 'flex';
    if (grid) grid.style.display = 'none';
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
    if (spinner) spinner.style.display = 'none';
    if (grid) grid.style.display = 'flex';
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
    if (spinner) spinner.style.display = 'none';
    if (grid) grid.style.display = 'flex';
}

// --- Device finder UI wiring ---
const devicesPanel = document.getElementById('devices-panel');
const selectedDeviceLabel = document.getElementById('selected-device');
const deviceStatusElem = document.getElementById('device-status');
let discoveredSerialPorts = [];
let chosenDevice = null; // { type: 'serial'|'mass', port/fileHandle, name }
let autoSearchInterval = null;
let autoSearchTimeout = null;
let backgroundScanInterval = null;
let detectedDevices = []; // array of { id, type, port?, dirHandle?, name }
let deviceSelectElem = null;
let multiUploadMode = false;
let processedDeviceIds = new Set();

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
        autoNote.textContent = 'Auto-searching for KYWY devices... (will stop after a short time)';
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
        // Offer a button to request serial port permission so the user can allow access
        if ('serial' in navigator) {
            const reqBtn = document.createElement('button');
            reqBtn.textContent = 'Request serial access';
            reqBtn.addEventListener('click', async () => {
                try {
                    // prefer filtered prompt
                    await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x2e8a }] });
                } catch (err) {
                    try { await navigator.serial.requestPort(); } catch (_) { /* user cancelled */ }
                }
                // re-query and re-render
                try {
                    const ports = await listSerialPorts();
                    renderDevicesPanel(ports);
                } catch (_) {
                    renderDevicesPanel([]);
                }
            });
            devicesPanel.appendChild(reqBtn);
        }
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
    
    const instructions = document.createElement('div');
    instructions.style.fontSize = '13px';
    instructions.style.color = '#666';
    instructions.style.marginBottom = '8px';
    instructions.textContent = 'Put your KYWY board into bootloader mode (hold BOOTSEL while connecting USB) then click below:';
    devicesPanel.appendChild(instructions);
    
    const pickDriveBtn = document.createElement('button');
    pickDriveBtn.textContent = 'Select UF2 drive';
    pickDriveBtn.addEventListener('click', async () => {
        try {
            statusDiv.textContent = 'Please select the UF2 drive folder (usually named RPI-RP2)...';
            const dir = await window.showDirectoryPicker({
                mode: 'readwrite',
                startIn: 'desktop'
            });
            
            // Verify this is likely a UF2 drive
            try {
                const entries = [];
                for await (const entry of dir.values()) {
                    entries.push(entry.name.toLowerCase());
                }
                
                const hasUf2Files = entries.some(name => 
                    name.includes('info_uf2') || 
                    name.includes('index.htm') || 
                    name === 'current.uf2'
                );
                
                if (!hasUf2Files && entries.length > 10) {
                    const proceed = confirm(
                        'This folder doesn\'t appear to be a UF2 drive (expected files like INFO_UF2.TXT not found). ' +
                        'Make sure your KYWY board is in bootloader mode. Continue anyway?'
                    );
                    if (!proceed) {
                        statusDiv.textContent = 'Please put your KYWY into bootloader mode and try again.';
                        return;
                    }
                }
            } catch (err) {
                console.warn('Could not verify UF2 drive:', err);
            }
            
            chosenDevice = { type: 'mass', dirHandle: dir, name: 'UF2 Drive' };
            selectedDeviceLabel.textContent = `Selected: ${chosenDevice.name}`;
            statusDiv.textContent = 'UF2 drive selected successfully.';
            devicesPanel.style.display = 'none';
        } catch (err) {
            if (err.name === 'AbortError') {
                selectedDeviceLabel.textContent = 'Drive selection cancelled.';
                statusDiv.textContent = '';
            } else {
                selectedDeviceLabel.textContent = 'Failed to select drive: ' + err.message;
                statusDiv.textContent = 'Make sure File System Access is enabled in your browser.';
            }
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

// Find button removed; background scanning starts automatically.

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
        // filter ports for KYWY vendor if available
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

// --- Background scanning and auto-selection (runs without explicit search click)
async function scanForDevicesOnce() {
    const found = [];
    
    // Check if we're on HTTPS (required for many Web APIs)
    const isSecure = window.location.protocol === 'https:' || window.location.hostname === 'localhost';
    
    // serial ports the site has permission for
    if ('serial' in navigator) {
        try {
            // On HTTPS sites, getPorts() only returns ports the user has previously granted permission to
            const ports = await navigator.serial.getPorts();
            console.log(`Found ${ports.length} serial ports with permissions`);
            
            for (const p of ports) {
                try {
                    const info = p.getInfo ? p.getInfo() : {};
                    const isRp = (info.usbVendorId === 0x2e8a || info.vendorId === 0x2e8a || (info.usbProductId && info.usbProductId > 0));
                    const id = `serial:${info.usbVendorId || 'u'}:${info.usbProductId || 'p'}:${p}`;
                    found.push({ id, type: 'serial', port: p, info, name: `Serial ${info.usbProductId || ''}` });
                } catch (err) { 
                    console.warn('Error getting port info:', err);
                }
            }
        } catch (err) {
            console.warn('Error accessing serial ports:', err);
        }
    } else {
        console.log('Web Serial API not available');
    }
    
    // mass storage: include chosenDevice.dirHandle if user previously picked one
    if (chosenDevice && chosenDevice.type === 'mass' && chosenDevice.dirHandle) {
        found.push({ id: 'mass:chosen', type: 'mass', dirHandle: chosenDevice.dirHandle, name: chosenDevice.name });
    }

    detectedDevices = found;
    renderDetectedDevices();
    return detectedDevices;
}

function startBackgroundScan() {
    if (backgroundScanInterval) return;
    // do an immediate scan then poll every 2s
    scanForDevicesOnce();
    backgroundScanInterval = setInterval(scanForDevicesOnce, 2000);
}

function stopBackgroundScan() {
    if (!backgroundScanInterval) return;
    clearInterval(backgroundScanInterval);
    backgroundScanInterval = null;
}

function renderDetectedDevices() {
    // Show simple status in the selectedDevice label area and manage selection UI
    const container = document.createElement('div');
    if (!detectedDevices || detectedDevices.length === 0) {
        const isSecure = window.location.protocol === 'https:' || window.location.hostname === 'localhost';
        const hasSerial = 'serial' in navigator;
        
        if (hasSerial && isSecure) {
            // On HTTPS sites, we need user interaction to grant permissions
            container.innerHTML = `
                <div>No KYWY device found.</div>
                <div style="margin-top: 8px; display: flex; gap: 8px; align-items: center;">
                    <button id="connect-device-btn" style="padding: 6px 12px; background: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">
                        🔌 Connect KYWY Device
                    </button>
                    <button onclick="showDeviceInstructions()" style="padding: 4px 8px; font-size: 12px; background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 4px; cursor: pointer;">
                        How to connect?
                    </button>
                </div>
                <div style="font-size: 11px; color: #666; margin-top: 4px;">
                    Click "Connect KYWY Device" to grant permission for device detection
                </div>
            `;
            
            const connectBtn = container.querySelector('#connect-device-btn');
            if (connectBtn) {
                connectBtn.addEventListener('click', async () => {
                    try {
                        connectBtn.textContent = 'Connecting...';
                        connectBtn.disabled = true;
                        
                        // Request permission for a new serial port
                        const port = await navigator.serial.requestPort({ 
                            filters: [{ usbVendorId: 0x2e8a }] // RP2040 vendor ID
                        });
                        
                        // Refresh the device list
                        await scanForDevicesOnce();
                        
                    } catch (err) {
                        if (err.name === 'NotFoundError') {
                            connectBtn.textContent = 'No device selected';
                        } else {
                            connectBtn.textContent = 'Connection failed';
                            console.error('Device connection error:', err);
                        }
                        setTimeout(() => {
                            connectBtn.textContent = '🔌 Connect KYWY Device';
                            connectBtn.disabled = false;
                        }, 2000);
                    }
                });
            }
        } else {
            // Fallback for non-HTTPS or unsupported browsers
            container.innerHTML = `
                <div>No KYWY device found.</div>
                <button onclick="showDeviceInstructions()" style="margin-top: 8px; padding: 4px 8px; font-size: 12px;">
                    How to connect my KYWY?
                </button>
                ${!hasSerial ? '<div style="font-size: 11px; color: #666; margin-top: 4px;">Web Serial API not supported in this browser</div>' : ''}
                ${!isSecure ? '<div style="font-size: 11px; color: #666; margin-top: 4px;">HTTPS required for automatic device detection</div>' : ''}
            `;
        }
        
        if (deviceStatusElem) {
            deviceStatusElem.innerHTML = '';
            deviceStatusElem.appendChild(container);
        }
        selectedDeviceLabel.textContent = '';
        uploadBtn.disabled = false; // Allow upload even without detected device - user can manually select UF2 drive
        return;
    }

    if (detectedDevices.length === 1) {
        const d = detectedDevices[0];
        chosenDevice = d.type === 'serial' ? { type: 'serial', port: d.port, name: d.name } : { type: 'mass', dirHandle: d.dirHandle, name: d.name };
        if (deviceStatusElem) deviceStatusElem.textContent = `Found device: ${chosenDevice.name} (${chosenDevice.type})`;
        selectedDeviceLabel.textContent = `Selected: ${chosenDevice.name}`;
        uploadBtn.disabled = false;
        return;
    }

    // multiple devices: create a select box
    const sel = document.createElement('select');
    sel.style.minWidth = '220px';
    detectedDevices.forEach((d, idx) => {
        const opt = document.createElement('option');
        opt.value = d.id;
        opt.textContent = `${d.type === 'serial' ? 'Serial' : 'Mass'} — ${d.name || ('Device ' + (idx + 1))}`;
        sel.appendChild(opt);
    });
    sel.addEventListener('change', () => {
        const selId = sel.value;
        const d = detectedDevices.find(x => x.id === selId);
        if (d) {
            chosenDevice = d.type === 'serial' ? { type: 'serial', port: d.port, name: d.name } : { type: 'mass', dirHandle: d.dirHandle, name: d.name };
            selectedDeviceLabel.textContent = `Selected: ${chosenDevice.name}`;
            uploadBtn.disabled = false;
        }
    });
    if (deviceStatusElem) {
        deviceStatusElem.innerHTML = '';
        deviceStatusElem.appendChild(sel);
    }
    deviceSelectElem = sel;
    uploadBtn.disabled = false;
}

// Global function to show device connection instructions
window.showDeviceInstructions = function() {
    const instructions = `
KYWY Connection Instructions:

1. NORMAL MODE (for serial communication):
   - Simply connect your KYWY board via USB
   - Make sure it's running firmware that supports serial communication

2. BOOTLOADER MODE:
You may need to manually put your KYWY into bootloader mode to upload UF2 files for the first time or if a bad program was uploaded.
   - Turn off and unplug the Kywy
   - Using a push pin or similar, press and hold the button on the back of the board
   - While holding the button, connect the USB cable
   - Release the button
   - The board should appear as a USB drive (usually named "RPI-RP2")

Once connected in bootloader mode, the KYWY will appear as a removable drive that you can write UF2 files to.
    `;
    
    alert(instructions);
};

// Multi-upload loop: try to program newly detected devices continuously
async function startMultiUploadLoop() {
    processedDeviceIds.clear();
    statusDiv.textContent = 'Multi-upload mode ON. Waiting for devices...';
    multiUploadMode = true;
    while (multiUploadMode) {
        await scanForDevicesOnce();
        for (const d of detectedDevices) {
            if (processedDeviceIds.has(d.id)) continue;
            // mark as processing to avoid duplicates
            processedDeviceIds.add(d.id);
            statusDiv.textContent = `Found device ${d.name}, programming...`;
            try {
                await uploadToDevice(d);
                statusDiv.textContent = `Programmed ${d.name}`;
            } catch (err) {
                statusDiv.textContent = `Failed to program ${d.name}: ${err.message}`;
            }
        }
        // small wait before scanning again
        await new Promise(r => setTimeout(r, 1500));
    }
}

function stopMultiUploadLoop() {
    multiUploadMode = false;
    statusDiv.textContent = 'Multi-upload mode OFF.';
}

async function uploadToDevice(d) {
    // Use currently selected UF2 as sourceCandidate if available
    if (!selectedUF2Api && !selectedUF2Browser && !selectedUF2Buffer) throw new Error('No UF2 selected');
    // prepare sourceCandidate similarly to the upload button flow
    let uf2ArrayBuffer = selectedUF2Buffer;
    let sourceCandidate = null;
    if (uf2ArrayBuffer) sourceCandidate = uf2ArrayBuffer;
    else if (selectedUF2Api) {
        const res = await fetch(selectedUF2Api, { headers: { Accept: 'application/octet-stream' } });
        if (!res.ok) throw new Error('Download failed: ' + res.status);
        sourceCandidate = res.body && typeof res.body.getReader === 'function' ? res : await res.arrayBuffer();
    } else if (selectedUF2Browser) {
        sourceCandidate = selectedUF2Browser;
    }

    const fileName = selectedUF2Name || 'update.uf2';

    if (d.type === 'serial') {
        // attempt to open and trigger bootloader via the specific port if possible
        try {
            if (d.port && d.port.open) {
                await d.port.open({ baudRate: 1200 });
                await d.port.close();
            } else {
                // request port as fallback
                try { const p = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x2e8a }] }); await p.open({ baudRate: 1200 }); await p.close(); } catch (_) {}
            }
        } catch (_) {}
        // wait a bit for UF2 drive to mount
        await new Promise(r => setTimeout(r, 1500));
        // prompt user to pick the drive to write (best-effort)
        await writeToPickedDirectory(sourceCandidate, fileName);
        return;
    }
    if (d.type === 'mass') {
        // write directly to the provided dirHandle
        if (d.dirHandle) {
            await writeToPickedDirectoryWithHandle(d.dirHandle, sourceCandidate, fileName);
        } else {
            await writeToPickedDirectory(sourceCandidate, fileName);
        }
        return;
    }
}

// If user picks a device elsewhere (e.g. clicking a card) we can use chosenDevice
// when writing the UF2 drive: modify writeToPickedDirectory to accept a dirHandle if provided
// Helper function to write directly to a provided directory handle
async function writeToPickedDirectoryWithHandle(dirHandle, source, filename) {
    statusDiv.textContent = 'Writing to UF2 drive...';
    
    try {
        const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();

        try {
            // If source is a Response, stream its body
            if (source && typeof source === 'object' && 'body' in source && source.body && typeof source.body.getReader === 'function') {
                const reader = source.body.getReader();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    await writable.write(value);
                }
                await writable.close();
                return;
            }

            // If source is a URL string, fetch and stream
            if (typeof source === 'string') {
                const res = await fetch(source);
                if (!res.ok) throw new Error('Download failed: ' + res.status);
                if (!res.body || typeof res.body.getReader !== 'function') {
                    // fallback to arrayBuffer
                    const ab = await res.arrayBuffer();
                    await writable.write(new Uint8Array(ab));
                    await writable.close();
                    return;
                }
                const reader = res.body.getReader();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    await writable.write(value);
                }
                await writable.close();
                return;
            }

            // Otherwise assume an ArrayBuffer/Uint8Array
            if (source instanceof ArrayBuffer) {
                await writable.write(new Uint8Array(source));
                await writable.close();
                return;
            }
            if (source && source.buffer && source.byteLength !== undefined) {
                // TypedArray
                await writable.write(source);
                await writable.close();
                return;
            }

            throw new Error('Unsupported source type for writeToPickedDirectoryWithHandle');
        } catch (err) {
            try { await writable.abort(); } catch (_) {}
            throw err;
        }
    } catch (err) {
        throw new Error(`Failed to write to UF2 drive: ${err.message}`);
    }
}

// Top-level helper to write a UF2 file into a user-picked directory (the mounted UF2 drive)
async function writeToPickedDirectory(source, filename) {
    // source can be: ArrayBuffer/Uint8Array, a Response object (streamable), or a URL string
    // If File System Access isn't available, fall back to a Save-As dialog so the user can save the UF2
    // and then copy it to the mounted UF2 drive.
    if (!(chosenDevice && chosenDevice.type === 'mass' && chosenDevice.dirHandle) && !('showDirectoryPicker' in window)) {
        // fallback: prompt a Save As dialog
        await promptSaveAs(source, filename);
        return;
    }

    let dirHandle;
    if (chosenDevice && chosenDevice.type === 'mass' && chosenDevice.dirHandle) {
        dirHandle = chosenDevice.dirHandle;
    } else {
        try {
            statusDiv.textContent = 'Please select the UF2 drive folder...';
            dirHandle = await window.showDirectoryPicker({
                mode: 'readwrite',
                startIn: 'desktop'
            });
            
            // Verify this looks like a UF2 drive by checking for common files/structure
            try {
                const entries = [];
                for await (const entry of dirHandle.values()) {
                    entries.push(entry.name.toLowerCase());
                }
                
                // Check if this looks like a UF2 drive (should have INFO_UF2.TXT or similar)
                const hasUf2Indicator = entries.some(name => 
                    name.includes('info_uf2') || 
                    name.includes('index.htm') || 
                    name === 'current.uf2' ||
                    entries.length < 5 // UF2 drives typically have very few files
                );
                
                if (!hasUf2Indicator && entries.length > 10) {
                    const proceed = confirm('This folder doesn\'t appear to be a UF2 drive. Continue anyway?');
                    if (!proceed) {
                        statusDiv.textContent = 'Upload cancelled - please select the correct UF2 drive.';
                        return;
                    }
                }
            } catch (err) {
                // If we can't enumerate, just proceed
                console.warn('Could not verify UF2 drive structure:', err);
            }
            
        } catch (err) {
            if (err.name === 'AbortError') {
                statusDiv.textContent = 'Drive selection cancelled.';
                return;
            }
            throw new Error(`Failed to select drive: ${err.message}`);
        }
    }

    return await writeToPickedDirectoryWithHandle(dirHandle, source, filename);
}

// Fallback save-as: gather the source into a Blob and trigger a browser Save dialog
async function promptSaveAs(source, filename) {
    statusDiv.textContent = 'Browser does not support direct drive access — opening Save dialog...';
    let ab = null;
    try {
        if (source instanceof ArrayBuffer) {
            ab = source;
        } else if (source && source.buffer && source.byteLength !== undefined) {
            // TypedArray
            ab = source.buffer;
        } else if (typeof source === 'string') {
            const res = await fetch(source);
            if (!res.ok) throw new Error('Download failed: ' + res.status);
            ab = await res.arrayBuffer();
        } else if (source && typeof source === 'object' && 'body' in source && source.body && typeof source.arrayBuffer === 'function') {
            // Response-like
            ab = await source.arrayBuffer();
        } else if (source && typeof source === 'object' && 'body' in source && source.body && typeof source.body.getReader === 'function') {
            // stream reader: collect into chunks
            const reader = source.body.getReader();
            const chunks = [];
            let total = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                total += value.length;
            }
            const merged = new Uint8Array(total);
            let offset = 0;
            for (const c of chunks) { merged.set(c, offset); offset += c.length; }
            ab = merged.buffer;
        } else {
            throw new Error('Unable to prepare file for Save As');
        }

        const blob = new Blob([new Uint8Array(ab)], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename || 'update.uf2';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        statusDiv.textContent = 'Save dialog opened — please save to the mounted UF2 drive or download folder and copy to the drive.';
    } catch (err) {
        statusDiv.textContent = 'Failed to prepare Save As: ' + err.message;
        throw err;
    }
}

// Keep a reference in case other code expects the original function name
const originalWriteToPickedDirectory = writeToPickedDirectory;

// Overlay handlers
function showPostSaveOverlay() {
    const overlay = document.getElementById('post-save-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
}

function hidePostSaveOverlay() {
    const overlay = document.getElementById('post-save-overlay');
    if (!overlay) return;
    overlay.style.display = 'none';
}

document.addEventListener('DOMContentLoaded', () => {
    const dismiss = document.getElementById('dismiss-overlay');
    const copyBtn = document.getElementById('copy-file-btn');
    const fileInput = document.getElementById('picked-file');
    const overlayStatus = document.getElementById('overlay-status');
    if (dismiss) dismiss.addEventListener('click', hidePostSaveOverlay);
    if (copyBtn && fileInput) {
        copyBtn.addEventListener('click', async () => {
            overlayStatus.textContent = '';
            const f = fileInput.files && fileInput.files[0];
            if (!f) { overlayStatus.textContent = 'Please pick the UF2 file you saved.'; return; }
            try {
                // If File System Access available, ask user for the drive to copy into
                if ('showDirectoryPicker' in window) {
                    const dir = await window.showDirectoryPicker();
                    const fh = await dir.getFileHandle(f.name, { create: true });
                    const w = await fh.createWritable();
                    await w.write(await f.arrayBuffer());
                    await w.close();
                    overlayStatus.textContent = `Copied ${f.name} to selected drive.`;
                } else {
                    overlayStatus.textContent = 'Your browser does not support direct drive writes. Please manually copy the saved UF2 file to the mounted UF2 drive.';
                }
            } catch (err) {
                overlayStatus.textContent = 'Copy failed: ' + err.message;
            }
        });
    }
});

// Attempt direct WebUSB upload. Returns true on success, false if the device
// doesn't accept this transfer pattern. Throws on unexpected errors.
async function attemptWebUSBUpload(arrayBuffer) {
    if (!('usb' in navigator)) throw new Error('WebUSB not available');
    // Ask user to pick a device; broad filter to let user select the KYWY
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

// Check browser compatibility and show guidance
function checkBrowserCompatibility() {
    const hasFileSystemAccess = 'showDirectoryPicker' in window;
    const hasWebSerial = 'serial' in navigator;
    const hasWebUSB = 'usb' in navigator;
    
    if (!hasFileSystemAccess && !hasWebSerial) {
        statusDiv.innerHTML = `
            <strong>Browser Compatibility Warning:</strong><br>
            Your browser doesn't support the File System Access API or Web Serial API required for direct KYWY programming. 
            Please use Chrome, Edge, or another Chromium-based browser for the best experience.
            <br><br>
            <strong>Current browser support:</strong><br>
            • File System Access: ${hasFileSystemAccess ? '✅ Supported' : '❌ Not supported'}<br>
            • Web Serial: ${hasWebSerial ? '✅ Supported' : '❌ Not supported'}<br>
            • Web USB: ${hasWebUSB ? '✅ Supported' : '❌ Not supported'}
        `;
        return false;
    }
    
    if (!hasFileSystemAccess) {
        statusDiv.innerHTML = `
            <strong>Note:</strong> Your browser doesn't support the File System Access API. 
            You'll need to manually save and copy UF2 files to your KYWY drive.
        `;
    }
    
    return true;
}

// Run compatibility check
checkBrowserCompatibility();

// start background scanning automatically
startBackgroundScan();

// wire multi-upload toggle
if (multiUploadCheckbox) {
    multiUploadCheckbox.addEventListener('change', () => {
        if (multiUploadCheckbox.checked) startMultiUploadLoop();
        else stopMultiUploadLoop();
    });
}

uploadBtn.addEventListener('click', async () => {
    // Require either a remote selection (API or browser URL) or a local UF2 buffer
    if (!selectedUF2Api && !selectedUF2Browser && !selectedUF2Buffer) {
        statusDiv.textContent = 'Please select a program from the library or choose a local .uf2 file.';
        return;
    }

    // Check browser compatibility
    if (!('showDirectoryPicker' in window) && !('serial' in navigator)) {
        statusDiv.textContent = 'Your browser does not support the required File System Access or Web Serial APIs. Please use Chrome, Edge, or another Chromium-based browser.';
        return;
    }

    statusDiv.textContent = 'Preparing UF2...';
    // Prepare a sourceCandidate that can be: ArrayBuffer | Response | URL string
    let uf2ArrayBuffer = selectedUF2Buffer;
    let sourceCandidate = null;
    
    if (uf2ArrayBuffer) {
        sourceCandidate = uf2ArrayBuffer;
    } else {
        // GitHub blocks CORS on release downloads, so we always use browser downloads
        // This provides a consistent experience across all deployment methods
        const downloadUrl = selectedUF2Browser || selectedUF2Api;
        if (downloadUrl) {
            statusDiv.innerHTML = `
                <strong>Ready to download!</strong><br>
                Click the button below to download the UF2 file to your computer.<br>
                <br>
                <div style="margin: 12px 0;">
                    <button id="start-download-btn" style="padding: 10px 20px; background: #007bff; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 14px;">
                        📥 Download ${selectedUF2Name}
                    </button>
                </div>
                <div style="font-size: 13px; color: #666; line-height: 1.4;">
                    After the download completes, use the "Choose Local UF2 File" button above to select the downloaded file, then click "Upload to KYWY" again.
                </div>
            `;
            
            const downloadBtn = document.getElementById('start-download-btn');
            if (downloadBtn) {
                downloadBtn.addEventListener('click', () => {
                    triggerBrowserDownload(downloadUrl, selectedUF2Name);
                    statusDiv.innerHTML = `
                        <strong>✅ Download started!</strong><br>
                        The file "${selectedUF2Name}" should appear in your Downloads folder shortly.<br>
                        <br>
                        <strong>Next steps:</strong><br>
                        1. Wait for the download to complete<br>
                        2. Click "Choose Local UF2 File" above<br>
                        3. Select the downloaded file from your Downloads folder<br>
                        4. Click "Upload to KYWY" again
                    `;
                });
            }
            return;
        } else {
            statusDiv.textContent = 'No download URL available for this file.';
            return;
        }
    }

    // New flow: trigger KYWY bootloader via 1200 baud 'knock' (Web Serial),
    // then write the UF2 file into the mounted mass-storage using the
    // File System Access API (user selects the drive directory).

    // Helper: attempt to open serial, set 1200 baud, then close to trigger bootloader.
    async function triggerBootloaderViaSerial() {
        if (!('serial' in navigator)) throw new Error('Web Serial API not available in this browser');
        
        statusDiv.textContent = 'Please select your KYWY serial port...';
        // Prefer filtering by vendor id (user may still need to pick the port)
        const filters = [{ usbVendorId: 0x2e8a }];
        let port;
        try {
            port = await navigator.serial.requestPort({ filters });
        } catch (err) {
            if (err.name === 'NotFoundError') {
                throw new Error('No KYWY serial port found. Make sure your board is connected and not in bootloader mode.');
            }
                // try without filters as a fallback
                try {
                    port = await navigator.serial.requestPort();
                } catch (err2) {
                    if (err2.name === 'NotFoundError') {
                        throw new Error('No serial ports available. Make sure your RP2040 board is connected.');
                    }
                    throw err2;
                }
            }
            
            try {
                await port.open({ baudRate: 1200 });
                // Some boards require a small pause; close quickly to trigger reset
                await new Promise(resolve => setTimeout(resolve, 100));
                await port.close();
            } catch (err) {
                throw new Error(`Failed to trigger bootloader: ${err.message}`);
            }
        }

        // Prepare filename
        const fileName = selectedUF2Name || 'update.uf2';

        // First, try direct WebUSB streaming upload (works only if the device
        // exposes a vendor/bulk interface that accepts UF2). This avoids needing
        // to mount a mass-storage drive. If it fails, fall back to the bootloader
        // knock + mass-storage write flow.
        // If we have a full ArrayBuffer and WebUSB exists, try direct upload first
        if (uf2ArrayBuffer && ('usb' in navigator)) {
            statusDiv.textContent = 'Attempting direct USB upload (if supported by device)...';
            try {
                const directOk = await attemptWebUSBUpload(uf2ArrayBuffer);
                if (directOk) {
                    statusDiv.textContent = 'Direct upload complete! Device should reboot.';
                    return;
                }
            } catch (err) {
                if (err.name === 'NotFoundError') {
                    statusDiv.textContent = 'No compatible USB device found — trying serial bootloader method.';
                } else {
                    statusDiv.textContent = 'Direct USB upload not available: ' + err.message + ' — falling back to UF2 drive method.';
                }
            }
        }

        // If we have a pre-selected device, use it directly
        if (chosenDevice && chosenDevice.type === 'mass') {
            try {
                await uploadToDevice(chosenDevice);
                statusDiv.textContent = `Successfully wrote ${fileName} to the UF2 drive. The board should reboot into the new firmware.`;
                return;
            } catch (err) {
                statusDiv.textContent = `Failed to write to pre-selected drive: ${err.message}`;
                // Continue to manual selection below
            }
        }

        // Try to trigger bootloader via serial if available
        if ('serial' in navigator && (!chosenDevice || chosenDevice.type !== 'mass')) {
            try {
                await triggerBootloaderViaSerial();
                // Give the OS a short moment to re-enumerate and mount the UF2 drive
                statusDiv.textContent = 'Bootloader triggered. Waiting for UF2 drive to appear...';
                await new Promise(r => setTimeout(r, 2000));
            } catch (err) {
                statusDiv.textContent = err.message + ' — Please put your board into bootloader mode manually.';
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        // Manual drive selection
        try {
            await writeToPickedDirectory(sourceCandidate, fileName);
            statusDiv.textContent = `Successfully wrote ${fileName} to the UF2 drive. The board should reboot into the new firmware.`;
        } catch (err) {
            statusDiv.textContent = `Failed to write to drive: ${err.message}`;
            // Show the overlay for manual save/copy as fallback
            if (!('showDirectoryPicker' in window)) {
                showPostSaveOverlay();
            }
        }
});



