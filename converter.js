/*
 * KYWY Web Tools - Image Converter
 * Copyright (c) 2025 KOINSLOT, Inc.
 * Licensed under the BSD 3-Clause License
 */

class ImageToHppConverter {
    constructor() {
        this.originalImage = null;
        this.processedImageData = null;
        this.previewTimeout = null;
        this.isProcessing = false;
        this.initializeEventListeners();
    }

    initializeEventListeners() {
        const imageInput = document.getElementById('imageInput');
        const copyBtn = document.getElementById('copyBtn');
        const downloadBtn = document.getElementById('downloadBtn');
        const downloadImageBtn = document.getElementById('downloadImageBtn');
        const resizeSelect = document.getElementById('resize');
        const contrastRange = document.getElementById('contrast');
        const brightnessRange = document.getElementById('brightness');
        const thresholdRange = document.getElementById('threshold');
        const previewScaleRange = document.getElementById('previewScale');

        imageInput.addEventListener('change', (e) => this.handleImageUpload(e));
        copyBtn.addEventListener('click', () => this.copyToClipboard());
        downloadBtn.addEventListener('click', () => {
            this.downloadHpp();
        });
        downloadImageBtn.addEventListener('click', () => {
            this.downloadProcessedImage();
        });
        
        resizeSelect.addEventListener('change', (e) => {
            const customDiv = document.getElementById('customSize');
            customDiv.style.display = e.target.value === 'custom' ? 'block' : 'none';
            this.updateLivePreview();
        });

        // Custom size inputs
        document.getElementById('customWidth').addEventListener('input', () => this.updateLivePreview());
        document.getElementById('customHeight').addEventListener('input', () => this.updateLivePreview());

        // Real-time value updates and live preview
        contrastRange.addEventListener('input', (e) => {
            document.getElementById('contrastValue').textContent = e.target.value;
            this.updateLivePreview();
        });
        
        brightnessRange.addEventListener('input', (e) => {
            document.getElementById('brightnessValue').textContent = e.target.value;
            this.updateLivePreview();
        });
        
        thresholdRange.addEventListener('input', (e) => {
            document.getElementById('thresholdValue').textContent = e.target.value;
            this.updateLivePreview();
        });

        previewScaleRange.addEventListener('input', (e) => {
            document.getElementById('previewScaleValue').textContent = e.target.value + 'x';
            this.displayProcessedImage(); // Redraw with new scale
        });

        // Add live preview for other controls
        document.getElementById('invert').addEventListener('change', () => this.updateLivePreview());
        document.getElementById('edgeDetection').addEventListener('change', () => this.updateLivePreview());
        document.getElementById('rotate').addEventListener('change', () => this.updateLivePreview());
        document.getElementById('dithering').addEventListener('change', () => this.updateLivePreview());
        document.getElementById('arrayName').addEventListener('input', () => this.generateHppOutput());

        // Auto adjustment buttons
        document.getElementById('autoBrightnessBtn').addEventListener('click', () => this.autoAdjustBrightness());
        document.getElementById('autoContrastBtn').addEventListener('click', () => this.autoAdjustContrast());
        document.getElementById('autoThresholdBtn').addEventListener('click', () => this.autoAdjustThreshold());
        document.getElementById('autoAllBtn').addEventListener('click', () => this.autoAdjustAll());
    }

    handleImageUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                this.originalImage = img;
                this.displayOriginalImage(img);
                // Start live preview as soon as image is loaded
                this.updateLivePreview();
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    }

    updateLivePreview() {
        if (!this.originalImage || this.isProcessing) return;
        
        // Show processing indicator
        const previewContainer = document.getElementById('processedImage');
        if (!previewContainer.querySelector('.processing-indicator')) {
            const indicator = document.createElement('div');
            indicator.className = 'processing-indicator';
            indicator.textContent = 'Updating preview...';
            previewContainer.appendChild(indicator);
        }
        
        // Debounce the preview updates to avoid excessive processing
        if (this.previewTimeout) {
            clearTimeout(this.previewTimeout);
        }
        
        this.previewTimeout = setTimeout(() => {
            this.isProcessing = true;
            this.convertImage(true); // true = preview mode
            
            // Remove processing indicator after a short delay
            setTimeout(() => {
                this.isProcessing = false;
                const indicator = previewContainer.querySelector('.processing-indicator');
                if (indicator) {
                    indicator.remove();
                }
            }, 50);
        }, 150);
    }

    displayOriginalImage(img) {
        const container = document.getElementById('originalImage');
        container.innerHTML = '';
        
        // Create a canvas to show the original image
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        // Scale down for display if too large
        const maxDisplaySize = 300;
        let displayWidth = img.width;
        let displayHeight = img.height;
        
        if (img.width > maxDisplaySize || img.height > maxDisplaySize) {
            const scale = Math.min(maxDisplaySize / img.width, maxDisplaySize / img.height);
            displayWidth = img.width * scale;
            displayHeight = img.height * scale;
        }
        
        canvas.width = displayWidth;
        canvas.height = displayHeight;
        ctx.drawImage(img, 0, 0, displayWidth, displayHeight);
        
        container.appendChild(canvas);
        
        const info = document.createElement('p');
        info.textContent = `Original size: ${img.width} x ${img.height}`;
        container.appendChild(info);
    }

    getTargetDimensions() {
        const resizeValue = document.getElementById('resize').value;
        
        if (!resizeValue) {
            return { width: this.originalImage.width, height: this.originalImage.height };
        }
        
        if (resizeValue === 'custom') {
            const customWidth = parseInt(document.getElementById('customWidth').value);
            const customHeight = parseInt(document.getElementById('customHeight').value);
            return { 
                width: customWidth || this.originalImage.width, 
                height: customHeight || this.originalImage.height 
            };
        }
        
        const [width, height] = resizeValue.split('x').map(Number);
        return { width, height };
    }

    convertImage(isPreview = false) {
        if (!this.originalImage) {
            if (!isPreview) {
                alert('Please upload an image first');
            }
            return;
        }

        const brightness = parseInt(document.getElementById('brightness').value);
        const contrast = parseInt(document.getElementById('contrast').value);
        const threshold = parseInt(document.getElementById('threshold').value);
        const invert = document.getElementById('invert').checked;
        const edgeDetection = document.getElementById('edgeDetection').checked;
        const rotate = parseInt(document.getElementById('rotate').value);
        const dithering = document.getElementById('dithering').value;

        // First, apply rotation to original image if needed
        let sourceImage = this.originalImage;
        if (rotate !== 0) {
            sourceImage = this.rotateImage(this.originalImage, rotate);
        }

        // Get target dimensions AFTER rotation
        const { width, height } = this.getTargetDimensions();

        // Update settings summary - removed per user request

        // Create canvas for processing with final dimensions
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = width;
        canvas.height = height;

        // Draw and resize the rotated image to final dimensions
        ctx.drawImage(sourceImage, 0, 0, width, height);
        
        // Get image data
        let imageData = ctx.getImageData(0, 0, width, height);
        
        // Apply brightness and contrast
        // Apply brightness and contrast
        imageData = this.adjustBrightnessContrast(imageData, brightness, contrast);
        
        // Convert to grayscale
        imageData = this.convertToGrayscale(imageData);
        
        // Apply edge detection if selected
        if (edgeDetection) {
            imageData = this.applyEdgeDetection(imageData);
        }
        
        // Apply dithering if selected
        if (dithering !== 'none') {
            imageData = this.applyDithering(imageData, dithering, threshold);
        }
        
        // Convert to binary
        const binaryData = this.convertToBinary(imageData, threshold, invert);
        
        // Check if dimensions exceed display size (144x168) and show/hide warning
        const sizeWarning = document.getElementById('sizeWarning');
        if (width > 144 || height > 168) {
            sizeWarning.style.display = 'block';
        } else {
            sizeWarning.style.display = 'none';
        }
        
        this.processedImageData = {
            width: width,
            height: height,
            data: binaryData
        };

        this.displayProcessedImage();
        
        // Only generate HPP output if not in preview mode or if explicitly requested
        if (!isPreview) {
            this.generateHppOutput();
        } else if (this.processedImageData) {
            // Generate HPP output for live preview too
            this.generateHppOutput();
        }
    }

    applyEdgeDetection(imageData) {
        const { width, height, data } = imageData;
        const output = new Uint8ClampedArray(data.length);
        
        // Sobel edge detection kernels
        const sobelX = [
            [-1, 0, 1],
            [-2, 0, 2],
            [-1, 0, 1]
        ];
        
        const sobelY = [
            [-1, -2, -1],
            [ 0,  0,  0],
            [ 1,  2,  1]
        ];
        
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                let gx = 0, gy = 0;
                
                // Apply Sobel kernels
                for (let ky = -1; ky <= 1; ky++) {
                    for (let kx = -1; kx <= 1; kx++) {
                        const idx = ((y + ky) * width + (x + kx)) * 4;
                        const pixel = data[idx]; // Grayscale value
                        
                        gx += pixel * sobelX[ky + 1][kx + 1];
                        gy += pixel * sobelY[ky + 1][kx + 1];
                    }
                }
                
                // Calculate gradient magnitude
                const magnitude = Math.sqrt(gx * gx + gy * gy);
                const edgeValue = Math.min(255, magnitude);
                
                const idx = (y * width + x) * 4;
                output[idx] = edgeValue;     // R
                output[idx + 1] = edgeValue; // G
                output[idx + 2] = edgeValue; // B
                output[idx + 3] = 255;       // A
            }
        }
        
        // Copy alpha channel and handle edges
        for (let i = 0; i < data.length; i += 4) {
            if (output[i] === 0 && output[i + 1] === 0 && output[i + 2] === 0) {
                // Border pixels - copy original
                output[i] = data[i];
                output[i + 1] = data[i + 1];
                output[i + 2] = data[i + 2];
            }
            output[i + 3] = 255;
        }
        
        return new ImageData(output, width, height);
    }

    updateSettingsSummary(width, height, brightness, contrast, threshold, invert, rotate, dithering) {
        const summary = document.getElementById('settingsSummary');
        const settings = [];
        
        settings.push(`Size: ${width}×${height}`);
        if (brightness !== 0) settings.push(`Brightness: ${brightness > 0 ? '+' : ''}${brightness}`);
        if (contrast !== 0) settings.push(`Contrast: ${contrast > 0 ? '+' : ''}${contrast}`);
        settings.push(`Threshold: ${threshold}`);
        if (invert) settings.push('Inverted');
        if (rotate !== 0) settings.push(`Rotated: ${rotate}°`);
        if (dithering !== 'none') settings.push(`Dithering: ${dithering}`);
        
        summary.innerHTML = `<div class="settings-summary"><strong>Current Settings:</strong> ${settings.join(' • ')}</div>`;
    }

    rotateImage(image, angle) {
        if (angle === 0) return image;
        
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        // Set canvas dimensions based on rotation
        if (angle === 90 || angle === 270) {
            canvas.width = image.height;
            canvas.height = image.width;
        } else {
            canvas.width = image.width;
            canvas.height = image.height;
        }
        
        // Apply rotation transformation
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate((angle * Math.PI) / 180);
        
        // Draw the image centered and rotated
        ctx.drawImage(image, -image.width / 2, -image.height / 2);
        
        // Return the canvas itself (it can be used like an image)
        return canvas;
    }

    rotateImageData(imageData, angle) {
        const { width, height, data } = imageData;
        let newWidth, newHeight;
        
        if (angle === 90 || angle === 270) {
            newWidth = height;
            newHeight = width;
        } else {
            newWidth = width;
            newHeight = height;
        }
        
        const newData = new Uint8ClampedArray(newWidth * newHeight * 4);
        
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const srcIndex = (y * width + x) * 4;
                let destX, destY;
                
                switch (angle) {
                    case 90:
                        destX = height - 1 - y;
                        destY = x;
                        break;
                    case 180:
                        destX = width - 1 - x;
                        destY = height - 1 - y;
                        break;
                    case 270:
                        destX = y;
                        destY = width - 1 - x;
                        break;
                    default:
                        destX = x;
                        destY = y;
                }
                
                const destIndex = (destY * newWidth + destX) * 4;
                newData[destIndex] = data[srcIndex];         // R
                newData[destIndex + 1] = data[srcIndex + 1]; // G
                newData[destIndex + 2] = data[srcIndex + 2]; // B
                newData[destIndex + 3] = data[srcIndex + 3]; // A
            }
        }
        
        return new ImageData(newData, newWidth, newHeight);
    }

    adjustBrightnessContrast(imageData, brightness, contrast) {
        const data = new Uint8ClampedArray(imageData.data);
        const contrastFactor = (259 * (contrast + 255)) / (255 * (259 - contrast));
        
        for (let i = 0; i < data.length; i += 4) {
            // Apply brightness
            let r = data[i] + brightness;
            let g = data[i + 1] + brightness;
            let b = data[i + 2] + brightness;
            
            // Apply contrast
            r = contrastFactor * (r - 128) + 128;
            g = contrastFactor * (g - 128) + 128;
            b = contrastFactor * (b - 128) + 128;
            
            // Clamp values
            data[i] = Math.max(0, Math.min(255, r));
            data[i + 1] = Math.max(0, Math.min(255, g));
            data[i + 2] = Math.max(0, Math.min(255, b));
        }
        
        return new ImageData(data, imageData.width, imageData.height);
    }

    convertToGrayscale(imageData) {
        const data = new Uint8ClampedArray(imageData.data);
        
        for (let i = 0; i < data.length; i += 4) {
            // Using luminance formula
            const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            data[i] = gray;     // R
            data[i + 1] = gray; // G
            data[i + 2] = gray; // B
        }
        
        return new ImageData(data, imageData.width, imageData.height);
    }

    applyDithering(imageData, method, threshold = 128) {
        const { width, height } = imageData;
        const data = new Float32Array(imageData.data);
        
        switch (method) {
            case 'floyd-steinberg':
                return this.floydSteinbergDithering(imageData, data, width, height, threshold);
            case 'atkinson':
                return this.atkinsonDithering(imageData, data, width, height, threshold);
            case 'ordered':
                return this.orderedDithering(imageData, width, height, threshold);
            default:
                return imageData;
        }
    }

    floydSteinbergDithering(imageData, data, width, height, threshold) {
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const index = (y * width + x) * 4;
                const oldPixel = data[index];
                const newPixel = oldPixel < threshold ? 0 : 255;
                const error = oldPixel - newPixel;
                
                data[index] = newPixel;
                data[index + 1] = newPixel;
                data[index + 2] = newPixel;
                
                // Distribute error
                if (x + 1 < width) {
                    const idx = (y * width + x + 1) * 4;
                    data[idx] += error * 7/16;
                }
                if (y + 1 < height) {
                    if (x > 0) {
                        const idx = ((y + 1) * width + x - 1) * 4;
                        data[idx] += error * 3/16;
                    }
                    const idx = ((y + 1) * width + x) * 4;
                    data[idx] += error * 5/16;
                    if (x + 1 < width) {
                        const idx = ((y + 1) * width + x + 1) * 4;
                        data[idx] += error * 1/16;
                    }
                }
            }
        }
        
        return new ImageData(new Uint8ClampedArray(data), width, height);
    }

    atkinsonDithering(imageData, data, width, height, threshold) {
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const index = (y * width + x) * 4;
                const oldPixel = data[index];
                const newPixel = oldPixel < threshold ? 0 : 255;
                const error = oldPixel - newPixel;
                
                data[index] = newPixel;
                data[index + 1] = newPixel;
                data[index + 2] = newPixel;
                
                // Atkinson dithering pattern
                const positions = [
                    [1, 0], [2, 0],
                    [-1, 1], [0, 1], [1, 1],
                    [0, 2]
                ];
                
                positions.forEach(([dx, dy]) => {
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                        const idx = (ny * width + nx) * 4;
                        data[idx] += error / 8;
                    }
                });
            }
        }
        
        return new ImageData(new Uint8ClampedArray(data), width, height);
    }

    orderedDithering(imageData, width, height, threshold) {
        const bayerMatrix = [
            [0, 8, 2, 10],
            [12, 4, 14, 6],
            [3, 11, 1, 9],
            [15, 7, 13, 5]
        ];
        
        const data = new Uint8ClampedArray(imageData.data);
        
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const index = (y * width + x) * 4;
                const pixel = data[index];
                
                // Apply ordered dithering with user threshold
                const ditherValue = (bayerMatrix[y % 4][x % 4] / 16) * 64 - 32; // -32 to +32 range
                const adjustedThreshold = Math.max(0, Math.min(255, threshold + ditherValue));
                const newPixel = pixel > adjustedThreshold ? 255 : 0;
                
                data[index] = newPixel;
                data[index + 1] = newPixel;
                data[index + 2] = newPixel;
            }
        }
        
        return new ImageData(data, width, height);
    }

    convertToBinary(imageData, threshold, invert) {
        const { width, height, data } = imageData;
        const binaryData = [];
        
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x += 8) {
                let byte = 0;
                for (let bit = 0; bit < 8; bit++) {
                    if (x + bit < width) {
                        const index = (y * width + x + bit) * 4;
                        const pixel = data[index];
                        let isBlack = pixel < threshold;
                        
                        if (invert) {
                            isBlack = !isBlack;
                        }
                        
                        if (!isBlack) { // White pixel (bit = 1)
                            byte |= (1 << (7 - bit));
                        }
                    } else {
                        // Padding with white pixels
                        if (!invert) {
                            byte |= (1 << (7 - bit));
                        }
                    }
                }
                binaryData.push(byte);
            }
        }
        
        return binaryData;
    }

    displayProcessedImage() {
        if (!this.processedImageData) return;
        
        const container = document.getElementById('processedImage');
        container.innerHTML = '';
        
        const { width, height, data } = this.processedImageData;
        
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        // Get user-selected scale
        const scale = parseInt(document.getElementById('previewScale').value);
        canvas.width = width * scale;
        canvas.height = height * scale;
        
        const imageData = ctx.createImageData(width, height);
        
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const byteIndex = Math.floor((y * Math.ceil(width / 8)) + (x / 8));
                const bitIndex = 7 - (x % 8);
                const byte = data[byteIndex] || 0;
                const isWhite = (byte >> bitIndex) & 1;
                const color = isWhite ? 255 : 0;
                
                const index = (y * width + x) * 4;
                imageData.data[index] = color;     // R
                imageData.data[index + 1] = color; // G
                imageData.data[index + 2] = color; // B
                imageData.data[index + 3] = 255;   // A
            }
        }
        
        // Create temporary canvas for the actual size
        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d');
        tempCanvas.width = width;
        tempCanvas.height = height;
        tempCtx.putImageData(imageData, 0, 0);
        
        // Scale it up
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tempCanvas, 0, 0, width * scale, height * scale);
        
        container.appendChild(canvas);
        
        const info = document.createElement('p');
        info.textContent = `Processed size: ${width} x ${height}, Scale: ${scale}x`;
        container.appendChild(info);
    }

    generateHppOutput() {
        if (!this.processedImageData) return;
        
        const { width, height, data } = this.processedImageData;
        const arrayName = document.getElementById('arrayName').value || 'my_image';
        
        let output = `// ================================================\n`;
        output += `//             ${arrayName} BITMAP ARRAY START\n`;
        output += `// ================================================\n\n`;
        output += `// Size: ${width} x ${height}\n`;
        output += `// Total bytes: ${data.length}\n\n`;
        output += `uint8_t ${arrayName}[] = {\n`;
        
        for (let i = 0; i < data.length; i += 12) {
            output += '  ';
            for (let j = 0; j < 12 && i + j < data.length; j++) {
                output += `0x${data[i + j].toString(16).padStart(2, '0')}`;
                if (i + j < data.length - 1) {
                    output += ', ';
                }
            }
            output += '\n';
        }
        
        output += '};\n\n';
        output += `// ================================================\n`;
        output += `//               ${arrayName} BITMAP ARRAY END\n`;
        output += `// ================================================`;
        
        document.getElementById('hppOutput').value = output;
        
        // Update usage example
        this.updateUsageExample(width, height, arrayName);
    }

    updateUsageExample(width, height, arrayName) {
        const usageExample = document.getElementById('usageExample');
        if (usageExample) {
            usageExample.textContent = `engine.display.drawBitmap(0, 0, ${width}, ${height}, ${arrayName});`;
        }
    }

    copyToClipboard() {
        const textarea = document.getElementById('hppOutput');
        textarea.select();
        document.execCommand('copy');
        alert('HPP code copied to clipboard!');
    }

    downloadHpp() {
        const content = document.getElementById('hppOutput').value;
        const arrayNameElement = document.getElementById('arrayName');
        const arrayName = (arrayNameElement ? arrayNameElement.value : '') || 'my_image';
        
        if (!content) {
            alert('No HPP code to download. Please convert an image first.');
            return;
        }
        
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${arrayName}.hpp`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    downloadProcessedImage() {
        if (!this.processedImageData) {
            alert('No processed image to download. Please convert an image first.');
            return;
        }
        
        const arrayNameElement = document.getElementById('arrayName');
        const arrayName = (arrayNameElement ? arrayNameElement.value : '') || 'my_image';
        
        const { width, height } = this.getTargetDimensions();
        
        // Create a canvas with the processed image
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        
        // Put the processed image data on the canvas
        ctx.putImageData(this.processedImageData, 0, 0);
        
        // Download as PNG
        canvas.toBlob((blob) => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${arrayName}_processed.png`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        });
    }

    // Auto adjustment methods
    getImageStatistics() {
        if (!this.originalImage) return null;

        const { width, height } = this.getTargetDimensions();
        const rotate = parseInt(document.getElementById('rotate').value);

        // First, apply rotation to original image if needed
        let sourceImage = this.originalImage;
        if (rotate !== 0) {
            sourceImage = this.rotateImage(this.originalImage, rotate);
        }

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = width;
        canvas.height = height;
        
        // Draw and resize the rotated image
        ctx.drawImage(sourceImage, 0, 0, width, height);
        
        // Get image data (no need to apply rotation again)
        let imageData = ctx.getImageData(0, 0, width, height);
        
        // Convert to grayscale for analysis
        imageData = this.convertToGrayscale(imageData);
        
        const data = imageData.data;
        let min = 255, max = 0, sum = 0, count = 0;
        
        // Calculate histogram and stats
        const histogram = new Array(256).fill(0);
        
        for (let i = 0; i < data.length; i += 4) {
            const value = data[i]; // Grayscale value
            histogram[value]++;
            min = Math.min(min, value);
            max = Math.max(max, value);
            sum += value;
            count++;
        }
        
        const mean = sum / count;
        
        // Calculate median
        let median = 0;
        let halfCount = count / 2;
        let cumulative = 0;
        for (let i = 0; i < 256; i++) {
            cumulative += histogram[i];
            if (cumulative >= halfCount) {
                median = i;
                break;
            }
        }
        
        return { min, max, mean, median, histogram, count };
    }

    autoAdjustBrightness() {
        const stats = this.getImageStatistics();
        if (!stats) {
            alert('Please upload an image first');
            return;
        }
        
        // Target median brightness around 128 (middle gray)
        const targetMedian = 128;
        const adjustment = Math.round(targetMedian - stats.median);
        
        // Clamp to slider range
        const clampedAdjustment = Math.max(-100, Math.min(100, adjustment));
        
        // Update slider and display
        const brightnessSlider = document.getElementById('brightness');
        brightnessSlider.value = clampedAdjustment;
        document.getElementById('brightnessValue').textContent = clampedAdjustment;
        
        this.updateLivePreview();
    }

    autoAdjustContrast() {
        const stats = this.getImageStatistics();
        if (!stats) {
            alert('Please upload an image first');
            return;
        }
        
        // If image is too flat (small range), increase contrast
        // If image is too harsh (uses full range), might decrease contrast
        const currentRange = stats.max - stats.min;
        const idealRange = 200; // Aim for good range but not completely harsh
        
        let contrastAdjustment = 0;
        
        if (currentRange < 100) {
            // Too flat, increase contrast significantly
            contrastAdjustment = 60;
        } else if (currentRange < 150) {
            // Somewhat flat, increase contrast moderately
            contrastAdjustment = 30;
        } else if (currentRange > 240) {
            // Too harsh, decrease contrast slightly
            contrastAdjustment = -20;
        }
        
        // Clamp to slider range
        contrastAdjustment = Math.max(-100, Math.min(100, contrastAdjustment));
        
        // Update slider and display
        const contrastSlider = document.getElementById('contrast');
        contrastSlider.value = contrastAdjustment;
        document.getElementById('contrastValue').textContent = contrastAdjustment;
        
        this.updateLivePreview();
    }

    autoAdjustLevels() {
        const stats = this.getImageStatistics();
        if (!stats) {
            alert('Please upload an image first');
            return;
        }
        
        // Auto levels: stretch the histogram to use full range
        // This is more sophisticated than individual brightness/contrast
        
        // Find 1% and 99% percentiles to ignore extreme outliers
        const lowPercentile = 0.01;
        const highPercentile = 0.99;
        
        let cumulative = 0;
        let lowValue = 0;
        let highValue = 255;
        
        // Find low percentile
        const lowTarget = stats.count * lowPercentile;
        for (let i = 0; i < 256; i++) {
            cumulative += stats.histogram[i];
            if (cumulative >= lowTarget) {
                lowValue = i;
                break;
            }
        }
        
        // Find high percentile
        cumulative = 0;
        const highTarget = stats.count * highPercentile;
        for (let i = 0; i < 256; i++) {
            cumulative += stats.histogram[i];
            if (cumulative >= highTarget) {
                highValue = i;
                break;
            }
        }
        
        // Calculate adjustments to map [lowValue, highValue] to [0, 255]
        const currentRange = highValue - lowValue;
        if (currentRange <= 0) {
            // Image is flat, just center it
            this.autoAdjustBrightness();
            return;
        }
        
        // Calculate brightness: shift so lowValue becomes ~32 (near black but not completely)
        const targetLow = 32;
        const brightnessAdjustment = Math.round(targetLow - lowValue);
        
        // Calculate contrast: stretch so range becomes wider
        const targetRange = 192; // From 32 to 224, good range
        const contrastFactor = targetRange / currentRange;
        
        // Convert contrast factor to slider value (-100 to 100)
        // contrastFactor of 1.0 = no change = slider value 0
        // contrastFactor > 1.0 = increase contrast = positive slider
        // contrastFactor < 1.0 = decrease contrast = negative slider
        let contrastAdjustment = Math.round((contrastFactor - 1.0) * 100);
        
        // Clamp values
        const clampedBrightness = Math.max(-100, Math.min(100, brightnessAdjustment));
        const clampedContrast = Math.max(-100, Math.min(100, contrastAdjustment));
        
        // Update sliders
        const brightnessSlider = document.getElementById('brightness');
        const contrastSlider = document.getElementById('contrast');
        
        brightnessSlider.value = clampedBrightness;
        contrastSlider.value = clampedContrast;
        
        document.getElementById('brightnessValue').textContent = clampedBrightness;
        document.getElementById('contrastValue').textContent = clampedContrast;
        
        this.updateLivePreview();
    }

    autoAdjustThreshold() {
        const stats = this.getImageStatistics();
        if (!stats) {
            alert('Please upload an image first');
            return;
        }
        
        // Use Otsu's method approximation for automatic threshold
        // Find the threshold that maximizes the between-class variance
        let bestThreshold = 128;
        let maxVariance = 0;
        
        const totalPixels = stats.count;
        
        for (let t = 0; t < 256; t++) {
            let weightBackground = 0;
            let weightForeground = 0;
            let sumBackground = 0;
            let sumForeground = 0;
            
            // Calculate weights and sums for background and foreground
            for (let i = 0; i <= t; i++) {
                weightBackground += stats.histogram[i];
                sumBackground += i * stats.histogram[i];
            }
            
            for (let i = t + 1; i < 256; i++) {
                weightForeground += stats.histogram[i];
                sumForeground += i * stats.histogram[i];
            }
            
            // Avoid division by zero
            if (weightBackground === 0 || weightForeground === 0) continue;
            
            const meanBackground = sumBackground / weightBackground;
            const meanForeground = sumForeground / weightForeground;
            
            // Calculate between-class variance
            const betweenVariance = (weightBackground / totalPixels) * 
                                    (weightForeground / totalPixels) * 
                                    Math.pow(meanBackground - meanForeground, 2);
            
            if (betweenVariance > maxVariance) {
                maxVariance = betweenVariance;
                bestThreshold = t;
            }
        }
        
        // Update slider and display
        const thresholdSlider = document.getElementById('threshold');
        thresholdSlider.value = bestThreshold;
        document.getElementById('thresholdValue').textContent = bestThreshold;
        
        this.updateLivePreview();
    }

    autoAdjustAll() {
        // Apply auto levels first (brightness + contrast)
        this.autoAdjustLevels();
        
        // Then apply auto threshold with a small delay to let the previous adjustment settle
        setTimeout(() => {
            this.autoAdjustThreshold();
        }, 100);
    }
}

// Initialize the converter when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new ImageToHppConverter();
});
