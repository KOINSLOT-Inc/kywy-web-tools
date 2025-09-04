/*
 * KYWY Web Tools - Animation Generator
 * Copyright (c) 2025 KOINSLOT, Inc.
 * Licensed under the BSD 3-Clause License
 */

class AnimationGenerator {
    constructor() {
        this.frames = [];
        this.selectedFrameIndex = -1;
        this.targetWidth = 144;
        this.targetHeight = 168;
        this.isPlaying = false;
        this.currentPlayFrame = 0;
        this.playInterval = null;
        this.animationDirection = 1; // 1 for forward, -1 for reverse (boomerang mode)
        
        this.initializeElements();
        this.initializeEvents();
        this.updateUI();
    }
    
    initializeElements() {
        this.importZone = document.getElementById('importZone');
        this.fileInput = document.getElementById('fileInput');
        this.framesContainer = document.getElementById('framesContainer');
        this.previewCanvas = document.getElementById('previewCanvas');
        this.previewCtx = this.previewCanvas.getContext('2d');
        this.codeOutput = document.getElementById('codeOutput');
        
        // Disable smoothing for pixel art
        this.previewCtx.imageSmoothingEnabled = false;
        
        this.initializePreviewCanvas();
    }
    
    initializePreviewCanvas() {
        this.previewCanvas.width = this.targetWidth;
        this.previewCanvas.height = this.targetHeight;
        this.previewCanvas.style.width = '288px';
        this.previewCanvas.style.height = '336px';
    }
    
    initializeEvents() {
        // File import
        this.importZone.addEventListener('click', () => this.fileInput.click());
        this.importZone.addEventListener('dragover', (e) => this.handleDragOver(e));
        this.importZone.addEventListener('drop', (e) => this.handleDrop(e));
        this.fileInput.addEventListener('change', (e) => this.handleFileSelect(e));
        
        // Target size change
        document.getElementById('targetSize').addEventListener('change', (e) => {
            if (e.target.value === 'custom') {
                document.getElementById('customSizeInputs').style.display = 'flex';
            } else {
                document.getElementById('customSizeInputs').style.display = 'none';
                const [width, height] = e.target.value.split('x').map(n => parseInt(n));
                this.setTargetSize(width, height);
            }
        });
        
        // Custom size inputs
        document.getElementById('customWidth').addEventListener('change', () => this.updateCustomSize());
        document.getElementById('customHeight').addEventListener('change', () => this.updateCustomSize());
        
        // Processing controls
        this.initializeProcessingControls();
        
        // Frame controls
        document.getElementById('clearFramesBtn').addEventListener('click', () => this.clearFrames());
        document.getElementById('reverseFramesBtn').addEventListener('click', () => this.reverseFrames());
        document.getElementById('duplicateFrameBtn').addEventListener('click', () => this.duplicateFrame());
        document.getElementById('removeFrameBtn').addEventListener('click', () => this.removeFrame());
        
        // Frame management
        document.getElementById('moveUpBtn').addEventListener('click', () => this.moveFrameUp());
        document.getElementById('moveDownBtn').addEventListener('click', () => this.moveFrameDown());
        
        // Animation controls
        document.getElementById('playBtn').addEventListener('click', () => this.playAnimation());
        document.getElementById('stopBtn').addEventListener('click', () => this.stopAnimation());
        
        // Frame rate slider
        document.getElementById('frameRate').addEventListener('input', (e) => {
            document.getElementById('frameRateDisplay').textContent = e.target.value;
            document.getElementById('currentSpeed').textContent = e.target.value;
            if (this.isPlaying) {
                this.stopAnimation();
                this.playAnimation();
            }
        });
        
        // Export
        document.getElementById('exportBtn').addEventListener('click', () => this.exportAnimation());
        document.getElementById('previewCodeBtn').addEventListener('click', () => this.generateCode());
        document.getElementById('copyCodeBtn').addEventListener('click', () => this.copyCode());
        
        // Auto adjustments
        document.getElementById('autoAdjustBtn').addEventListener('click', () => this.autoAdjustAll());
        document.getElementById('autoBrightnessBtn').addEventListener('click', () => this.autoBrightness());
        document.getElementById('autoContrastBtn').addEventListener('click', () => this.autoContrast());
        document.getElementById('autoThresholdBtn').addEventListener('click', () => this.autoThreshold());
    }
    
    initializeProcessingControls() {
        // Brightness
        const brightnessSlider = document.getElementById('brightness');
        brightnessSlider.addEventListener('input', (e) => {
            document.getElementById('brightnessDisplay').textContent = e.target.value;
            this.processAllFrames();
        });
        
        // Contrast
        const contrastSlider = document.getElementById('contrast');
        contrastSlider.addEventListener('input', (e) => {
            document.getElementById('contrastDisplay').textContent = e.target.value;
            this.processAllFrames();
        });
        
        // Threshold
        const thresholdSlider = document.getElementById('threshold');
        thresholdSlider.addEventListener('input', (e) => {
            document.getElementById('thresholdDisplay').textContent = e.target.value;
            this.processAllFrames();
        });
        
        // Other controls
        document.getElementById('dithering').addEventListener('change', () => this.processAllFrames());
        document.getElementById('invert').addEventListener('change', () => this.processAllFrames());
        document.getElementById('edgeDetection').addEventListener('change', () => this.processAllFrames());
    }
    
    handleDragOver(e) {
        e.preventDefault();
        this.importZone.classList.add('dragover');
    }
    
    handleDrop(e) {
        e.preventDefault();
        this.importZone.classList.remove('dragover');
        
        const files = Array.from(e.dataTransfer.files).filter(file => 
            file.type.startsWith('image/')
        );
        
        if (files.length > 0) {
            this.processFiles(files);
        }
    }
    
    handleFileSelect(e) {
        const files = Array.from(e.target.files);
        if (files.length > 0) {
            this.processFiles(files);
        }
        e.target.value = ''; // Reset input
    }
    
    async processFiles(files) {
        const sortedFiles = files.sort((a, b) => a.name.localeCompare(b.name));
        
        for (const file of sortedFiles) {
            await this.addFrameFromFile(file);
        }
        
        this.updateUI();
        this.processAllFrames();
    }
    
    addFrameFromFile(file) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                const frame = {
                    originalImage: img,
                    processedCanvas: this.createProcessedCanvas(img),
                    name: file.name,
                    size: file.size
                };
                
                this.frames.push(frame);
                resolve();
            };
            img.src = URL.createObjectURL(file);
        });
    }
    
    createProcessedCanvas(img) {
        const canvas = document.createElement('canvas');
        canvas.width = this.targetWidth;
        canvas.height = this.targetHeight;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        
        // Fill with white background
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        // Calculate scaling and centering
        if (document.getElementById('autoResize').checked) {
            const maintainAspect = document.getElementById('maintainAspect').checked;
            
            if (maintainAspect) {
                const scale = Math.min(this.targetWidth / img.width, this.targetHeight / img.height);
                const scaledWidth = img.width * scale;
                const scaledHeight = img.height * scale;
                const x = (this.targetWidth - scaledWidth) / 2;
                const y = (this.targetHeight - scaledHeight) / 2;
                
                ctx.drawImage(img, x, y, scaledWidth, scaledHeight);
            } else {
                ctx.drawImage(img, 0, 0, this.targetWidth, this.targetHeight);
            }
        } else {
            // Center the image without scaling
            const x = (this.targetWidth - img.width) / 2;
            const y = (this.targetHeight - img.height) / 2;
            ctx.drawImage(img, x, y);
        }
        
        return canvas;
    }
    
    setTargetSize(width, height) {
        this.targetWidth = width;
        this.targetHeight = height;
        this.initializePreviewCanvas();
        this.processAllFrames();
        this.updateStats();
    }
    
    updateCustomSize() {
        const width = parseInt(document.getElementById('customWidth').value);
        const height = parseInt(document.getElementById('customHeight').value);
        if (width > 0 && height > 0) {
            this.setTargetSize(width, height);
        }
    }
    
    processAllFrames() {
        this.frames.forEach(frame => {
            this.processFrame(frame);
        });
        this.updateFramesList();
        this.generateCode();
        this.updateStats();
    }
    
    processFrame(frame) {
        const canvas = document.createElement('canvas');
        canvas.width = this.targetWidth;
        canvas.height = this.targetHeight;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        
        // Start with the resized image
        ctx.drawImage(frame.processedCanvas, 0, 0);
        let imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        
        // Apply image processing (similar to the converter)
        const brightness = parseInt(document.getElementById('brightness').value);
        const contrast = parseInt(document.getElementById('contrast').value);
        const threshold = parseInt(document.getElementById('threshold').value);
        const invert = document.getElementById('invert').checked;
        const edgeDetection = document.getElementById('edgeDetection').checked;
        const dithering = document.getElementById('dithering').value;
        
        // Apply brightness and contrast
        if (brightness !== 0 || contrast !== 0) {
            imageData = this.adjustBrightnessContrast(imageData, brightness, contrast);
        }
        
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
        
        // Store processed data
        ctx.putImageData(imageData, 0, 0);
        frame.processedCanvas = canvas;
        frame.binaryData = binaryData;
    }
    
    // Image processing methods (similar to converter.js)
    adjustBrightnessContrast(imageData, brightness, contrast) {
        const data = imageData.data;
        const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
        
        for (let i = 0; i < data.length; i += 4) {
            // Apply brightness
            data[i] = Math.max(0, Math.min(255, data[i] + brightness));
            data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + brightness));
            data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + brightness));
            
            // Apply contrast
            data[i] = Math.max(0, Math.min(255, factor * (data[i] - 128) + 128));
            data[i + 1] = Math.max(0, Math.min(255, factor * (data[i + 1] - 128) + 128));
            data[i + 2] = Math.max(0, Math.min(255, factor * (data[i + 2] - 128) + 128));
        }
        
        return imageData;
    }
    
    convertToGrayscale(imageData) {
        const data = imageData.data;
        
        for (let i = 0; i < data.length; i += 4) {
            const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
            data[i] = gray;
            data[i + 1] = gray;
            data[i + 2] = gray;
        }
        
        return imageData;
    }
    
    applyEdgeDetection(imageData) {
        // Simple Sobel edge detection
        const { width, height, data } = imageData;
        const output = new Uint8ClampedArray(data.length);
        
        const sobelX = [[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]];
        const sobelY = [[-1, -2, -1], [0, 0, 0], [1, 2, 1]];
        
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                let gx = 0, gy = 0;
                
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const idx = ((y + dy) * width + (x + dx)) * 4;
                        const intensity = data[idx]; // Use red channel (grayscale)
                        gx += intensity * sobelX[dy + 1][dx + 1];
                        gy += intensity * sobelY[dy + 1][dx + 1];
                    }
                }
                
                const magnitude = Math.sqrt(gx * gx + gy * gy);
                const idx = (y * width + x) * 4;
                
                output[idx] = magnitude;
                output[idx + 1] = magnitude;
                output[idx + 2] = magnitude;
                output[idx + 3] = 255;
            }
        }
        
        return new ImageData(output, width, height);
    }
    
    applyDithering(imageData, method, threshold) {
        const { width, height } = imageData;
        
        switch (method) {
            case 'floyd-steinberg':
                return this.floydSteinbergDithering(imageData, threshold);
            case 'atkinson':
                return this.atkinsonDithering(imageData, threshold);
            case 'ordered':
                return this.orderedDithering(imageData, threshold);
            default:
                return imageData;
        }
    }
    
    floydSteinbergDithering(imageData, threshold) {
        const { width, height, data } = imageData;
        const newData = new Uint8ClampedArray(data);
        
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                const oldPixel = newData[idx];
                const newPixel = oldPixel > threshold ? 255 : 0;
                const error = oldPixel - newPixel;
                
                newData[idx] = newData[idx + 1] = newData[idx + 2] = newPixel;
                
                // Distribute error
                if (x + 1 < width) {
                    const rightIdx = (y * width + (x + 1)) * 4;
                    newData[rightIdx] += error * 7 / 16;
                }
                if (y + 1 < height && x - 1 >= 0) {
                    const bottomLeftIdx = ((y + 1) * width + (x - 1)) * 4;
                    newData[bottomLeftIdx] += error * 3 / 16;
                }
                if (y + 1 < height) {
                    const bottomIdx = ((y + 1) * width + x) * 4;
                    newData[bottomIdx] += error * 5 / 16;
                }
                if (y + 1 < height && x + 1 < width) {
                    const bottomRightIdx = ((y + 1) * width + (x + 1)) * 4;
                    newData[bottomRightIdx] += error * 1 / 16;
                }
            }
        }
        
        return new ImageData(newData, width, height);
    }
    
    atkinsonDithering(imageData, threshold) {
        // Simplified Atkinson dithering
        const { width, height, data } = imageData;
        const newData = new Uint8ClampedArray(data);
        
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                const oldPixel = newData[idx];
                const newPixel = oldPixel > threshold ? 255 : 0;
                const error = oldPixel - newPixel;
                
                newData[idx] = newData[idx + 1] = newData[idx + 2] = newPixel;
                
                // Distribute error (simplified pattern)
                const errorFraction = error / 8;
                if (x + 1 < width) {
                    newData[(y * width + (x + 1)) * 4] += errorFraction;
                }
                if (y + 1 < height) {
                    newData[((y + 1) * width + x) * 4] += errorFraction;
                }
            }
        }
        
        return new ImageData(newData, width, height);
    }
    
    orderedDithering(imageData, threshold) {
        // Simplified ordered dithering
        const { width, height, data } = imageData;
        const newData = new Uint8ClampedArray(data);
        
        const matrix = [
            [0, 8, 2, 10],
            [12, 4, 14, 6],
            [3, 11, 1, 9],
            [15, 7, 13, 5]
        ];
        
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                const pixel = data[idx];
                const matrixValue = matrix[y % 4][x % 4];
                const adjustedThreshold = threshold + (matrixValue - 7.5) * 16;
                const newPixel = pixel > adjustedThreshold ? 255 : 0;
                
                newData[idx] = newData[idx + 1] = newData[idx + 2] = newPixel;
            }
        }
        
        return new ImageData(newData, width, height);
    }
    
    convertToBinary(imageData, threshold, invert) {
        const { width, height, data } = imageData;
        const binaryData = new Uint8Array(Math.ceil((width * height) / 8));
        
        for (let i = 0; i < width * height; i++) {
            const pixelValue = data[i * 4]; // Red channel
            let isBlack = pixelValue < threshold;
            
            if (invert) isBlack = !isBlack;
            
            if (isBlack) {
                const byteIndex = Math.floor(i / 8);
                const bitIndex = 7 - (i % 8);
                binaryData[byteIndex] |= (1 << bitIndex);
            }
        }
        
        return binaryData;
    }
    
    updateFramesList() {
        if (this.frames.length === 0) {
            this.framesContainer.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">🎬</div>
                    <p>No frames yet</p>
                    <p class="empty-hint">Import images to get started</p>
                </div>
            `;
            return;
        }
        
        const framesGrid = document.createElement('div');
        framesGrid.className = 'frames-grid';
        
        this.frames.forEach((frame, index) => {
            const frameItem = document.createElement('div');
            frameItem.className = `frame-item ${index === this.selectedFrameIndex ? 'selected' : ''}`;
            frameItem.addEventListener('click', () => this.selectFrame(index));
            
            const preview = document.createElement('canvas');
            preview.className = 'frame-preview';
            preview.width = 80;
            preview.height = 80;
            const ctx = preview.getContext('2d');
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(frame.processedCanvas, 0, 0, 80, 80);
            
            const info = document.createElement('div');
            info.className = 'frame-info';
            info.innerHTML = `
                <div>Frame ${index + 1}</div>
                <div>${frame.name.substring(0, 15)}${frame.name.length > 15 ? '...' : ''}</div>
            `;
            
            frameItem.appendChild(preview);
            frameItem.appendChild(info);
            framesGrid.appendChild(frameItem);
        });
        
        this.framesContainer.innerHTML = '';
        this.framesContainer.appendChild(framesGrid);
    }
    
    selectFrame(index) {
        this.selectedFrameIndex = index;
        this.updateFramesList();
        this.updateSelectedFrameInfo();
        this.updateUI();
        
        // Show frame in preview
        if (this.frames[index]) {
            this.previewCtx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
            this.previewCtx.drawImage(this.frames[index].processedCanvas, 0, 0);
        }
    }
    
    updateSelectedFrameInfo() {
        const info = document.getElementById('selectedFrameInfo');
        
        if (this.selectedFrameIndex >= 0 && this.frames[this.selectedFrameIndex]) {
            const frame = this.frames[this.selectedFrameIndex];
            info.innerHTML = `
                <p><strong>Frame ${this.selectedFrameIndex + 1}</strong></p>
                <p>Name: ${frame.name}</p>
                <p>Size: ${(frame.size / 1024).toFixed(1)} KB</p>
                <p>Dimensions: ${frame.originalImage.width}×${frame.originalImage.height}</p>
            `;
        } else {
            info.innerHTML = '<p>No frame selected</p>';
        }
    }
    
    updateUI() {
        document.getElementById('frameCount').textContent = this.frames.length;
        
        const hasFrames = this.frames.length > 0;
        const hasSelection = this.selectedFrameIndex >= 0;
        
        document.getElementById('duplicateFrameBtn').disabled = !hasSelection;
        document.getElementById('removeFrameBtn').disabled = !hasSelection;
        document.getElementById('moveUpBtn').disabled = !hasSelection || this.selectedFrameIndex === 0;
        document.getElementById('moveDownBtn').disabled = !hasSelection || this.selectedFrameIndex === this.frames.length - 1;
        document.getElementById('cropToContentBtn').disabled = !hasSelection;
        
        document.getElementById('playBtn').disabled = this.frames.length < 2;
        document.getElementById('stopBtn').disabled = !this.isPlaying;
        document.getElementById('exportBtn').disabled = !hasFrames;
        document.getElementById('previewCodeBtn').disabled = !hasFrames;
        document.getElementById('copyCodeBtn').disabled = !hasFrames;
        
        this.updateStats();
    }
    
    updateStats() {
        const frameCount = this.frames.length;
        const fps = parseInt(document.getElementById('frameRate').value);
        const duration = frameCount > 0 ? (frameCount / fps).toFixed(1) : '0.0';
        const bytesPerFrame = Math.ceil((this.targetWidth * this.targetHeight) / 8);
        const totalBytes = frameCount * bytesPerFrame;
        
        document.getElementById('statFrames').textContent = frameCount;
        document.getElementById('statDuration').textContent = duration + 's';
        document.getElementById('statMemory').textContent = this.formatBytes(totalBytes);
        document.getElementById('statResolution').textContent = `${this.targetWidth}×${this.targetHeight}`;
    }
    
    formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }
    
    // Animation playback
    playAnimation() {
        if (this.frames.length < 2) return;
        
        this.isPlaying = true;
        this.currentPlayFrame = 0;
        this.animationDirection = 1;
        const fps = parseInt(document.getElementById('frameRate').value);
        
        this.playInterval = setInterval(() => {
            this.previewCtx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
            this.previewCtx.drawImage(this.frames[this.currentPlayFrame].processedCanvas, 0, 0);
            
            document.getElementById('playbackFrame').textContent = 
                `Frame: ${this.currentPlayFrame + 1}/${this.frames.length}`;
            
            const loopMode = document.getElementById('loopMode').value;
            if (loopMode === 'PERIODIC') {
                this.currentPlayFrame = (this.currentPlayFrame + 1) % this.frames.length;
            } else if (loopMode === 'BOOMERANG') {
                // Boomerang mode: go forward then backward
                this.currentPlayFrame += this.animationDirection;
                
                if (this.currentPlayFrame >= this.frames.length - 1) {
                    this.animationDirection = -1;
                    this.currentPlayFrame = this.frames.length - 1;
                } else if (this.currentPlayFrame <= 0) {
                    this.animationDirection = 1;
                    this.currentPlayFrame = 0;
                }
            }
        }, 1000 / fps);
        
        this.updateUI();
    }
    
    stopAnimation() {
        this.isPlaying = false;
        if (this.playInterval) {
            clearInterval(this.playInterval);
            this.playInterval = null;
        }
        this.updateUI();
    }
    
    // Frame operations
    clearFrames() {
        if (confirm('Clear all frames? This action cannot be undone.')) {
            this.frames = [];
            this.selectedFrameIndex = -1;
            this.stopAnimation();
            this.updateFramesList();
            this.updateUI();
            this.generateCode();
        }
    }
    
    reverseFrames() {
        this.frames.reverse();
        if (this.selectedFrameIndex >= 0) {
            this.selectedFrameIndex = this.frames.length - 1 - this.selectedFrameIndex;
        }
        this.updateFramesList();
        this.updateUI();
        this.generateCode();
    }
    
    duplicateFrame() {
        if (this.selectedFrameIndex >= 0) {
            const frame = this.frames[this.selectedFrameIndex];
            const newFrame = {
                originalImage: frame.originalImage,
                processedCanvas: frame.processedCanvas.cloneNode(),
                binaryData: new Uint8Array(frame.binaryData),
                name: frame.name + ' (copy)',
                size: frame.size
            };
            
            this.frames.splice(this.selectedFrameIndex + 1, 0, newFrame);
            this.selectedFrameIndex++;
            this.updateFramesList();
            this.updateUI();
            this.generateCode();
        }
    }
    
    removeFrame() {
        if (this.selectedFrameIndex >= 0) {
            this.frames.splice(this.selectedFrameIndex, 1);
            if (this.selectedFrameIndex >= this.frames.length) {
                this.selectedFrameIndex = this.frames.length - 1;
            }
            this.updateFramesList();
            this.updateSelectedFrameInfo();
            this.updateUI();
            this.generateCode();
        }
    }
    
    moveFrameUp() {
        if (this.selectedFrameIndex > 0) {
            const frame = this.frames[this.selectedFrameIndex];
            this.frames[this.selectedFrameIndex] = this.frames[this.selectedFrameIndex - 1];
            this.frames[this.selectedFrameIndex - 1] = frame;
            this.selectedFrameIndex--;
            this.updateFramesList();
            this.updateUI();
            this.generateCode();
        }
    }
    
    moveFrameDown() {
        if (this.selectedFrameIndex < this.frames.length - 1) {
            const frame = this.frames[this.selectedFrameIndex];
            this.frames[this.selectedFrameIndex] = this.frames[this.selectedFrameIndex + 1];
            this.frames[this.selectedFrameIndex + 1] = frame;
            this.selectedFrameIndex++;
            this.updateFramesList();
            this.updateUI();
            this.generateCode();
        }
    }
    
    // Auto adjustments - real implementations
    autoAdjustAll() {
        if (this.frames.length === 0) {
            alert('Please import some images first.');
            return;
        }
        
        this.autoBrightness();
        this.autoContrast();
        this.autoThreshold();
    }
    
    autoBrightness() {
        if (this.frames.length === 0) return;
        
        // Calculate optimal brightness from first frame
        const stats = this.getImageStatistics(this.frames[0].processedCanvas);
        if (!stats) return;
        
        const targetMean = 128;
        const adjustment = targetMean - stats.mean;
        const clampedAdjustment = Math.max(-100, Math.min(100, adjustment));
        
        document.getElementById('brightness').value = clampedAdjustment;
        document.getElementById('brightnessDisplay').textContent = clampedAdjustment;
        this.processAllFrames();
    }
    
    autoContrast() {
        if (this.frames.length === 0) return;
        
        // Calculate optimal contrast from first frame
        const stats = this.getImageStatistics(this.frames[0].processedCanvas);
        if (!stats) return;
        
        const targetRange = 200; // Target range for good contrast
        const currentRange = stats.max - stats.min;
        
        let adjustment = 0;
        if (currentRange < targetRange) {
            adjustment = Math.min(100, (targetRange - currentRange) / 2);
        }
        
        document.getElementById('contrast').value = adjustment;
        document.getElementById('contrastDisplay').textContent = adjustment;
        this.processAllFrames();
    }
    
    autoThreshold() {
        if (this.frames.length === 0) return;
        
        // Use Otsu's method for optimal threshold
        const threshold = this.calculateOtsuThreshold(this.frames[0].processedCanvas);
        
        document.getElementById('threshold').value = threshold;
        document.getElementById('thresholdDisplay').textContent = threshold;
        this.processAllFrames();
    }
    
    getImageStatistics(canvas) {
        const ctx = canvas.getContext('2d');
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        
        let min = 255, max = 0, sum = 0, count = 0;
        
        for (let i = 0; i < data.length; i += 4) {
            const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
            min = Math.min(min, gray);
            max = Math.max(max, gray);
            sum += gray;
            count++;
        }
        
        return {
            min: min,
            max: max,
            mean: sum / count,
            range: max - min
        };
    }
    
    calculateOtsuThreshold(canvas) {
        const ctx = canvas.getContext('2d');
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        
        // Build histogram
        const histogram = new Array(256).fill(0);
        const totalPixels = data.length / 4;
        
        for (let i = 0; i < data.length; i += 4) {
            const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
            histogram[gray]++;
        }
        
        // Calculate optimal threshold using Otsu's method
        let sum = 0;
        for (let i = 0; i < 256; i++) {
            sum += i * histogram[i];
        }
        
        let sumB = 0;
        let wB = 0;
        let maximum = 0.0;
        let threshold = 0;
        
        for (let i = 0; i < 256; i++) {
            wB += histogram[i];
            if (wB === 0) continue;
            
            const wF = totalPixels - wB;
            if (wF === 0) break;
            
            sumB += i * histogram[i];
            const mB = sumB / wB;
            const mF = (sum - sumB) / wF;
            
            const between = wB * wF * (mB - mF) * (mB - mF);
            
            if (between > maximum) {
                maximum = between;
                threshold = i;
            }
        }
        
        return threshold;
    }
    
    // Code generation
    generateCode() {
        if (this.frames.length === 0) {
            this.codeOutput.value = '';
            return;
        }
        
        const format = document.getElementById('exportFormat').value;
        const baseName = document.getElementById('exportName').value || 'animation';
        
        let code = '';
        
        switch (format) {
            case 'sprite-hpp':
                code = this.generateSpriteHPP(baseName);
                break;
            case 'spritesheet-hpp':
                code = this.generateSpriteSheetHPP(baseName);
                break;
            case 'individual-hpp':
                code = this.generateIndividualHPPs(baseName);
                break;
        }
        
        this.codeOutput.value = code;
    }
    
    generateSpriteHPP(baseName) {
        const bytesPerFrame = Math.ceil((this.targetWidth * this.targetHeight) / 8);
        
        let code = `// Generated animation: ${baseName}\n`;
        code += `// ${this.frames.length} frames, ${this.targetWidth}×${this.targetHeight} pixels\n`;
        code += `// Created with Kywy Animation Generator\n\n`;
        
        // Generate individual frame data
        this.frames.forEach((frame, index) => {
            code += `const uint8_t ${baseName}_frame_${index}[${bytesPerFrame}] PROGMEM = {\n`;
            
            const bytes = Array.from(frame.binaryData).map(b => 
                `0x${b.toString(16).padStart(2, '0').toUpperCase()}`
            );
            
            for (let i = 0; i < bytes.length; i += 12) {
                code += '    ' + bytes.slice(i, i + 12).join(', ');
                if (i + 12 < bytes.length) code += ',';
                code += '\n';
            }
            
            code += `};\n\n`;
        });
        
        // Generate frame pointer array
        code += `const uint8_t* ${baseName}_frames[${this.frames.length}] = {\n`;
        for (let i = 0; i < this.frames.length; i++) {
            code += `    ${baseName}_frame_${i}`;
            if (i < this.frames.length - 1) code += ',';
            code += '\n';
        }
        code += `};\n\n`;
        
        // Usage example
        const fps = document.getElementById('frameRate').value;
        const loopMode = document.getElementById('loopMode').value;
        
        code += `// Usage example:\n`;
        code += `Sprite ${baseName}_sprite(${baseName}_frames, ${this.frames.length}, ${this.targetWidth}, ${this.targetHeight});\n`;
        code += `${baseName}_sprite.setPosition(x, y);\n\n`;
        code += `// In your game loop:\n`;
        code += `${baseName}_sprite.advanceFrame(0, ${this.frames.length - 1}, ${Math.ceil(60 / fps)}, FrameLoopMode::${loopMode});\n`;
        code += `engine.display.drawSprite(&${baseName}_sprite);\n`;
        
        return code;
    }
    
    generateSpriteSheetHPP(baseName) {
        // Would generate SpriteSheet format
        return this.generateSpriteHPP(baseName) + '\n\n// SpriteSheet format coming soon!';
    }
    
    generateIndividualHPPs(baseName) {
        // Would generate separate files
        return this.generateSpriteHPP(baseName) + '\n\n// Individual HPP export coming soon!';
    }
    
    // Export and file operations
    exportAnimation() {
        const format = document.getElementById('exportFormat').value;
        
        if (format === 'gif') {
            alert('GIF export is not yet implemented.');
            return;
        }
        
        const code = this.codeOutput.value;
        const baseName = document.getElementById('exportName').value || 'animation';
        
        const blob = new Blob([code], {type: 'text/plain'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${baseName}.hpp`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
    
    copyCode() {
        this.codeOutput.select();
        document.execCommand('copy');
        
        const btn = document.getElementById('copyCodeBtn');
        const originalText = btn.textContent;
        btn.textContent = '✓ Copied!';
        setTimeout(() => {
            btn.textContent = originalText;
        }, 2000);
    }
}

// Initialize when page loads
document.addEventListener('DOMContentLoaded', () => {
    new AnimationGenerator();
});
