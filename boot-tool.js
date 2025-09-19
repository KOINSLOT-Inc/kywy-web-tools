/**
 * Kywy Boot Tool - Serial connection and reboot functionality
 * Uses Web Serial API to connect to Kywy devices and trigger reboots
 */

class KywyBootTool {
    constructor() {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.isConnected = false;
        
        this.initializeElements();
        this.attachEventListeners();
        this.checkWebSerialSupport();
    }
    
    initializeElements() {
        this.connectBtn = document.getElementById('connectBtn');
        this.disconnectBtn = document.getElementById('disconnectBtn');
        this.rebootBtn = document.getElementById('rebootBtn');
        this.connectionStatus = document.getElementById('connectionStatus');
        this.bootStatus = document.getElementById('bootStatus');
    }
    
    attachEventListeners() {
        this.connectBtn.addEventListener('click', () => this.connectToDevice());
        this.disconnectBtn.addEventListener('click', () => this.disconnectDevice());
        this.rebootBtn.addEventListener('click', () => this.rebootDevice());
    }
    
    checkWebSerialSupport() {
        if (!('serial' in navigator)) {
            this.updateConnectionStatus('Web Serial API not supported in this browser', 'error');
            this.connectBtn.disabled = true;
            this.bootStatus.textContent = 'Chrome-based browsers are recommended (Chrome, Edge, Opera)';
            this.bootStatus.className = 'status-display error';
            
            // Show browser compatibility warning
            this.showBrowserWarning();
        }
    }
    
    showBrowserWarning() {
        // Create a warning banner if it doesn't exist
        let warningBanner = document.getElementById('browserWarning');
        if (!warningBanner) {
            warningBanner = document.createElement('div');
            warningBanner.id = 'browserWarning';
            warningBanner.className = 'browser-warning';
            warningBanner.innerHTML = `
                <div class="warning-content">
                    <strong>⚠️ Browser Compatibility Warning</strong>
                    <p>This tool requires the Web Serial API, which is only supported in Chrome-based browsers.</p>
                    <p><strong>Recommended browsers:</strong> Chrome, Microsoft Edge, Opera, or other Chromium-based browsers.</p>
                    <p><strong>Not supported:</strong> Firefox, Safari, and older browser versions.</p>
                </div>
            `;
            
            // Insert the warning at the top of the container
            const container = document.querySelector('.container');
            container.insertBefore(warningBanner, container.firstChild);
        }
    }
    
    async connectToDevice() {
        try {
            this.updateConnectionStatus('Requesting device...', 'loading');
            this.connectBtn.classList.add('loading');
            this.connectBtn.disabled = true;
            
            // Request a port with filters for common Arduino/RP2040 devices
            this.port = await navigator.serial.requestPort({
                filters: [
                    { usbVendorId: 0x2e8a }, // Raspberry Pi
                    { usbVendorId: 0x2341 }, // Arduino
                    { usbVendorId: 0x1a86 }, // CH340
                    { usbVendorId: 0x0403 }, // FTDI
                    { usbVendorId: 0x10c4 }, // Silicon Labs
                ]
            });
            
            // Open the port with standard settings
            await this.port.open({ 
                baudRate: 115200, // Standard baud rate for communication
                dataBits: 8,
                stopBits: 1,
                parity: 'none',
                flowControl: 'none'
            });
            
            // Set up readers and writers
            this.reader = this.port.readable.getReader();
            this.writer = this.port.writable.getWriter();
            
            this.isConnected = true;
            this.updateConnectionStatus('Connected to Kywy device', 'connected');
            this.updateBootStatus('Ready to reboot device', 'success');
            
            // Update button states
            this.connectBtn.disabled = true;
            this.disconnectBtn.disabled = false;
            this.rebootBtn.disabled = false;
            
            // Start reading (optional, for debugging)
            this.startReading();
            
        } catch (error) {
            console.error('Connection failed:', error);
            this.updateConnectionStatus(`Connection failed: ${error.message}`, 'error');
            this.updateBootStatus('Connection required for reboot', 'error');
        } finally {
            this.connectBtn.classList.remove('loading');
            this.connectBtn.disabled = false;
        }
    }
    
    async disconnectDevice() {
        try {
            if (this.reader) {
                await this.reader.cancel();
                await this.reader.releaseLock();
                this.reader = null;
            }
            
            if (this.writer) {
                await this.writer.releaseLock();
                this.writer = null;
            }
            
            if (this.port) {
                await this.port.close();
                this.port = null;
            }
            
            this.isConnected = false;
            this.updateConnectionStatus('Disconnected', '');
            this.updateBootStatus('Connect device to enable reboot', '');
            
            // Update button states
            this.connectBtn.disabled = false;
            this.disconnectBtn.disabled = true;
            this.rebootBtn.disabled = true;
            
        } catch (error) {
            console.error('Disconnect failed:', error);
            this.updateConnectionStatus(`Disconnect error: ${error.message}`, 'error');
        }
    }
    
    async rebootDevice() {
        if (!this.isConnected || !this.port) {
            this.updateBootStatus('No device connected', 'error');
            return;
        }
        
        try {
            this.updateBootStatus('Initiating reboot...', 'loading');
            this.rebootBtn.classList.add('loading');
            this.rebootBtn.disabled = true;
            
            // Close current connection
            if (this.reader) {
                await this.reader.cancel();
                await this.reader.releaseLock();
                this.reader = null;
            }
            
            if (this.writer) {
                await this.writer.releaseLock();
                this.writer = null;
            }
            
            await this.port.close();
            
            // Small delay
            await this.sleep(100);
            
            // Reopen at 1200 baud to trigger bootloader
            await this.port.open({ 
                baudRate: 1200,
                dataBits: 8,
                stopBits: 1,
                parity: 'none',
                flowControl: 'none'
            });
            
            this.updateBootStatus('Sent 1200 baud signal...', 'loading');
            
            // Keep the 1200 baud connection open briefly
            await this.sleep(250);
            
            // Close the connection - this should trigger the reboot
            await this.port.close();
            
            this.updateBootStatus('Reboot signal sent successfully!', 'success');
            this.updateConnectionStatus('Device rebooted - reconnect if needed', '');
            
            // Reset connection state
            this.port = null;
            this.isConnected = false;
            this.connectBtn.disabled = false;
            this.disconnectBtn.disabled = true;
            
            // Wait a moment then re-enable reboot button
            setTimeout(() => {
                this.rebootBtn.disabled = true;
                this.updateBootStatus('Reboot complete - connect to reboot again', '');
            }, 2000);
            
        } catch (error) {
            console.error('Reboot failed:', error);
            this.updateBootStatus(`Reboot failed: ${error.message}`, 'error');
        } finally {
            this.rebootBtn.classList.remove('loading');
        }
    }
    
    async startReading() {
        if (!this.reader) return;
        
        try {
            while (this.isConnected) {
                const { value, done } = await this.reader.read();
                if (done) break;
                
                // Convert received data to string (optional - for debugging)
                const text = new TextDecoder().decode(value);
                console.log('Received:', text);
            }
        } catch (error) {
            if (error.name !== 'NetworkError') {
                console.error('Read error:', error);
            }
        }
    }
    
    updateConnectionStatus(message, type = '') {
        this.connectionStatus.textContent = message;
        this.connectionStatus.className = `status-display ${type}`;
    }
    
    updateBootStatus(message, type = '') {
        this.bootStatus.textContent = message;
        this.bootStatus.className = `status-display ${type}`;
    }
    
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Initialize the boot tool when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new KywyBootTool();
});

// Handle page unload to clean up connections
window.addEventListener('beforeunload', async () => {
    if (window.bootTool && window.bootTool.isConnected) {
        try {
            await window.bootTool.disconnectDevice();
        } catch (error) {
            console.error('Cleanup error:', error);
        }
    }
});
