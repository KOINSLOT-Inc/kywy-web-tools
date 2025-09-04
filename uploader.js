const uploadBtn = document.getElementById('upload-btn');
const statusDiv = document.getElementById('status');
const libraryGrid = document.getElementById('library-grid');
const localInput = document.getElementById('local-uf2');
let selectedUF2 = null; // remote URL
let selectedUF2Buffer = null; // ArrayBuffer for local file
let selectedUF2Name = null; // filename for writing to UF2 drive

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
                        all.push({ name: a.name, url: a.browser_download_url });
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
            selectedUF2 = file.url;
            selectedUF2Buffer = null;
            selectedUF2Name = file.name; // remember filename for writing to UF2 drive
            uploadBtn.disabled = false;
        });
        libraryGrid.appendChild(card);
    }
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
    if (!selectedUF2 && !selectedUF2Buffer) {
        statusDiv.textContent = 'Please select a UF2 file.';
        return;
    }

    statusDiv.textContent = 'Preparing UF2...';
    let uf2ArrayBuffer = selectedUF2Buffer;
    if (!uf2ArrayBuffer) {
        try {
            const res = await fetch(selectedUF2);
            uf2ArrayBuffer = await res.arrayBuffer();
        } catch (e) {
            statusDiv.textContent = 'Error downloading UF2 file.';
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



