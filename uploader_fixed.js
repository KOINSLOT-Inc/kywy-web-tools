// Fixed serial upload function for KYWY devices
async function attemptSerialUpload(arrayBuffer) {
    if (!('serial' in navigator)) throw new Error('Web Serial API not available');
    
    statusDiv.textContent = 'Looking for KYWY device to reset into bootloader mode...';
    
    // Request user to select the KYWY device to put into bootloader mode
    let devicePort;
    try {
        // Try to find KYWY or RP2040 devices first
        const filters = [{ usbVendorId: 0x2e8a }]; // RP2040 vendor ID
        devicePort = await navigator.serial.requestPort({ filters });
    } catch (err) {
        if (err.name === 'NotFoundError') {
            // Try without filters as fallback
            try {
                statusDiv.textContent = 'No RP2040 devices found, showing all available serial ports...';
                devicePort = await navigator.serial.requestPort();
            } catch (err2) {
                if (err2.name === 'NotFoundError') {
                    throw new Error('No serial devices available. Make sure your KYWY device is connected.');
                }
                throw err2;
            }
        } else {
            throw err;
        }
    }
    
    // Show which device was selected
    const info = devicePort.getInfo ? devicePort.getInfo() : {};
    let deviceName = 'Selected device';
    if (info.usbVendorId === 0x2e8a || info.vendorId === 0x2e8a) {
        if (info.usbProductId === 0x0003) {
            deviceName = 'Raspberry Pi Pico';
        } else if (info.usbProductId === 0x000a) {
            deviceName = 'Raspberry Pi Pico W';
        } else if (info.usbProductId === 0x000f) {
            deviceName = 'Raspberry Pi Pico 2';
        } else {
            deviceName = 'KYWY Device (RP2040-based)';
        }
        if (info.usbVendorId && info.usbProductId) {
            deviceName += ` (VID:${info.usbVendorId.toString(16).toUpperCase().padStart(4, '0')} PID:${info.usbProductId.toString(16).toUpperCase().padStart(4, '0')})`;
        }
    } else {
        const vid = info.usbVendorId || info.vendorId || 'Unknown';
        const pid = info.usbProductId || info.productId || 'Unknown';
        deviceName = `Serial Device (VID:${vid.toString(16).toUpperCase()} PID:${pid.toString(16).toUpperCase()})`;
    }
    
    statusDiv.textContent = `Triggering bootloader mode on ${deviceName}...`;
    
    try {
        // Trigger bootloader mode with 1200 baud reset (this works for KYWY/RP2040 devices)
        await devicePort.open({ baudRate: 1200 });
        await new Promise(resolve => setTimeout(resolve, 100)); // Brief connection
        await devicePort.close();
        
        statusDiv.textContent = 'Device reset to bootloader mode. The device should now appear as a UF2 drive.';
        
        // Wait a moment for the device to reset and appear as mass storage
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        statusDiv.textContent = '✅ Serial reset complete! Your KYWY device should now appear as a USB drive named "RPI-RP2" or similar. You can now drag and drop your UF2 file to that drive.';
        
        return true;
        
    } catch (resetError) {
        throw new Error(`Failed to reset ${deviceName}: ${resetError.message}`);
    }
}
