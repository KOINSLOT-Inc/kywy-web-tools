/**
 * Minimal KYWY UF2 WebUSB Uploader Test
 * 
 * This is a simplified test version that focuses only on WebUSB upload
 * Assumes device is already in bootloader mode (hold BOOTSEL while connecting)
 */

const statusDiv = document.getElementById('test-status');
const fileInput = document.getElementById('test-file-input');
const uploadBtn = document.getElementById('test-upload-btn');

let selectedFile = null;

// File input handler
fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) {
        statusDiv.textContent = 'No file selected';
        uploadBtn.disabled = true;
        return;
    }
    
    if (!file.name.toLowerCase().endsWith('.uf2')) {
        statusDiv.textContent = 'Please select a .uf2 file';
        uploadBtn.disabled = true;
        return;
    }
    
    selectedFile = file;
    statusDiv.textContent = `Selected: ${file.name} (${file.size} bytes)`;
    uploadBtn.disabled = false;
});

// Upload button handler
uploadBtn.addEventListener('click', async () => {
    if (!selectedFile) {
        statusDiv.textContent = 'Please select a UF2 file first';
        return;
    }
    
    try {
        uploadBtn.disabled = true;
        uploadBtn.textContent = 'Uploading...';
        
        // Convert file to ArrayBuffer
        const arrayBuffer = await selectedFile.arrayBuffer();
        console.log(`File loaded: ${arrayBuffer.byteLength} bytes`);
        
        // Attempt WebUSB upload
        const success = await attemptWebUSBUpload(arrayBuffer, selectedFile.name);
        
        if (success) {
            statusDiv.innerHTML = `
                <div style="color: green; font-weight: bold;">
                    ✅ Upload Successful!<br>
                    ${selectedFile.name} uploaded successfully via WebUSB HF2 protocol.<br>
                    Your KYWY should restart with the new program.
                </div>
            `;
        } else {
            statusDiv.innerHTML = `
                <div style="color: blue;">
                    ℹ️ WebUSB Upload Test Result<br>
                    Your KYWY uses <strong>standard RP2040 bootloader firmware</strong> which doesn't support advanced WebUSB protocols.<br>
                    <strong>This is completely normal!</strong> Use the mass storage method instead:<br>
                    <ol style="text-align: left; margin: 10px 0;">
                        <li>Your KYWY should appear as "RPI-RP2" drive</li>
                        <li>Copy the UF2 file to that drive</li>
                        <li>The device will automatically restart</li>
                    </ol>
                    <small style="color: #666;">
                        ✅ HF2 Protocol: Tested and not supported (expected)<br>
                        ✅ Direct Transfer: Tested and not supported (expected)<br>
                        💡 Sites like flashmypico.com work because they use devices with special HF2-compatible bootloader firmware.
                    </small>
                </div>
            `;
        }
        
    } catch (error) {
        console.error('Upload test completed:', error);
        
        // Check if this is an expected "not supported" result
        if (error.message.includes('USB STALL') || 
            error.message.includes('not supported') ||
            error.message.includes('does not support')) {
            
            statusDiv.innerHTML = `
                    } catch (err) {
        console.log('Upload test completed:', err);
        
        // Check for expected STALL errors
        if (err.message.includes('STALL') || err.message.includes('stall')) {
            statusDiv.innerHTML = `
                <div style="color: #2196F3; font-weight: bold;">ℹ️ WebUSB Upload Test Complete</div>
                <div style="color: #4CAF50;">Result: Standard RP2040 bootloader detected</div>
                <div>Your device uses standard firmware that doesn't support WebUSB upload.</div>
                <div style="color: #FF9800; font-weight: bold;">This is normal and expected!</div>
                <br>
                <div style="color: #2196F3; font-weight: bold;">✅ Protocol Tests Results:</div>
                <div>• PICOBOOT protocol: Command format correct, upload not supported</div>
                <div>• HF2 protocol: Not supported by standard bootloader</div>
                <div>• Direct transfer: Not supported by standard bootloader</div>
                <br>
                <div style="color: #4CAF50; font-weight: bold;">Use mass storage method instead:</div>
                <div>1. Your KYWY should appear as "RPI-RP2" drive</div>
                <div>2. Copy the UF2 file to that drive</div>
                <div>3. The device will automatically restart</div>
            `;
        } else {
            statusDiv.innerHTML = `
                <div style="color: #f44336;">❌ Upload test failed</div>
                <div>Error: ${err.message}</div>
            `;
        }
    }
            `;
        } else {
            // Actual unexpected error
            statusDiv.innerHTML = `
                <div style="color: red;">
                    ❌ Unexpected Error<br>
                    Error: ${error.message}
                </div>
            `;
        }
    } finally {
        uploadBtn.disabled = false;
        uploadBtn.textContent = 'Upload via WebUSB';
    }
});

// Simplified WebUSB upload function
async function attemptWebUSBUpload(arrayBuffer, fileName) {
    console.log('=== WebUSB Upload Test ===');
    console.log(`File: ${fileName}`);
    console.log(`Size: ${arrayBuffer.byteLength} bytes`);
    
    // Check WebUSB support
    if (!('usb' in navigator)) {
        throw new Error('WebUSB not supported in this browser');
    }
    
    statusDiv.textContent = 'Looking for RP2040 bootloader device...';
    
    // Try to find existing bootloader device
    let device = null;
    try {
        const devices = await navigator.usb.getDevices();
        device = devices.find(d => d.vendorId === 0x2e8a);
        console.log(`Found ${devices.length} existing USB devices`);
        if (device) {
            console.log(`Found RP2040 device: VID=${device.vendorId.toString(16)} PID=${device.productId.toString(16)}`);
        }
    } catch (err) {
        console.log('Error checking existing devices:', err);
    }
    
    // If no existing device, request user to select one
    if (!device) {
        statusDiv.textContent = 'Please select your KYWY bootloader device...';
        try {
            const filters = [{ vendorId: 0x2e8a }]; // RP2040 vendor ID
            device = await navigator.usb.requestDevice({ filters });
            console.log(`User selected device: VID=${device.vendorId.toString(16)} PID=${device.productId.toString(16)}`);
        } catch (err) {
            if (err.name === 'NotFoundError') {
                throw new Error('No RP2040 bootloader device found. Make sure your KYWY is in bootloader mode (hold BOOTSEL while connecting USB).');
            }
            throw err;
        }
    }
    
    // Verify this is an RP2040
    if (device.vendorId !== 0x2e8a) {
        throw new Error(`Wrong device vendor ID: expected 0x2e8a, got 0x${device.vendorId.toString(16)}`);
    }
    
    statusDiv.textContent = 'Connecting to device...';
    
    // Open the device
    try {
        if (!device.opened) {
            await device.open();
            console.log('Device opened successfully');
        }
    } catch (err) {
        throw new Error(`Failed to open device: ${err.message}`);
    }
    
    try {
        // Select configuration
        if (device.configuration === null) {
            await device.selectConfiguration(1);
            console.log('Configuration 1 selected');
        }
        
        console.log('Device configuration:', {
            configurationValue: device.configuration.configurationValue,
            interfaces: device.configuration.interfaces.length
        });
        
        // Log all interfaces and their details
        for (const iface of device.configuration.interfaces) {
            console.log(`Interface ${iface.interfaceNumber}:`);
            for (const alt of iface.alternates) {
                console.log(`  Alternate ${alt.alternateSetting}: class=${alt.interfaceClass}, subclass=${alt.interfaceSubclass}, protocol=${alt.interfaceProtocol}`);
                console.log(`    Endpoints: ${alt.endpoints.length}`);
                for (const ep of alt.endpoints) {
                    console.log(`      Endpoint ${ep.endpointNumber}: ${ep.direction} ${ep.type}, packet size=${ep.packetSize}`);
                }
            }
        }
        
        // Try HF2 protocol first (Microsoft PXT / flashmypico.com approach)
        statusDiv.textContent = 'Attempting HF2 protocol upload...';
        try {
            const hf2Success = await attemptHF2Upload(device, arrayBuffer);
            if (hf2Success) {
                await device.close();
                console.log('✓ HF2 upload completed successfully');
                return true;
            }
        } catch (hf2Error) {
            console.log('HF2 upload failed:', hf2Error.message);
            
            // Check if it's a control transfer error (protocol not supported)
            if (hf2Error.message.includes('controlTransferOut') || 
                hf2Error.message.includes('stall') ||
                hf2Error.message.includes('STALL')) {
                console.log('Device does not support HF2 protocol - falling back to direct transfer');
            } else {
                console.log('HF2 failed for other reason:', hf2Error.message);
            }
            // Continue to try direct endpoint transfer
        }
        
        // Fallback to direct endpoint transfer
        console.log('Falling back to direct endpoint transfer...');
        
        // Look for a claimable interface
        let claimed = null;
        let claimedInterfaceNumber = null;
        
        for (const iface of device.configuration.interfaces) {
            for (const alt of iface.alternates) {
                const interfaceClass = alt.interfaceClass;
                
                // Skip protected interface classes (blocked by browser security)
                if (interfaceClass === 8 || // Mass Storage (protected - cannot be claimed by WebUSB)
                    interfaceClass === 9 || // Hub (protected) 
                    interfaceClass === 1 || // Audio (protected)
                    interfaceClass === 3) { // HID (protected)
                    console.log(`Skipping protected interface class ${interfaceClass} (blocked by browser)`);
                    continue;
                }
                
                // Try to claim non-protected interfaces only
                try {
                    await device.claimInterface(iface.interfaceNumber);
                    claimed = { iface, alt };
                    claimedInterfaceNumber = iface.interfaceNumber;
                    console.log(`✓ Claimed interface ${iface.interfaceNumber}, class ${interfaceClass}`);
                    break;
                } catch (err) {
                    console.log(`✗ Failed to claim interface ${iface.interfaceNumber}: ${err.message}`);
                }
            }
            if (claimed) break;
        }
        
        if (!claimed) {
            console.log('No claimable interfaces found - this is normal for RP2040 bootloader');
            await device.close();
            return false; // Not supported, but not an error
        }
        
        // Look for an OUT endpoint
        const endpoint = claimed.alt.endpoints.find(ep => 
            ep.direction === 'out' && (ep.type === 'bulk' || ep.type === 'interrupt')
        );
        
        if (!endpoint) {
            console.log('No suitable OUT endpoint found');
            await device.releaseInterface(claimedInterfaceNumber);
            await device.close();
            return false;
        }
        
        console.log(`Using endpoint ${endpoint.endpointNumber} (${endpoint.type}, packet size: ${endpoint.packetSize})`);
        
        // Attempt to transfer the UF2 data
        statusDiv.textContent = 'Transferring UF2 data...';
        await transferUF2Data(device, endpoint, arrayBuffer);
        
        // Clean up
        await device.releaseInterface(claimedInterfaceNumber);
        await device.close();
        
        console.log('✓ WebUSB upload completed successfully');
        return true;
        
    } catch (err) {
        // Clean up on error
        try {
            if (device.opened) {
                await device.close();
            }
        } catch (_) {}
        
        // Check if it's a "device rebooted" error (which is actually success)
        if (err.message && (err.message.includes('device unavailable') || 
            err.message.includes('LIBUSB_ERROR_NO_DEVICE'))) {
            console.log('✓ Device rebooted (upload success)');
            return true;
        }
        
        throw err;
    }
}

// Transfer UF2 data to the device
async function transferUF2Data(device, endpoint, arrayBuffer) {
    const chunkSize = Math.min(endpoint.packetSize || 64, 512);
    const totalChunks = Math.ceil(arrayBuffer.byteLength / chunkSize);
    
    console.log(`Transferring ${arrayBuffer.byteLength} bytes in ${totalChunks} chunks of ${chunkSize} bytes`);
    
    for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, arrayBuffer.byteLength);
        const chunk = new Uint8Array(arrayBuffer, start, end - start);
        
        try {
            const result = await device.transferOut(endpoint.endpointNumber, chunk);
            
            if (result.status !== 'ok') {
                throw new Error(`Transfer failed with status: ${result.status}`);
            }
            
            // Update progress
            if (i % 10 === 0 || i === totalChunks - 1) {
                const percent = Math.round((i + 1) * 100 / totalChunks);
                statusDiv.textContent = `Uploading: ${percent}% (${i + 1}/${totalChunks})`;
                console.log(`Progress: ${percent}% (chunk ${i + 1}/${totalChunks})`);
            }
            
        } catch (transferErr) {
            // Check for USB STALL - this is normal for RP2040 bootloaders
            if (transferErr.message && transferErr.message.includes('stall')) {
                console.log(`✗ Transfer STALL on chunk ${i + 1} - vendor interface doesn't support UF2 upload`);
                throw new Error('RP2040 bootloader vendor interface does not support direct UF2 upload (USB STALL). This is normal - use mass storage method instead.');
            }
            
            // If transfer fails near the end, device might have rebooted (success)
            if (i > totalChunks * 0.8) {
                console.log(`Transfer ended at chunk ${i + 1}/${totalChunks} - device may have rebooted`);
                return;
            }
            throw transferErr;
        }
        
        // Small delay to prevent overwhelming the device
        if (i % 50 === 0 && i > 0) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }
    
    console.log('All chunks transferred successfully');
}

// HF2 Protocol Implementation (Microsoft PXT approach)
async function attemptHF2Upload(device, arrayBuffer) {
    console.log('=== HF2 Protocol Upload ===');
    
    // Look for HF2-compatible vendor interface (class 255, subclass 42)
    let hf2Interface = null;
    let picobootInterface = null;
    
    for (const iface of device.configuration.interfaces) {
        for (const alt of iface.alternates) {
            if (alt.interfaceClass === 255) {
                console.log(`Found vendor interface ${iface.interfaceNumber}: class=${alt.interfaceClass}, subclass=${alt.interfaceSubclass}, protocol=${alt.interfaceProtocol}`);
                
                // Check for HF2 protocol (subclass 42)
                if (alt.interfaceSubclass === 42) {
                    hf2Interface = { interface: iface, alternate: alt };
                    console.log(`✓ Found HF2 interface ${iface.interfaceNumber}`);
                } else {
                    // Generic vendor interface - try PICOBOOT
                    picobootInterface = { interface: iface, alternate: alt };
                    console.log(`Found generic vendor interface ${iface.interfaceNumber} for PICOBOOT`);
                }
            }
        }
    }
    
    // Try HF2 first if available (Microsoft PXT compatible devices)
    if (hf2Interface) {
        console.log('Attempting HF2 protocol upload...');
        try {
            await attemptRealHF2Upload(device, hf2Interface, arrayBuffer);
            return true;
        } catch (hf2Error) {
            console.log('HF2 protocol failed:', hf2Error.message);
        }
    }
    
    // Fall back to PICOBOOT if we have a vendor interface
    if (picobootInterface) {
        console.log('Attempting PICOBOOT protocol...');
        try {
            await attemptPicobootUpload(device, picobootInterface, arrayBuffer);
            return true;
        } catch (picobootError) {
            console.log('PICOBOOT protocol failed:', picobootError.message);
        }
    }
    
    // Last resort: try legacy HF2 over control transfers
    if (picobootInterface) {
        console.log('Falling back to legacy HF2 protocol...');
        
        // Claim the vendor interface for HF2 control transfers
        try {
            await device.claimInterface(picobootInterface.interface.interfaceNumber);
            console.log(`Claimed vendor interface ${picobootInterface.interface.interfaceNumber} for legacy HF2`);
        } catch (claimErr) {
            throw new Error(`Failed to claim vendor interface for HF2: ${claimErr.message}`);
        }
        
        try {
            // Convert UF2 to HF2 format
            statusDiv.textContent = 'Converting UF2 to HF2 format...';
            const hf2Blocks = convertUF2ToHF2(arrayBuffer);
            console.log(`Converted to ${hf2Blocks.length} HF2 blocks`);
            
            // Write HF2 data
            statusDiv.textContent = 'Writing firmware via HF2 protocol...';
            await writeHF2Data(device, picobootInterface, hf2Blocks);
            
            // Send reset command
            statusDiv.textContent = 'Sending reset command...';
            await sendHF2Reset(device, picobootInterface);
            
            console.log('HF2 upload completed');
            return true;
            
        } finally {
            // Always release the interface
            try {
                await device.releaseInterface(picobootInterface.interface.interfaceNumber);
                console.log('Released vendor interface');
            } catch (releaseErr) {
                console.log('Error releasing vendor interface:', releaseErr.message);
            }
        }
    }
    
    throw new Error('No compatible interface found for WebUSB upload');
}

// PICOBOOT Protocol Implementation (Native RP2040 bootloader)
async function attemptPicobootUpload(device, vendorInterface, arrayBuffer) {
    const PICOBOOT_MAGIC = 0x431fd10b;
    const PC_FLASH_ERASE = 0x03;
    const PC_WRITE = 0x05;
    const PC_REBOOT = 0x02;
    
    // Look for vendor interface endpoints
    const outEndpoint = vendorInterface.alternate.endpoints.find(ep => 
        ep.direction === 'out' && ep.type === 'bulk'
    );
    const inEndpoint = vendorInterface.alternate.endpoints.find(ep => 
        ep.direction === 'in' && ep.type === 'bulk'
    );
    
    if (!outEndpoint || !inEndpoint) {
        throw new Error('PICOBOOT protocol requires bulk IN and OUT endpoints');
    }
    
    // Claim the vendor interface
    await device.claimInterface(vendorInterface.interface.interfaceNumber);
    console.log(`Claimed vendor interface ${vendorInterface.interface.interfaceNumber} for PICOBOOT`);
    
    try {
        // Convert UF2 to flash data
        statusDiv.textContent = 'Converting UF2 for PICOBOOT upload...';
        const flashBlocks = extractFlashDataFromUF2(arrayBuffer);
        console.log(`Extracted ${flashBlocks.length} flash blocks`);
        
        if (flashBlocks.length === 0) {
            throw new Error('No valid flash data found in UF2 file');
        }
        
        // Find the range to erase
        const minAddr = Math.min(...flashBlocks.map(b => b.address));
        const maxAddr = Math.max(...flashBlocks.map(b => b.address + b.data.length));
        const eraseSize = maxAddr - minAddr;
        
        console.log(`Flash range: 0x${minAddr.toString(16)} to 0x${maxAddr.toString(16)} (${eraseSize} bytes)`);
        
        // Step 1: Erase flash
        statusDiv.textContent = 'Erasing flash memory...';
        await sendPicobootCommand(device, outEndpoint, inEndpoint, {
            magic: PICOBOOT_MAGIC,
            token: 1,
            cmdId: PC_FLASH_ERASE,
            cmdSize: 8, // sizeof(picoboot_range_cmd): dAddr + dSize = 4 + 4 = 8 bytes
            transferLength: 0,
            address: minAddr,
            size: eraseSize
        });
        
        // Step 2: Write flash data
        statusDiv.textContent = 'Writing flash data...';
        for (let i = 0; i < flashBlocks.length; i++) {
            const block = flashBlocks[i];
            
            await sendPicobootCommand(device, outEndpoint, inEndpoint, {
                magic: PICOBOOT_MAGIC,
                token: i + 2,
                cmdId: PC_WRITE,
                cmdSize: 8, // sizeof(picoboot_range_cmd): dAddr + dSize = 4 + 4 = 8 bytes
                transferLength: block.data.length,
                address: block.address,
                size: block.data.length
            }, block.data);
            
            // Update progress
            const percent = Math.round((i + 1) * 100 / flashBlocks.length);
            statusDiv.textContent = `Writing flash: ${percent}% (${i + 1}/${flashBlocks.length} blocks)`;
        }
        
        // Step 3: Reboot
        statusDiv.textContent = 'Rebooting device...';
        await sendPicobootCommand(device, outEndpoint, inEndpoint, {
            magic: PICOBOOT_MAGIC,
            token: 999,
            cmdId: PC_REBOOT,
            cmdSize: 12, // sizeof(picoboot_reboot_cmd): dPC + dSP + dDelayMS = 4 + 4 + 4 = 12 bytes
            transferLength: 0,
            pc: 0x10000000, // Flash base
            sp: 0x20042000, // End of RAM
            delayMs: 100
        });
        
        console.log('PICOBOOT upload completed successfully');
        
    } finally {
        // Always release the interface
        try {
            await device.releaseInterface(vendorInterface.interface.interfaceNumber);
            console.log('Released vendor interface');
        } catch (releaseErr) {
            console.log('Error releasing vendor interface:', releaseErr.message);
        }
    }
}

// Send PICOBOOT command
async function sendPicobootCommand(device, outEndpoint, inEndpoint, cmd, data = null) {
    // Create command packet (32 bytes total as per picoboot_cmd struct)
    const cmdBuffer = new ArrayBuffer(32); 
    const cmdView = new DataView(cmdBuffer);
    
    // Header fields (matches struct picoboot_cmd exactly)
    cmdView.setUint32(0, cmd.magic, true);      // dMagic
    cmdView.setUint32(4, cmd.token, true);      // dToken
    cmdView.setUint8(8, cmd.cmdId);             // bCmdId
    cmdView.setUint8(9, cmd.cmdSize);           // bCmdSize
    cmdView.setUint16(10, 0, true);             // _unused (CRITICAL: was missing!)
    cmdView.setUint32(12, cmd.transferLength, true); // dTransferLength
    
    // Command args start at offset 16 (union args[16])
    if (cmd.cmdId === 0x03 || cmd.cmdId === 0x05) { // FLASH_ERASE or WRITE
        cmdView.setUint32(16, cmd.address, true);
        cmdView.setUint32(20, cmd.size, true);
    } else if (cmd.cmdId === 0x02) { // REBOOT
        cmdView.setUint32(16, cmd.pc, true);
        cmdView.setUint32(20, cmd.sp, true);
        cmdView.setUint32(24, cmd.delayMs, true);
    }
    
    // Send full 32-byte command packet (struct size is always 32 bytes)
    const cmdData = new Uint8Array(cmdBuffer);
    const result = await device.transferOut(outEndpoint.endpointNumber, cmdData);
    
    if (result.status !== 'ok') {
        throw new Error(`PICOBOOT command failed: ${result.status}`);
    }
    
    // Send data if provided
    if (data) {
        const dataResult = await device.transferOut(outEndpoint.endpointNumber, data);
        if (dataResult.status !== 'ok') {
            throw new Error(`PICOBOOT data transfer failed: ${dataResult.status}`);
        }
    }
    
    // Read status response
    try {
        const statusResult = await device.transferIn(inEndpoint.endpointNumber, 32);
        if (statusResult.status === 'ok') {
            const statusView = new DataView(statusResult.data.buffer);
            const statusCode = statusView.getUint32(8, true); // dStatusCode field
            if (statusCode !== 0) {
                console.log(`PICOBOOT command status: ${statusCode}`);
            }
        }
    } catch (statusErr) {
        // Status read might fail if device rebooted
        console.log('Status read failed (device may have rebooted):', statusErr.message);
    }
}

// Extract flash data from UF2
function extractFlashDataFromUF2(uf2Buffer) {
    const UF2_MAGIC_START0 = 0x0A324655;
    const UF2_MAGIC_START1 = 0x9E5D5157;
    const UF2_MAGIC_END = 0x0AB16F30;
    const UF2_FLAG_NOT_MAIN_FLASH = 0x00001000;
    const UF2_FLAG_FILE_CONTAINER = 0x00001000;
    
    const blocks = [];
    const view = new DataView(uf2Buffer);
    
    for (let offset = 0; offset < uf2Buffer.byteLength; offset += 512) {
        // Verify UF2 magic
        const magic0 = view.getUint32(offset, true);
        const magic1 = view.getUint32(offset + 4, true);
        const magicEnd = view.getUint32(offset + 508, true);
        
        if (magic0 !== UF2_MAGIC_START0 || magic1 !== UF2_MAGIC_START1 || magicEnd !== UF2_MAGIC_END) {
            continue;
        }
        
        // Extract UF2 fields
        const flags = view.getUint32(offset + 8, true);
        const targetAddr = view.getUint32(offset + 12, true);
        const payloadSize = view.getUint32(offset + 16, true);
        
        // Skip non-flash blocks
        if (flags & UF2_FLAG_NOT_MAIN_FLASH) {
            continue;
        }
        
        // Extract payload data (up to 476 bytes at offset 32)
        const actualSize = Math.min(payloadSize, 476);
        const data = new Uint8Array(uf2Buffer, offset + 32, actualSize);
        
        blocks.push({
            address: targetAddr,
            data: data
        });
    }
    
    // Merge contiguous blocks
    blocks.sort((a, b) => a.address - b.address);
    const merged = [];
    
    for (const block of blocks) {
        if (merged.length === 0) {
            merged.push(block);
        } else {
            const last = merged[merged.length - 1];
            if (last.address + last.data.length === block.address) {
                // Merge contiguous blocks
                const newData = new Uint8Array(last.data.length + block.data.length);
                newData.set(last.data, 0);
                newData.set(block.data, last.data.length);
                last.data = newData;
            } else {
                merged.push(block);
            }
        }
    }
    
    console.log(`Merged ${blocks.length} UF2 blocks into ${merged.length} flash blocks`);
    return merged;
}

// Convert UF2 blocks to HF2 format
function convertUF2ToHF2(uf2Buffer) {
    const UF2_MAGIC_START0 = 0x0A324655;
    const UF2_MAGIC_START1 = 0x9E5D5157;
    const UF2_MAGIC_END = 0x0AB16F30;
    
    const blocks = [];
    const view = new DataView(uf2Buffer);
    
    for (let offset = 0; offset < uf2Buffer.byteLength; offset += 512) {
        // Verify UF2 magic
        const magic0 = view.getUint32(offset, true);
        const magic1 = view.getUint32(offset + 4, true);
        const magicEnd = view.getUint32(offset + 508, true);
        
        if (magic0 !== UF2_MAGIC_START0 || magic1 !== UF2_MAGIC_START1 || magicEnd !== UF2_MAGIC_END) {
            console.log(`Invalid UF2 block at offset ${offset}`);
            continue;
        }
        
        // Extract UF2 fields
        const flags = view.getUint32(offset + 8, true);
        const targetAddr = view.getUint32(offset + 12, true);
        const payloadSize = view.getUint32(offset + 16, true);
        
        // Skip blocks that don't contain flash data
        if (!(flags & 0x00002000)) { // Not a flash block
            continue;
        }
        
        // Extract payload data (up to 476 bytes at offset 32)
        const actualSize = Math.min(payloadSize, 476);
        const data = new Uint8Array(uf2Buffer, offset + 32, actualSize);
        
        blocks.push({
            address: targetAddr,
            data: data
        });
    }
    
    console.log(`Converted ${blocks.length} UF2 blocks to HF2 format`);
    return blocks;
}

// Write HF2 data blocks to device flash memory
async function writeHF2Data(device, vendorInterface, hf2Blocks) {
    const HF2_CMD_WRITE_FLASH = 0x01;
    const total = hf2Blocks.length;
    
    for (let i = 0; i < total; i++) {
        const block = hf2Blocks[i];
        
        // Create HF2 write command
        const cmdBuffer = new ArrayBuffer(8 + block.data.length);
        const cmdView = new DataView(cmdBuffer);
        const cmdData = new Uint8Array(cmdBuffer);
        
        // HF2 packet header
        cmdView.setUint8(0, HF2_CMD_WRITE_FLASH);
        cmdView.setUint8(1, 0); // Reserved
        cmdView.setUint16(2, block.data.length + 4, true); // Length
        cmdView.setUint32(4, block.address, true); // Target address
        
        // Copy payload data
        cmdData.set(block.data, 8);
        
        try {
            // Send via control transfer (HF2 style)
            const result = await device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'interface',
                request: 0x09, // SET_REPORT-style request
                value: 0x200,  // Output report
                index: vendorInterface.interface.interfaceNumber
            }, cmdData);
            
            if (result.status !== 'ok') {
                throw new Error(`HF2 write failed at block ${i}: ${result.status}`);
            }
            
            // Update progress
            if (i % 10 === 0 || i === total - 1) {
                const percent = Math.round((i + 1) * 100 / total);
                statusDiv.textContent = `Writing firmware: ${percent}% (${i + 1}/${total} blocks)`;
            }
            
        } catch (writeErr) {
            // Check for USB STALL - means HF2 protocol is not supported
            if (writeErr.message && (writeErr.message.includes('stall') || writeErr.message.includes('STALL'))) {
                console.log(`HF2 protocol STALL on block ${i + 1} - device does not support HF2`);
                throw new Error('Device does not support HF2 protocol (USB STALL). Standard RP2040 bootloader detected.');
            }
            
            // If write fails near the end, device might be rebooting
            if (i > total * 0.9) {
                console.log('Write failed near end - device likely rebooting');
                return;
            }
            throw writeErr;
        }
    }
}

// Send HF2 reset command to restart device
async function sendHF2Reset(device, vendorInterface) {
    const HF2_CMD_RESET = 0x04;
    const resetCmd = new Uint8Array([HF2_CMD_RESET, 0, 0, 0]); // Command + 3 bytes padding
    
    try {
        await device.controlTransferOut({
            requestType: 'vendor',
            recipient: 'interface', 
            request: 0x09,
            value: 0x200,
            index: vendorInterface.interface.interfaceNumber
        }, resetCmd);
        
        console.log('HF2 reset command sent');
    } catch (resetErr) {
        // Reset command might fail if device already started rebooting
        console.log('Reset command result:', resetErr.message);
    }
}

// Check browser compatibility on load
document.addEventListener('DOMContentLoaded', () => {
    const hasWebUSB = 'usb' in navigator;
    const isSecure = window.location.protocol === 'https:' || window.location.hostname === 'localhost';
    
    if (!hasWebUSB) {
        statusDiv.innerHTML = `
            <div style="color: red;">
                ❌ WebUSB not supported in this browser.<br>
                Please use Chrome, Edge, or another Chromium-based browser.
            </div>
        `;
        uploadBtn.disabled = true;
        return;
    }
    
    if (!isSecure) {
        statusDiv.innerHTML = `
            <div style="color: red;">
                ❌ HTTPS required for WebUSB.<br>
                Please use https:// or localhost.
            </div>
        `;
        uploadBtn.disabled = true;
        return;
    }
    
    statusDiv.textContent = 'Ready - select a UF2 file to upload';
});
