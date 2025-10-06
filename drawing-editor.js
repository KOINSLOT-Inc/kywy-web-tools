/*
 * KYWY Web Tools - Drawing Editor
 * Copyright (c) 2025 KOINSLOT, Inc.
 * Licensed under the BSD 3-Clause License
 */

// Simplified Undo/Redo System using Canvas Snapshots
class CanvasStateSnapshot {
    constructor(editor, frameIndex = null) {
        this.editor = editor;
        this.frameIndex = frameIndex !== null ? frameIndex : editor.currentFrameIndex;
        this.timestamp = Date.now();
        this.layersEnabled = editor.layersEnabled;
        
        // Always capture the composited frame state for cross-mode compatibility
        const frameCanvas = editor.frames[this.frameIndex];
        this.frameSnapshot = frameCanvas.getContext('2d', { willReadFrequently: true })
            .getImageData(0, 0, editor.canvasWidth, editor.canvasHeight);
        
        // Additionally capture layer data if layers are enabled
        if (this.layersEnabled) {
            const frameData = editor.frameLayers && editor.frameLayers[this.frameIndex];
            if (frameData) {
                this.layerIndex = frameData.currentLayerIndex;
                // Store snapshot of the active layer
                const layerCanvas = frameData.layers[this.layerIndex].canvas;
                this.layerSnapshot = layerCanvas.getContext('2d', { willReadFrequently: true })
                    .getImageData(0, 0, editor.canvasWidth, editor.canvasHeight);
            }
        }
    }
    
    restore() {
        // If snapshot and current state match layer mode, prefer layer restoration
        if (this.layersEnabled && this.editor.layersEnabled) {
            // Restore layer snapshot
            const frameData = this.editor.frameLayers && this.editor.frameLayers[this.frameIndex];
            if (frameData && frameData.layers[this.layerIndex]) {
                const ctx = frameData.layers[this.layerIndex].canvas.getContext('2d', { willReadFrequently: true });
                ctx.putImageData(this.layerSnapshot, 0, 0);
                // Composite layers to frame
                this.editor.compositeLayersToFrame(this.frameIndex);
                return true;
            }
            // If layer doesn't exist, fall through to frame restoration
        }
        
        // Restore frame snapshot (works for both modes)
        const frameCanvas = this.editor.frames[this.frameIndex];
        const ctx = frameCanvas.getContext('2d', { willReadFrequently: true });
        ctx.putImageData(this.frameSnapshot, 0, 0);
        
        // If we're in layer mode but restoring a non-layer snapshot,
        // copy the frame to the active layer
        if (this.editor.layersEnabled && !this.layersEnabled) {
            const frameData = this.editor.frameLayers && this.editor.frameLayers[this.frameIndex];
            if (frameData) {
                const activeLayer = frameData.layers[frameData.currentLayerIndex];
                if (activeLayer) {
                    const layerCtx = activeLayer.canvas.getContext('2d', { willReadFrequently: true });
                    // Clear the layer first
                    layerCtx.clearRect(0, 0, this.editor.canvasWidth, this.editor.canvasHeight);
                    // Copy frame content to active layer
                    layerCtx.drawImage(frameCanvas, 0, 0);
                }
            }
        }
        
        return true;
    }
}

// Layer Commands
class AddLayerCommand {
    constructor(editor, frameIndex, layerData) {
        this.editor = editor;
        this.frameIndex = frameIndex;
        this.layerData = layerData; // The layer that was added
    }
    
    execute() {
        const frameData = this.editor.frameLayers && this.editor.frameLayers[this.frameIndex];
        if (!frameData) return;
        
        frameData.layers.push(this.layerData);
        frameData.currentLayerIndex = frameData.layers.length - 1;
        this.editor.updateLayersUI();
        this.editor.redrawCanvas();
    }
    
    undo() {
        const frameData = this.editor.frameLayers && this.editor.frameLayers[this.frameIndex];
        if (!frameData) return;
        
        frameData.layers.pop();
        frameData.currentLayerIndex = Math.min(frameData.currentLayerIndex, frameData.layers.length - 1);
        this.editor.updateLayersUI();
        this.editor.compositeLayersToFrame(this.frameIndex);
        this.editor.redrawCanvas();
    }
}

class DeleteLayerCommand {
    constructor(editor, frameIndex, layerIndex, layerData) {
        this.editor = editor;
        this.frameIndex = frameIndex;
        this.layerIndex = layerIndex;
        this.layerData = layerData; // Store the deleted layer
    }
    
    execute() {
        const frameData = this.editor.frameLayers && this.editor.frameLayers[this.frameIndex];
        if (!frameData) return;
        
        // Exit solo mode if deleting the solo layer
        if (this.editor.soloLayerIndex === this.layerIndex) {
            this.editor.soloLayerIndex = null;
        } else if (this.editor.soloLayerIndex !== null && this.editor.soloLayerIndex > this.layerIndex) {
            // Adjust solo index if deleting a layer below the solo layer
            this.editor.soloLayerIndex--;
        }
        
        frameData.layers.splice(this.layerIndex, 1);
        frameData.currentLayerIndex = Math.min(frameData.currentLayerIndex, frameData.layers.length - 1);
        this.editor.updateLayersUI();
        this.editor.compositeLayersToFrame();
        this.editor.generateCode();
        this.editor.redrawCanvas();
    }
    
    undo() {
        const frameData = this.editor.frameLayers && this.editor.frameLayers[this.frameIndex];
        if (!frameData) return;
        
        // Adjust solo index if restoring a layer
        if (this.editor.soloLayerIndex !== null && this.editor.soloLayerIndex >= this.layerIndex) {
            this.editor.soloLayerIndex++;
        }
        
        frameData.layers.splice(this.layerIndex, 0, this.layerData);
        frameData.currentLayerIndex = this.layerIndex;
        this.editor.updateLayersUI();
        this.editor.compositeLayersToFrame(this.frameIndex);
        this.editor.generateCode();
        this.editor.redrawCanvas();
    }
}

class MergeLayerCommand {
    constructor(editor, frameIndex, layerIndex, topLayerData, bottomLayerSnapshot) {
        this.editor = editor;
        this.frameIndex = frameIndex;
        this.layerIndex = layerIndex; // Index of the layer that was merged down
        this.topLayerData = topLayerData; // The layer that was merged (now deleted)
        this.bottomLayerSnapshot = bottomLayerSnapshot; // Snapshot of bottom layer before merge
    }
    
    execute() {
        const frameData = this.editor.frameLayers && this.editor.frameLayers[this.frameIndex];
        if (!frameData) return;
        
        const belowLayer = frameData.layers[this.layerIndex - 1];
        const topLayer = frameData.layers[this.layerIndex];
        const ctx = belowLayer.canvas.getContext('2d', { willReadFrequently: true });
        
        // Merge the top layer into the bottom layer with proper transparency
        if (topLayer.transparencyMode === 'white') {
            // For white transparency, we need to composite properly
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = belowLayer.canvas.width;
            tempCanvas.height = belowLayer.canvas.height;
            const tempCtx = tempCanvas.getContext('2d');
            
            // First draw the bottom layer
            tempCtx.drawImage(belowLayer.canvas, 0, 0);
            
            // Then composite the top layer with white as transparent
            const topImageData = topLayer.canvas.getContext('2d').getImageData(0, 0, topLayer.canvas.width, topLayer.canvas.height);
            const bottomImageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
            
            for (let i = 0; i < topImageData.data.length; i += 4) {
                const r = topImageData.data[i];
                const g = topImageData.data[i + 1];
                const b = topImageData.data[i + 2];
                
                // Check if pixel is white (transparent)
                if (r === 255 && g === 255 && b === 255) {
                    // Keep bottom layer pixel
                    continue;
                } else {
                    // Use top layer pixel
                    bottomImageData.data[i] = r;
                    bottomImageData.data[i + 1] = g;
                    bottomImageData.data[i + 2] = b;
                }
            }
            
            ctx.putImageData(bottomImageData, 0, 0);
        } else {
            // For black transparency or normal compositing
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = belowLayer.canvas.width;
            tempCanvas.height = belowLayer.canvas.height;
            const tempCtx = tempCanvas.getContext('2d');
            
            // First draw the bottom layer
            tempCtx.drawImage(belowLayer.canvas, 0, 0);
            
            if (topLayer.transparencyMode === 'black') {
                // Composite with black as transparent
                const topImageData = topLayer.canvas.getContext('2d').getImageData(0, 0, topLayer.canvas.width, topLayer.canvas.height);
                const bottomImageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
                
                for (let i = 0; i < topImageData.data.length; i += 4) {
                    const r = topImageData.data[i];
                    const g = topImageData.data[i + 1];
                    const b = topImageData.data[i + 2];
                    
                    // Check if pixel is black (transparent)
                    if (r === 0 && g === 0 && b === 0) {
                        // Keep bottom layer pixel
                        continue;
                    } else {
                        // Use top layer pixel
                        bottomImageData.data[i] = r;
                        bottomImageData.data[i + 1] = g;
                        bottomImageData.data[i + 2] = b;
                    }
                }
                
                ctx.putImageData(bottomImageData, 0, 0);
            } else {
                // Normal compositing (no transparency)
                tempCtx.drawImage(topLayer.canvas, 0, 0);
                ctx.drawImage(tempCanvas, 0, 0);
            }
        }
        
        // Remove the top layer
        frameData.layers.splice(this.layerIndex, 1);
        frameData.currentLayerIndex = this.layerIndex - 1;
        this.editor.updateLayersUI();
        this.editor.compositeLayersToFrame();
        this.editor.redrawCanvas();
    }
    
    undo() {
        const frameData = this.editor.frameLayers && this.editor.frameLayers[this.frameIndex];
        if (!frameData) return;
        
        // Restore bottom layer
        const belowLayer = frameData.layers[this.layerIndex - 1];
        const ctx = belowLayer.canvas.getContext('2d', { willReadFrequently: true });
        ctx.putImageData(this.bottomLayerSnapshot, 0, 0);
        
        // Re-insert top layer
        frameData.layers.splice(this.layerIndex, 0, this.topLayerData);
        frameData.currentLayerIndex = this.layerIndex;
        this.editor.updateLayersUI();
        this.editor.compositeLayersToFrame(this.frameIndex);
        this.editor.redrawCanvas();
    }
}

// Frame Commands
class AddFrameCommand {
    constructor(editor, frameIndex, frameCanvas, frameLayerData = null) {
        this.editor = editor;
        this.frameIndex = frameIndex; // Index where frame was inserted
        this.frameCanvas = frameCanvas; // The frame canvas that was added
        this.frameLayerData = frameLayerData; // Layer data if layers were enabled
    }
    
    execute() {
        this.editor.frames.splice(this.frameIndex, 0, this.frameCanvas);
        
        if (this.frameLayerData) {
            if (!this.editor.frameLayers) {
                this.editor.frameLayers = {};
            }
            
            // Shift all frame layers at or after this index up by one
            for (let i = this.editor.frames.length - 1; i > this.frameIndex; i--) {
                if (this.editor.frameLayers[i - 1]) {
                    this.editor.frameLayers[i] = this.editor.frameLayers[i - 1];
                }
            }
            
            // Insert the new frame layer data
            this.editor.frameLayers[this.frameIndex] = this.frameLayerData;
        }
        
        this.editor.currentFrameIndex = this.frameIndex;
        if (this.editor.layersEnabled) {
            this.editor.updateLayersUI();
        }
        this.editor.updateUI();
        this.editor.redrawCanvas();
        this.editor.generateThumbnail(this.frameIndex);
        this.editor.generateCode();
    }
    
    undo() {
        this.editor.frames.splice(this.frameIndex, 1);
        
        if (this.frameLayerData && this.editor.frameLayers) {
            // Delete the frame layer at this index
            delete this.editor.frameLayers[this.frameIndex];
            
            // Shift all frame layers after this index down by one
            for (let i = this.frameIndex; i < this.editor.frames.length; i++) {
                if (this.editor.frameLayers[i + 1]) {
                    this.editor.frameLayers[i] = this.editor.frameLayers[i + 1];
                }
            }
            // Delete the last one (it's now a duplicate)
            delete this.editor.frameLayers[this.editor.frames.length];
        }
        
        if (this.editor.currentFrameIndex >= this.editor.frames.length) {
            this.editor.currentFrameIndex = this.editor.frames.length - 1;
        }
        
        if (this.editor.layersEnabled) {
            this.editor.updateLayersUI();
        }
        this.editor.updateUI();
        this.editor.redrawCanvas();
        this.editor.generateCode();
    }
}

class DeleteFrameCommand {
    constructor(editor, frameIndex, frameCanvas, frameLayerData = null) {
        this.editor = editor;
        this.frameIndex = frameIndex; // Index where frame was deleted
        this.frameCanvas = frameCanvas; // The frame canvas that was deleted
        this.frameLayerData = frameLayerData; // Layer data if layers were enabled
    }
    
    execute() {
        this.editor.frames.splice(this.frameIndex, 1);
        
        if (this.frameLayerData && this.editor.frameLayers) {
            // Delete the frame layer at this index
            delete this.editor.frameLayers[this.frameIndex];
            
            // Shift all frame layers after this index down by one
            for (let i = this.frameIndex; i < this.editor.frames.length; i++) {
                if (this.editor.frameLayers[i + 1]) {
                    this.editor.frameLayers[i] = this.editor.frameLayers[i + 1];
                }
            }
            // Delete the last one (it's now a duplicate)
            delete this.editor.frameLayers[this.editor.frames.length];
        }
        
        if (this.editor.currentFrameIndex >= this.editor.frames.length) {
            this.editor.currentFrameIndex = this.editor.frames.length - 1;
        }
        
        if (this.editor.layersEnabled) {
            this.editor.updateLayersUI();
        }
        this.editor.updateUI();
        this.editor.redrawCanvas();
        this.editor.generateCode();
    }
    
    undo() {
        this.editor.frames.splice(this.frameIndex, 0, this.frameCanvas);
        
        if (this.frameLayerData) {
            if (!this.editor.frameLayers) {
                this.editor.frameLayers = {};
            }
            
            // Shift all frame layers at or after this index up by one
            for (let i = this.editor.frames.length - 1; i > this.frameIndex; i--) {
                if (this.editor.frameLayers[i - 1]) {
                    this.editor.frameLayers[i] = this.editor.frameLayers[i - 1];
                }
            }
            
            // Insert the restored frame layer data
            this.editor.frameLayers[this.frameIndex] = this.frameLayerData;
        }
        
        this.editor.currentFrameIndex = this.frameIndex;
        if (this.editor.layersEnabled) {
            this.editor.updateLayersUI();
        }
        this.editor.updateUI();
        this.editor.redrawCanvas();
        this.editor.generateThumbnail(this.frameIndex);
        this.editor.generateCode();
    }
}

class PasteCommand {
    constructor(editor, pasteData, frameIndex) {
        this.editor = editor;
        this.pasteData = pasteData; // Array of {x, y, oldColor, newColor}
        this.frameIndex = frameIndex;
    }
    
    execute() {
        const ctx = this.editor.frames[this.frameIndex].getContext('2d', { willReadFrequently: true });
        
        // Apply all the pixel changes
        for (const pixel of this.pasteData) {
            ctx.fillStyle = pixel.newColor;
            ctx.fillRect(pixel.x, pixel.y, 1, 1);
        }
        
        this.editor.redrawCanvas();
        this.editor.generateThumbnail(this.frameIndex);
        this.editor.generateCode();
    }
    
    undo() {
        const ctx = this.editor.frames[this.frameIndex].getContext('2d', { willReadFrequently: true });
        
        // Restore all the old colors
        for (const pixel of this.pasteData) {
            ctx.fillStyle = pixel.oldColor;
            ctx.fillRect(pixel.x, pixel.y, 1, 1);
        }
        
        this.editor.redrawCanvas();
        this.editor.generateThumbnail(this.frameIndex);
        this.editor.generateCode();
    }
}

class DrawingEditor {
    constructor() {
        
        // Initialize basic state first
        this.canvasWidth = 144;
        this.canvasHeight = 168;
        this.currentFrameIndex = 0;
        
        // Calculate initial zoom based on physical KYWY screen size
        // KYWY screen: 1.5" diagonal, 144x168 pixels
        // Screen diagonal in pixels: sqrt(144^2 + 168^2) = 221.36 pixels
        // Physical size: 1.5 inches
        // Pixels per inch on KYWY: 221.36 / 1.5 = 147.57 PPI
        // Typical monitor PPI: ~96 PPI
        // To match physical size: 147.57 / 96 = 1.54x
        // But we want it slightly larger for easier editing, so use 4x as default
        this.zoom = 4;
        
        // Store physical screen info for reference
        this.physicalDiagonal = 1.5; // inches
        this.physicalPPI = Math.sqrt(this.canvasWidth**2 + this.canvasHeight**2) / this.physicalDiagonal;
        this.typicalMonitorPPI = 96; // Standard monitor PPI
        this.physicalSizeZoom = this.physicalPPI / this.typicalMonitorPPI; // ~1.54x for actual physical size
        
        // Initialize canvas elements
        this.initializeCanvas();
        
        // Drawing state
        this.currentTool = 'pen';
        this.currentColor = 'black';
        this.brushSize = 1;
        this.brushShape = 'square';
        this.isDrawing = false;
        this.isPanning = false;
        
        // Throttling for canvas updates
        this.lastRedrawTime = 0;
        this.pendingRedrawTimeout = null;
        
        // Rectangle properties
        this.rectangleThickness = 1;
        this.rectangleStyle = 'outside'; // 'outside', 'inside', 'centered'
        
        // Shape properties (for both rectangle and circle)
        this.shapeFillMode = 'outline'; // 'outline', 'filled'
        this.shapeThickness = 1;
        this.shapeStrokePosition = 'outside'; // 'outside', 'inside', 'centered'
        
        // Shape drawing mode: 'corner', 'center', 'perfect-corner', 'perfect-center'
        this.shapeMode = 'corner';
        
        // Polygon properties
        this.polygonSides = 6;
        this.polygonFillMode = 'outline'; // 'outline', 'filled'
        this.polygonThickness = 1;
        // Polygon now uses the same mode system as circle/rectangle tools
        
        // Grid properties
        this.showPixelGrid = false;
        this.showGrid = false;
        
        // Grid mode properties
        this.gridModeEnabled = false;
        this.gridSize = 8;
        this.showGridLines = true;
        
        // Pen mode properties
        this.penMode = 'freehand'; // 'freehand', 'line', 'grid', 'spray'
        this.sprayFlow = 3; // Particles per movement unit (1-10)
        this.sprayInterval = null; // Timer for continuous spray
        this.sprayPos = null; // Current spray position
        
        // Fill pattern properties
        this.fillPattern = 'solid'; // default to solid fill
        this.gradientType = null; // 'linear' or 'radial'
        this.gradientVariant = 'stipple'; // 'stipple' or 'dither' (removed 'smooth')
        this.gradientAngle = 0; // angle for gradients
        this.gradientSteepness = 1.0; // steepness for gradients
        this.gradientContrast = 1.0; // contrast for dithered gradients (0.1 = low contrast, 2.0 = high contrast)
        this.gradientCenterDistance = 0.5; // center distance adjustment for gradients
        
        // Gradient editing state
        this.isEditingGradientSettings = false;
        this.gradientEditingTimeout = null;
        
        // Linear gradient properties
        this.gradientPositionX = 0.5; // X position for linear gradient center (0.0 = left, 1.0 = right)
        this.gradientPositionY = 0.5; // Y position for linear gradient center (0.0 = top, 1.0 = bottom)
        
        // Radial gradient properties
        this.radialRadius = 0.7; // radius for radial gradients (0.1 = small, 2.0 = large)
        this.radialPositionX = 0.5; // X position for radial gradient center (0.0 = left, 1.0 = right)
        this.radialPositionY = 0.5; // Y position for radial gradient center (0.0 = top, 1.0 = bottom)
        
        // Line pattern properties
        this.lineAngle = 0; // angle for line patterns (0-180 degrees)
        this.lineSpacing = 6; // spacing between lines (in pixels)
        this.lineWidth = 1; // width of lines (in pixels)
        this.linePhase = 0; // phase offset for line patterns (0-20 pixels)
        
        // Percentage fill properties
        this.currentPercentage = 50; // default percentage fill (5-95%)
        
        // Checkerboard pattern properties
        this.checkerboardSize = 2; // size of checkerboard squares (1-8 pixels)
        this.checkerboardInvert = false; // whether to invert the pattern
        
        // Clipboard pattern properties  
        this.clipboardScale = 100; // scale percentage for clipboard pattern (25-300%)
        this.clipboardInvert = false; // whether to invert the pattern
        
        // Dots pattern properties
        this.dotsSpacing = 4; // spacing between dots (2-16 pixels)
        this.dotsSize = 1; // size of dots (1-4 pixels)
        this.dotsOffset = 50; // offset percentage for staggered rows (0-100%)
        this.dotsInvert = false; // whether to invert the pattern
        
        // Generate pattern data
        this.patterns = this.generatePatterns();
        
        
        // Animation state - initialize frames BEFORE calling other methods
        this.frames = [];
        this.isPlaying = false;
        this.animationInterval = null;
        this.animationMode = 'cycle'; // 'cycle' or 'boomerang'
        this.animationDirection = 1; // 1 for forward, -1 for backward (boomerang)
        
        // Layer system
        this.layersEnabled = false;
        this.animationEnabled = false;
        this.layers = []; // Array of layers for current frame: [{name, canvas, visible}, ...]
        this.currentLayerIndex = 0;
        this.frameLayers = {}; // Store layers per frame: {frameIndex: {layers: [...], currentLayerIndex: 0}}
        this.soloLayerIndex = null; // Index of layer in solo/focus mode, null when not in solo mode
        
        // Create first frame after frames array is initialized
        this.frames.push(this.createEmptyFrame());
        
        // Selection state
        this.clipboard = null;
        this.selection = null;
        this.isPasteModeActive = false;
        this.pasteTransparencyMode = 'white'; // 'white', 'black', or 'none'
        this.selectionMode = 'rectangle'; // 'rectangle' or 'lasso'
        
        // Paste mode drag state
        this.pasteDragActive = false;
        this.pasteDragStartTime = 0;
        this.pasteDragStartX = 0;
        this.pasteDragStartY = 0;
        this.pasteDragThreshold = 5; // pixels to move before considering it a drag
        this.pasteDragTimeThreshold = 150; // milliseconds to hold before dragging
        this.lastPasteTime = 0;
        this.pasteThrottleInterval = 50; // minimum milliseconds between pastes during drag
        
        // Last preview area for live pattern updates
        this.lastPreviewArea = null;
        
        // Touch tracking for gestures
        this.lastTouchDistance = null;
        this.lastTouchCenter = null;
        this.activeTouchId = null; // Track the primary touch for drawing
        this.touchStartTime = 0; // For palm rejection timing
        
        // Mirror drawing state
        this.mirrorHorizontal = false;
        this.mirrorVertical = false;
        
        // Text tool properties
        this.textInput = '';
        this.fontFamily = "Arial"; // Default to common system font
        this.fontSize = 48;
        this.textBold = false;
        this.textItalic = false;
        this.textColor = 'black';
        this.isPlacingText = false;
        this.textPreviewCanvas = null;
        this.textPreviewData = null;
        
        // Emoji properties
        this.emojiBrightness = -20; // -100 to 100
        this.emojiContrast = 100; // 50 to 200 (percentage)
        this.emojiMode = 'edge'; // 'dithering', 'thresholding', or 'edge'
        this.ditheringType = 'floyd-steinberg'; // 'floyd-steinberg', 'atkinson', 'bilayer'
        this.emojiCategories = {
            faces: ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚', '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🤩', '🥳', '🤔', '🥺', '🫠', '🤠', '🤫', '😞', '😢', '😠', '😕', '🙄', '🤦‍♀️', '🤦‍♂️', '🤷‍♀️', '🤷‍♂️', '👶', '🧒', '👦', '👧', '🧑', '👱', '👨', '🧔', '👩', '🧓', '👴', '👵', '👱‍♀️', '👱‍♂️', '🙎‍♀️', '🙎‍♂️', '🙍‍♀️', '🙍‍♂️', '🙇‍♀️', '🙇‍♂️', '👨‍⚕️', '👩‍⚕️', '👨‍🌾', '👩‍🌾', '👨‍🍳', '👩‍🍳'],
            nature: ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐻‍❄️', '🐨', '🐯', '🦁', '🐮', '🐷', '🐽', '🐸', '🐵', '🙈', '🙉', '🙊', '🐒', '🐔', '🐧', '🐦', '🐦‍⬛', '🐤', '🐣', '🐥', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗', '🐴', '🦄', '🐝', '🐛', '🦋', '🐌', '🐞', '🐜', '🪱', '🪰', '🪲', '🪳', '🦟', '🦗', '🕷', '🕸', '🦂', '🐢', '🐍', '🦎', '🦖', '🦕', '🐙', '🦑', '🦐', '🦞', '🦀', '🪼', '🪸', '🐡', '🐠', '🐟', '🐬', '🐳', '🐋', '🦈', '🐊', '🐅', '🐆', '🦓', '🫏', '🦍', '🦧', '🦣', '🐘', '🦛', '🦏', '🐪', '🐫', '🦒', '🦘', '🦬', '🐃', '🐂', '🐄', '🐎', '🐖', '🐏', '🐑', '🦙', '🐐', '🦌', '🫎', '🐕', '🐩', '🦮', '🐕‍🦺', '🐈', '🐈‍⬛', '🪽', '🪶', '🐓', '🦃', '🦤', '🦚', '🦜', '🦢', '🪿', '🦩', '🕊', '🐇', '🦝', '🦨', '🦡', '🦫', '🦦', '🦥', '🐁', '🐀', '🐿', '🦔', '🐾', '🐉', '🐲', '🐦‍🔥', '🌵', '🎄', '🌲', '🌳', '🌴', '🪾', '🌱', '🌿', '☘️', '🍀', '🎍', '🪴', '🎋', '🍃', '🍂', '🍁', '🍄', '🍄‍🟫', '🐚', '🪨', '🌾', '💐', '🌷', '🪷', '🌹', '🥀', '🌺', '🌸', '🪻', '🌼', '🌻', '🪹', '🪺', '🪵', '🌞', '🌝', '🌛', '🌜', '🌚', '🌕', '🌖', '🌗', '🌘', '🌑', '🌒', '🌓', '🌔', '🌙', '🌎', '🌍', '🌏', '🪐', '💫', '⭐️', '🌟', '✨', '⚡️', '☄️', '💥', '🔥', '🌪', '🌈', '☀️', '🌤', '⛅️', '🌥', '☁️', '🌦', '🌧', '⛈️', '🌩', '🌨', '❄️', '☃️', '⛄', '🌬', '💨', '🌊', '🌀', '🌫', '🌋'],
            food: ['🍎', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦', '🥬', '🥒', '🌶️', '🌽', '🥕', '🧄', '🧅', '🥔', '🍠', '🥐', '🍞', '🥖', '🥨', '🥯', '🧀', '🥚', '🍳', '🧈', '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🦴', '🌭', '🍔', '🍟', '🍕', '🫓', '🥙', '🌮', '🌯', '🫔', '🥗', '🥘', '🫕', '🍝', '🍜', '🍲', '🍛', '🍣', '🍱', '🥟', '🦪', '🍤', '🍙', '🍚', '🍘', '🍥', '🥠', '🥮', '🍢', '🍡', '🍧', '🍨', '🍦', '🥧', '🧁', '🍰', '🎂', '🍮', '🍭', '🍬', '🍫', '🍿', '🍩', '🍪', '🌰', '🥜', '🍯', '🥛', '🍼', '☕', '🫖', '🍵', '🧃', '🥤', '🧋', '🍶'],
            monsters: ['👾', '👹', '🧌', '👺', '👽', '☠️', '💩', '🤖', '👻', '💀', '🐙', '🧟', '🧛', '🦖', '🥷', '🐉', '🛡️', '⚔️', '🗡️' , '♔', '♕', '♖', '♗', '♘', '♙', '♚', '♛', '♜', '♝', '♞', '♟'],
            activities: ['⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱', '🪀', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏', '🪃', '🥅', '⛳', '🪁', '🏹', '🎣', '🤿', '🥊', '🥋', '🎽', '🛹', '🛷', '⛸️', '🎿', '⛷️', '🏂', '🪂', '🏋️‍♀️', '🏋️‍♂️', '🤸‍♀️', '🤸‍♂️', '⛹️‍♀️', '⛹️‍♂️', '🤺', '🤾‍♀️', '🤾‍♂️', '🏌️‍♀️', '🏌️‍♂️', '🧘‍♀️', '🧘‍♂️', '🏃‍♀️', '🏃‍♂️', '🚶‍♀️', '🚶‍♂️', '🧎‍♀️', '🧎‍♂️', '🧍‍♀️', '🧍‍♂️', '👨‍🦯', '👩‍🦯', '👨‍🦼', '👩‍🦼', '👨‍🦽', '👩‍🦽', '🏇', '⛹️‍♀️', '⛹️‍♂️', '🏌️‍♀️', '🏌️‍♂️', '🏄‍♀️', '🏄‍♂️', '🚣‍♀️', '🚣‍♂️', '🏊‍♀️', '🏊‍♂️', '⛹️‍♀️', '⛹️‍♂️', '🏋️‍♀️', '🏋️‍♂️', '🚴‍♀️', '🚴‍♂️', '🚵‍♀️', '🚵‍♂️', '🤸‍♀️', '🤸‍♂️', '🤼‍♀️', '🤼‍♂️', '🤽‍♀️', '🤽‍♂️', '🏊‍♀️', '🏊‍♂️', '🤾‍♀️', '🤾‍♂️', '🧘‍♀️', '🧘‍♂️', '🏃‍♀️', '🏃‍♂️', '🚶‍♀️', '🚶‍♂️', '🧎‍♀️', '🧎‍♂️', '🧍‍♀️', '🧍‍♂️'],
            travel: ['🚗', '🚕', '🚙', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐', '🛻', '🚚', '🚛', '🚜', '🏍️', '🛵', '🚲', '🛴', '🛺', '🚨', '🚔', '🚍', '🚘', '🚖', '🚡', '🚠', '🚟', '🚃', '🚋', '🚞', '🚝', '🚄', '🚅', '🚈', '🚂', '🚆', '🚇', '🚊', '🚉', '✈️', '🛩️', '🛫', '🛬', '🪂', '💺', '🚀', '🛸', '🚁', '🚟', '🚠', '🚡', '🛤️', '🛣️', '🗺️', '⛽', '🚨', '🚥', '🚦', '🛑', '🚧', '⚓', '⛵', '🛶', '🚤', '🛳️', '⛴️', '🛥️', '🚢', '✈️', '🛩️', '🛫', '🛬', '🪂', '💺', '🚀', '🛸', '🚁', '🚟', '🚠', '🚡', '🛤️', '🛣️', '🗺️', '⛽', '🚨', '🚥', '🚦', '🛑', '🚧', '⚓', '⛵', '🛶', '🚤', '🛳️', '⛴️', '🛥️', '🚢'],
            objects: ['💡', '🔦', '🕯️', '🪔', '🧯', '🛢️', '💸', '💵', '💰', '💳', '💎', '⚖️', '🪜', '🧰', '🔧', '🔨', '⚒️', '🛠️', '⛏️', '🔩', '⚙️', '🪚', '🔫', '💣', '🧨', '🪓', '🔪', '🗡️', '⚔️', '🛡️', '⚰️', '🪦', '⚱️', '🏺', '🔮', '🪄', '🧿', '🧸', '🪆', '🎈', '🎉', '🎊', '🎎', '🎏', '🎐', '🎀', '🎁', '🔪', '🗡️', '⚔️', '🛡️', '⚰️', '🪦', '⚱️', '🏺', '🔮', '🪄', '🧿', '🧸', '🪆', '🎈', '🎉', '🎊', '🎎', '🎏', '🎐', '🎀', '🎁', '📱', '📲', '☎️', '📞', '📟', '📠', '🔋', '🔌', '💻', '🖥️', '🖨️', '⌨️', '🖱️', '🖲️', '💽', '💾', '💿', '📀', '🧮', '🎥', '🎞️', '📽️', '🎬', '📺', '📷', '📸', '📹', '📼', '🔍', '🔎', '🕯️', '💡', '🔦', '🏮', '🪔', '📔', '📕', '📖', '📙', '📚', '📓', '📃', '📜', '📄', '📰', '🗞️', '📑', '🔖', '🏷️', '💰', '💴', '💵', '💶', '💷', '💸', '💳', '🧾', '💹', '✉️', '📧', '📨', '📩', '📤', '📥', '📦', '📫', '📪', '📬', '📭', '📮', '🗳️', '✏️', '✒️', '🖋️', '🖊️', '🖌️', '🖍️', '📝', '💼', '📁', '📂', '🗂️', '📅', '📆', '🗒️', '🗓️', '📇', '📈', '📉', '📊', '📋', '📌', '📍', '📎', '🖇️', '📏', '📐', '✂️', '🗃️', '🗄️', '🗑️', '🔒', '🔓', '🔏', '🔐', '🔑', '🗝️', '🔨', '⛏️', '⚒️', '🛠️', '🔧', '🔩', '⚙️', '🗜️', '⚖️', '🦯', '🔗', '⛓️', '🪝', '🧰', '🧲', '🪜', '⚗️', '🔬', '🔭', '📡', '💉', '🩸', '💊', '🩹', '🩼', '🩺', '🩻', '🚪', '🛗', '🪞', '🪟', '🛏️', '🛋️', '🪑', '🚽', '🪠', '🚿', '🛁', '🪤', '🪒', '🧴', '🧷', '🧹', '🧺', '🧻', '🪣', '🧼', '🫧', '🧽', '🧯', '🛒', '🏺', '💯', '🔥', '👌', '👍', '👀', '🧠', '🤡', '💭', '📣', '💀'],
            symbols: ['❤️', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '☮️', '✝️', '☪️', '🕉️', '☸️', '✡️', '🔯', '🕎', '☯️', '☦️', '🛐', '⛎', '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓', '🆔', '⚛️', '🉑', '☢️', '☣️', '📳', '✴️', '💮', '▪️', '◼️', '◽', '⬛', '🔷', '🔸', '🔹', '🔺', '🔻', '💠', '🔘', '🔳', '🔲', '🏁', '🚩', '🎌', '🏴', '🏳️', '🏳️‍🌈', '🏳️‍⚧️', '🏴‍☠️', '🇦🇨', '🇦🇩', '🇦🇪', '🇦🇫', '🇦🇬', '🇦🇮', '🇦🇱', '🇦🇲', '🇦🇴', '🇦🇶', '🇦🇷', '🇦🇸', '🇦🇹', '🇦🇺', '🇦🇼', '🇦🇽', '🇦🇿', '🇧🇦', '🇧🇧', '🇧🇩', '🇧🇪', '🇧🇫', '🇧🇬', '🇧🇭', '🇧🇮', '🇧🇯', '🇧🇱', '🇧🇲', '🇧🇳', '🇧🇴', '🇧🇶', '🇧🇷', '🇧🇸', '🇧🇹', '🇧🇻', '🇧🇼', '🇧🇾', '🇧🇿', '🇨🇦', '🇨🇨', '🇨🇩', '🇨🇫', '🇨🇬', '🇨🇭', '🇨🇮', '🇨🇰', '🇨🇱', '🇨🇲', '🇨🇳', '🇨🇴', '🇨🇵', '🇨🇷', '🇨🇺', '🇨🇻', '🇨🇼', '🇨🇽', '🇨🇾', '🇨🇿', '🇩🇪', '🇩🇬', '🇩🇯', '🇩🇰', '🇩🇲', '🇩🇴', '🇩🇿', '🇪🇦', '🇪🇨', '🇪🇪', '🇪🇬', '🇪🇭', '🇪🇷', '🇪🇸', '🇪🇹', '🇪🇺', '🇫🇮', '🇫🇯', '🇫🇰', '🇫🇲', '🇫🇴', '🇫🇷', '🇬🇦', '🇬🇧', '🇬🇩', '🇬🇪', '🇬🇫', '🇬🇭', '🇬🇮', '🇬🇱', '🇬🇲', '🇬🇳', '🇬🇵', '🇬🇶', '🇬🇷', '🇬🇸', '🇬🇹', '🇬🇺', '🇬🇼', '🇬🇾', '🇭🇰', '🇭🇲', '🇭🇳', '🇭🇷', '🇭🇹', '🇭🇺', '🇮🇨', '🇮🇩', '🇮🇪', '🇮🇱', '🇮🇲', '🇮🇳', '🇮🇴', '🇮🇶', '🇮🇷', '🇮🇸', '🇮🇹', '🇯🇪', '🇯🇲', '🇯🇴', '🇯🇵', '🇰🇪', '🇰🇬', '🇰🇭', '🇰🇮', '🇰🇲', '🇰🇳', '🇰🇵', '🇰🇷', '🇰🇼', '🇰🇾', '🇰🇿', '🇱🇦', '🇱🇧', '🇱🇨', '🇱🇮', '🇱🇰', '🇱🇷', '🇱🇸', '🇱🇹', '🇱🇺', '🇱�', '🇱🇾', '🇲🇦', '🇲🇨', '🇲🇩', '🇲🇪', '🇲🇫', '🇲🇬', '🇲🇭', '🇲🇰', '🇲🇱', '🇲🇲', '🇲🇳', '🇲🇴', '🇲🇵', '🇲🇶', '🇲🇷', '🇲🇸', '🇲🇹', '🇲🇺', '🇲🇻', '🇲🇼', '🇲🇽', '🇲🇾', '🇲🇿', '🇳🇦', '🇳🇨', '🇳🇪', '🇳🇫', '🇳🇮', '🇳🇱', '🇳🇴', '🇳🇵', '🇳🇷', '🇳🇺', '🇳🇿', '🇴🇲', '🇵🇦', '🇵🇪', '🇵🇫', '🇵🇬', '🇵🇭', '🇵🇰', '🇵🇱', '🇵🇲', '🇵🇷', '🇵🇸', '🇵🇹', '🇵🇼', '🇵🇾', '🇶🇦', '🇷🇪', '🇷🇴', '🇷🇸', '🇷🇺', '🇷🇼', '🇸🇦', '🇸🇧', '🇸🇨', '🇸🇩', '🇸🇪', '🇸🇬', '🇸🇭', '🇸🇮', '🇸🇯', '🇸🇰', '🇸🇱', '🇸🇲', '🇸🇳', '🇸🇴', '🇸🇷', '🇸🇸', '🇸🇹', '🇸🇻', '🇸🇽', '🇸🇾', '🇸🇿', '🇹🇦', '🇹🇨', '🇹🇩', '🇹🇫', '🇹🇬', '🇹🇭', '🇹🇯', '🇹🇰', '🇹🇱', '🇹🇲', '🇹🇳', '🇹🇴', '🇹🇷', '🇹🇹', '🇹🇻', '🇹🇼', '🇹🇿', '🇺🇦', '🇺🇬', '🇺🇲', '🇺🇳', '🇺🇸', '🇺🇾', '🇺🇿', '🇻🇦', '🇻🇨', '🇻🇪', '🇻🇬', '🇻🇮', '🇻🇳', '🇻🇺', '🇼🇫', '🇼🇸', '🇽🇰', '🇾🇪', '🇾🇹', '🇿🇦', '🇿🇲', '🇿🇼']
        };
        this.currentEmojiCategory = 'food';
        
        // Undo/Redo system using snapshots
        this.undoStack = [];
        this.redoStack = [];
        this.maxUndoStackSize = 50;
        this.pendingSnapshot = null; // Snapshot taken before an operation starts
        
        // Unsaved work tracking
        this.hasUnsavedChanges = false;
        this.isBlankCanvas = true; // Starts with blank canvas
        
        // Setup unsaved changes warning
        this.setupUnsavedWarning();
        
        // Save reminder system
        this.lastSaveTime = Date.now();
        this.saveReminderInterval = null;
        this.saveReminderBanner = null;
        this.saveReminderEnabled = true; // Can be disabled permanently
        
        // Now safe to initialize tools and events
        this.initializeTools();
        this.initializeEvents();
        this.initializeFrameSystem();
        
        this.updateUI();
        // Submenus start closed by default - removed initialization toggles
        this.generateThumbnail(0);
        
        // Initialize pen tool as default with visible options
        this.setTool('pen');
        
        // Initialize pen mode display
        this.updatePenModeButton();
        
        // Initialize selection mode display
        this.updateSelectionModeButton();
        
        // Initialize brush controls display
        this.updateBrushControlsState();
        
        // Initialize animation mode (cycle is default)
        this.animationMode = 'cycle';
        this.animationDirection = 1;
        const cycleBtn = document.getElementById('cycleMode');
        const boomerangBtn = document.getElementById('boomerangMode');
        if (cycleBtn) {
            cycleBtn.classList.add('active');
        }
        if (boomerangBtn) {
            boomerangBtn.classList.remove('active');
        }
        
        // Initialize onion skin mode (black on white is default)
        this.onionSkinMode = 'blackOnWhite';
        const activeOnionBtn = document.getElementById('onionModeBlackOnWhite');
        if (activeOnionBtn) {
            activeOnionBtn.classList.add('active');
        }
        const inactiveOnionBtn = document.getElementById('onionModeWhiteOnBlack');
        if (inactiveOnionBtn) {
            inactiveOnionBtn.classList.remove('active');
        }
        
        // Initialize transparency button display
        this.updateTransparencyButton();
        
        // Initialize rotation warning display
        this.updateRotationWarning(0);
        
        // Initialize default fill pattern
        this.setFillPattern('solid');
        
        // Auto-detect system fonts on initialization
        setTimeout(() => this.detectSystemFonts(), 500);
        
        // Initialize save reminder system
        this.initializeSaveReminder();
    }
    
    initializeCanvas() {
        this.backgroundCanvas = document.getElementById('backgroundCanvas');
        this.onionCanvas = document.getElementById('onionCanvas');
        this.drawingCanvas = document.getElementById('drawingCanvas');
        this.overlayCanvas = document.getElementById('overlayCanvas');
        
        this.backgroundCtx = this.backgroundCanvas.getContext('2d', { willReadFrequently: true });
        this.onionCtx = this.onionCanvas.getContext('2d', { willReadFrequently: true });
        this.drawingCtx = this.drawingCanvas.getContext('2d', { willReadFrequently: true });
        this.overlayCtx = this.overlayCanvas.getContext('2d', { willReadFrequently: true });
        
        // Disable smoothing for pixel art
        [this.backgroundCtx, this.onionCtx, this.drawingCtx, this.overlayCtx].forEach(ctx => {
            ctx.imageSmoothingEnabled = false;
            ctx.webkitImageSmoothingEnabled = false;
            ctx.mozImageSmoothingEnabled = false;
            ctx.msImageSmoothingEnabled = false;
        });
        
        this.setCanvasSize(144, 168);
        this.initializeBackgroundCanvas();
        
        // Initialize grid display
        this.updateGridDisplay();
        this.updateBrushControlsState();
        
        // Center the canvas on initialization - wait longer for DOM to be ready
        setTimeout(() => this.centerCanvas(), 300);
    }
    
    initializeBackgroundCanvas() {
        // Fill background canvas with white
        this.backgroundCtx.fillStyle = 'white';
        this.backgroundCtx.fillRect(0, 0, this.canvasWidth, this.canvasHeight);
    }
    
    setCanvasSize(width, height) {
        this.canvasWidth = width;
        this.canvasHeight = height;
        
        // Update physical size zoom calculation for new dimensions
        // Recalculate diagonal and PPI for current canvas size
        const diagonal = Math.sqrt(width**2 + height**2);
        // Assume proportional physical size based on 144x168 = 1.5" diagonal
        const kywyDiagonal = Math.sqrt(144**2 + 168**2); // 221.36
        this.physicalDiagonal = 1.5 * (diagonal / kywyDiagonal);
        this.physicalPPI = diagonal / this.physicalDiagonal;
        this.physicalSizeZoom = this.physicalPPI / this.typicalMonitorPPI;
        
        const displayWidth = width * this.zoom;
        const displayHeight = height * this.zoom;
        
        [this.backgroundCanvas, this.onionCanvas, this.drawingCanvas, this.overlayCanvas].forEach(canvas => {
            canvas.width = width;
            canvas.height = height;
            canvas.style.width = `${displayWidth}px`;
            canvas.style.height = `${displayHeight}px`;
        });
        
        // Resize all frame canvases
        if (this.frames) {
            this.frames.forEach(frame => {
                // Save current content
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = frame.width;
                tempCanvas.height = frame.height;
                const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
                tempCtx.drawImage(frame, 0, 0);
                
                // Resize frame
                frame.width = width;
                frame.height = height;
                const ctx = frame.getContext('2d', { willReadFrequently: true });
                ctx.fillStyle = 'white';
                ctx.fillRect(0, 0, width, height);
                
                // Restore content (top-left aligned)
                ctx.drawImage(tempCanvas, 0, 0);
            });
        }
        
        // Resize all layer canvases if layers are enabled
        if (this.layersEnabled && this.frameLayers) {
            Object.keys(this.frameLayers).forEach(frameIndex => {
                const frameData = this.frameLayers[frameIndex];
                if (frameData && frameData.layers) {
                    frameData.layers.forEach(layer => {
                        // Save current content
                        const tempCanvas = document.createElement('canvas');
                        tempCanvas.width = layer.canvas.width;
                        tempCanvas.height = layer.canvas.height;
                        const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
                        tempCtx.drawImage(layer.canvas, 0, 0);
                        
                        // Resize layer
                        layer.canvas.width = width;
                        layer.canvas.height = height;
                        const ctx = layer.canvas.getContext('2d', { willReadFrequently: true });
                        
                        // Fill layer 0 with white, others stay transparent
                        if (frameData.layers.indexOf(layer) === 0) {
                            ctx.fillStyle = 'white';
                            ctx.fillRect(0, 0, width, height);
                        }
                        
                        // Restore content (top-left aligned)
                        ctx.drawImage(tempCanvas, 0, 0);
                    });
                    
                    // Recomposite layers to frame after resize
                    this.compositeLayersToFrame(parseInt(frameIndex));
                }
            });
        }
        
        // Re-initialize background canvas after size change
        this.initializeBackgroundCanvas();
        this.redrawCanvas();
        this.updateCanvasInfo();
        
        // Regenerate all frame thumbnails after size change
        this.regenerateAllThumbnails();
    }
    
    createEmptyFrame() {
        const canvas = document.createElement('canvas');
        canvas.width = this.canvasWidth;
        canvas.height = this.canvasHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingEnabled = false;
        
        // Fill with white
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        return canvas;
    }
    
    centerCanvas() {
        const canvasContainer = document.querySelector('.canvas-container');
        const canvasWrapper = document.querySelector('.canvas-wrapper');
        const drawingCanvas = document.getElementById('drawingCanvas');
        
        if (canvasContainer && canvasWrapper && drawingCanvas) {
            // Wait for next frame to ensure layout is complete
            requestAnimationFrame(() => {
                // Override flexbox centering
                canvasContainer.style.display = 'block';
                canvasContainer.style.position = 'relative';
                canvasWrapper.style.position = 'absolute';
                
                // Get actual dimensions - need to account for padding
                const containerPadding = 20;
                const availableWidth = canvasContainer.clientWidth - (containerPadding * 2);
                const availableHeight = canvasContainer.clientHeight - (containerPadding * 2);
                
                // Get canvas dimensions from the actual canvas element (scaled by zoom)
                const actualCanvasWidth = this.canvasWidth * this.zoom;
                const actualCanvasHeight = this.canvasHeight * this.zoom;
                
                // Calculate the position to center the canvas middle in available space
                const leftPos = Math.max(containerPadding, ((availableWidth - actualCanvasWidth) / 2) + containerPadding);
                const topPos = Math.max(containerPadding, ((availableHeight - actualCanvasHeight) / 2) + containerPadding);
                
                // Set the position directly
                canvasWrapper.style.left = leftPos + 'px';
                canvasWrapper.style.top = topPos + 'px';
                canvasWrapper.style.transform = 'none';
                
                // Reset scroll position
                canvasContainer.scrollLeft = 0;
                canvasContainer.scrollTop = 0;
                
                // Verify the center calculation
                const canvasCenterX = leftPos + (actualCanvasWidth / 2);
                const canvasCenterY = topPos + (actualCanvasHeight / 2);
                const containerCenterX = (availableWidth / 2) + containerPadding;
                const containerCenterY = (availableHeight / 2) + containerPadding;
            });
        }
    }
    
    initializeTools() {
        // Tool selection
        document.querySelectorAll('.tool-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setTool(btn.dataset.tool);
            });
        });

        // Color selection
        document.querySelectorAll('.color-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setColor(btn.dataset.color);
            });
        });

        // Brush shape selection
        document.querySelectorAll('.brush-shape-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setBrushShape(btn.dataset.shape);
            });
        });

        // Selection mode selection
        document.querySelectorAll('.mode-btn[data-mode]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setSelectionMode(btn.dataset.mode);
            });
        });

        // Pen mode cycling button
        const penModeBtn = document.getElementById('penModeBtn');
        
        if (penModeBtn) {
            penModeBtn.addEventListener('click', () => {
                // Cycle between freehand, line, grid, and spray mode
                if (this.penMode === 'freehand') {
                    this.penMode = 'line';
                    this.gridModeEnabled = false;
                } else if (this.penMode === 'line') {
                    this.penMode = 'grid';
                    this.gridModeEnabled = true;
                } else if (this.penMode === 'grid') {
                    this.penMode = 'spray';
                    this.gridModeEnabled = false;
                } else {
                    this.penMode = 'freehand';
                    this.gridModeEnabled = false;
                }
                
                // If enabling grid mode and grid size is too small, set it to 8 (only on first enable)
                if (this.gridModeEnabled && this.gridSize <= 3) {
                    this.gridSize = 8;
                    if (gridSizeSlider) {
                        gridSizeSlider.value = this.gridSize;
                    }
                    document.getElementById('gridSizeDisplay').textContent = this.gridSize;
                    document.getElementById('gridSizeDisplay2').textContent = this.gridSize;
                    // Update brush size to match grid size and move its slider
                    this.brushSize = this.gridSize;
                    document.getElementById('brushSize').value = this.brushSize;
                    document.getElementById('brushSizeDisplay').textContent = this.brushSize;
                    // Also update mobile brush size controls if they exist
                    const mobileBrushSize = document.getElementById('mobileBrushSize');
                    const mobileBrushSizeDisplay = document.getElementById('mobileBrushSizeDisplay');
                    if (mobileBrushSize) {
                        mobileBrushSize.value = this.brushSize;
                    }
                    if (mobileBrushSizeDisplay) {
                        mobileBrushSizeDisplay.textContent = this.brushSize;
                    }
                }
                
                this.updatePenModeButton();
                this.updateBrushControlsState();
                this.updateGridDisplay();
                
                // Auto-switch to pen tool when enabling grid mode
                if (this.gridModeEnabled && this.currentTool !== 'pen') {
                    this.setTool('pen');
                }
            });
        }

        // Selection mode cycling button
        const selectionModeBtn = document.getElementById('selectionModeBtn');
        
        if (selectionModeBtn) {
            selectionModeBtn.addEventListener('click', () => {
                // Exit paste mode when changing selection mode
                if (this.isPasteModeActive) {
                    this.isPasteModeActive = false;
                    this.selection = null;
                    this.drawSelectionOverlay();
                }
                
                // Cycle between rectangle and lasso mode
                if (this.selectionMode === 'rectangle') {
                    this.selectionMode = 'lasso';
                } else {
                    this.selectionMode = 'rectangle';
                }
                
                this.updateSelectionModeButton();
            });
        }

        // Fill pattern selection
        document.querySelectorAll('.pattern-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setFillPattern(btn.dataset.pattern);
            });
        });

        // Gradient variant selection
        document.querySelectorAll('.variant-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setGradientVariant(btn.dataset.variant);
            });
        });

        // Gradient controls - Linear gradients
        const gradientAngleSlider = document.getElementById('gradientAngle');
        if (gradientAngleSlider) {
            gradientAngleSlider.addEventListener('input', () => {
                this.gradientAngle = parseInt(gradientAngleSlider.value);
                document.getElementById('angleDisplay').textContent = this.gradientAngle + '°';
                this.isEditingGradientSettings = true;
                this.ensureGradientEditingPreview();
                
                // IMMEDIATELY force red preview
                if (this.currentTool === 'bucket' && this.fillPattern.startsWith('gradient-')) {
                    this.updateGradientLivePreview();
                }
                
                // Throttle preview updates
                if (!this.gradientUpdateThrottle) {
                    this.gradientUpdateThrottle = true;
                    setTimeout(() => {
                        if (this.currentTool === 'bucket' && this.fillPattern.startsWith('gradient-linear')) {
                            this.updateGradientLivePreview();
                        }
                        this.gradientUpdateThrottle = false;
                    }, 16); // ~60fps
                }
                
                // Don't clear the editing flag automatically - only when mouse enters canvas
            });
        }

        const gradientSteepnessSlider = document.getElementById('gradientSteepness');
        if (gradientSteepnessSlider) {
            gradientSteepnessSlider.addEventListener('input', () => {
                this.gradientSteepness = parseFloat(gradientSteepnessSlider.value);
                document.getElementById('steepnessDisplay').textContent = this.gradientSteepness.toFixed(1);
                this.isEditingGradientSettings = true;
                this.ensureGradientEditingPreview();
                if (this.currentTool === 'bucket' && this.fillPattern.startsWith('gradient-linear')) {
                    this.updateGradientLivePreview();
                }
            });
        }

        const gradientPositionXSlider = document.getElementById('gradientPositionX');
        if (gradientPositionXSlider) {
            gradientPositionXSlider.addEventListener('input', () => {
                this.gradientPositionX = parseFloat(gradientPositionXSlider.value);
                document.getElementById('positionXDisplay').textContent = this.gradientPositionX.toFixed(1);
                this.isEditingGradientSettings = true;
                this.ensureGradientEditingPreview();
                if (this.currentTool === 'bucket' && this.fillPattern.startsWith('gradient-linear')) {
                    this.updateGradientLivePreview();
                }
                // Don't clear the editing flag automatically - only when mouse enters canvas
            });
        }

        const gradientPositionYSlider = document.getElementById('gradientPositionY');
        if (gradientPositionYSlider) {
            gradientPositionYSlider.addEventListener('input', () => {
                this.gradientPositionY = parseFloat(gradientPositionYSlider.value);
                document.getElementById('positionYDisplay').textContent = this.gradientPositionY.toFixed(1);
                this.isEditingGradientSettings = true;
                this.ensureGradientEditingPreview();
                if (this.currentTool === 'bucket' && this.fillPattern.startsWith('gradient-linear')) {
                    this.updateGradientLivePreview();
                }
            });
        }

        // Radial gradient controls
        const radialRadiusSlider = document.getElementById('radialRadius');
        if (radialRadiusSlider) {
            radialRadiusSlider.addEventListener('input', () => {
                this.radialRadius = parseFloat(radialRadiusSlider.value);
                document.getElementById('radiusDisplay').textContent = this.radialRadius.toFixed(1);
                this.isEditingGradientSettings = true;
                this.ensureGradientEditingPreview();
                if (this.currentTool === 'bucket' && this.fillPattern.startsWith('gradient-radial')) {
                    this.updateGradientLivePreview();
                }
                // Don't clear the editing flag automatically - only when mouse enters canvas
            });
        }

        const radialPositionXSlider = document.getElementById('radialPositionX');
        if (radialPositionXSlider) {
            radialPositionXSlider.addEventListener('input', () => {
                this.radialPositionX = parseFloat(radialPositionXSlider.value);
                document.getElementById('radialXDisplay').textContent = this.radialPositionX.toFixed(1);
                this.isEditingGradientSettings = true;
                this.ensureGradientEditingPreview();
                if (this.currentTool === 'bucket' && this.fillPattern.startsWith('gradient-radial')) {
                    this.updateGradientLivePreview();
                }
            });
        }

        const radialPositionYSlider = document.getElementById('radialPositionY');
        if (radialPositionYSlider) {
            radialPositionYSlider.addEventListener('input', () => {
                this.radialPositionY = parseFloat(radialPositionYSlider.value);
                document.getElementById('radialYDisplay').textContent = this.radialPositionY.toFixed(1);
                this.isEditingGradientSettings = true;
                this.ensureGradientEditingPreview();
                if (this.currentTool === 'bucket' && this.fillPattern.startsWith('gradient-radial')) {
                    this.updateGradientLivePreview();
                }
            });
        }

        // Stipple/Dither contrast control
        const gradientContrastSlider = document.getElementById('gradientContrast');
        if (gradientContrastSlider) {
            gradientContrastSlider.addEventListener('input', () => {
                this.gradientContrast = parseFloat(gradientContrastSlider.value);
                document.getElementById('contrastDisplay').textContent = this.gradientContrast.toFixed(1);
                this.isEditingGradientSettings = true;
                this.ensureGradientEditingPreview();
                if (this.currentTool === 'bucket' && (this.fillPattern.includes('stipple') || this.fillPattern.includes('dither'))) {
                    this.updateGradientLivePreview();
                }
            });
        }

        // Line pattern controls
        const lineAngleSlider = document.getElementById('lineAngle');
        if (lineAngleSlider) {
            lineAngleSlider.addEventListener('input', () => {
                this.lineAngle = parseInt(lineAngleSlider.value);
                document.getElementById('lineAngleDisplay').textContent = this.lineAngle + '°';
                // Regenerate line pattern when changed
                this.patterns = this.generatePatterns();
                // Update live preview if using bucket tool with lines pattern
                if (this.currentTool === 'bucket' && this.fillPattern === 'lines') {
                    this.isEditingGradientSettings = true;
                    this.ensureGradientEditingPreview();
                    setTimeout(() => this.updateGradientLivePreview(), 50);
                }
            });
        }

        const lineSpacingSlider = document.getElementById('lineSpacing');
        if (lineSpacingSlider) {
            lineSpacingSlider.addEventListener('input', () => {
                this.lineSpacing = parseInt(lineSpacingSlider.value);
                document.getElementById('lineSpacingDisplay').textContent = this.lineSpacing + 'px';
                // Regenerate line pattern when changed
                this.patterns = this.generatePatterns();
                // Update live preview if using bucket tool with lines pattern
                if (this.currentTool === 'bucket' && this.fillPattern === 'lines') {
                    this.isEditingGradientSettings = true;
                    this.ensureGradientEditingPreview();
                    setTimeout(() => this.updateGradientLivePreview(), 50);
                }
            });
        }

        const lineWidthSlider = document.getElementById('lineWidth');
        if (lineWidthSlider) {
            lineWidthSlider.addEventListener('input', () => {
                this.lineWidth = parseInt(lineWidthSlider.value);
                document.getElementById('lineWidthDisplay').textContent = this.lineWidth + 'px';
                // Regenerate line pattern when changed
                this.patterns = this.generatePatterns();
                // Update live preview if using bucket tool with lines pattern
                if (this.currentTool === 'bucket' && this.fillPattern === 'lines') {
                    setTimeout(() => this.updateGradientLivePreview(), 10);
                }
            });
        }

        const linePhaseSlider = document.getElementById('linePhase');
        if (linePhaseSlider) {
            linePhaseSlider.addEventListener('input', () => {
                this.linePhase = parseInt(linePhaseSlider.value);
                document.getElementById('linePhaseDisplay').textContent = this.linePhase + 'px';
                // Regenerate line pattern when changed
                this.patterns = this.generatePatterns();
                // Update live preview if using bucket tool with lines pattern
                if (this.currentTool === 'bucket' && this.fillPattern === 'lines') {
                    setTimeout(() => this.updateGradientLivePreview(), 10);
                }
            });
        }

        // Brush size
        const brushSizeSlider = document.getElementById('brushSize');
        brushSizeSlider.addEventListener('input', () => {
            this.brushSize = parseInt(brushSizeSlider.value);
            document.getElementById('brushSizeDisplay').textContent = this.brushSize;
            
            // In grid mode, sync grid size with brush size
            if (this.gridModeEnabled) {
                this.gridSize = this.brushSize;
                if (gridSizeSlider) {
                    gridSizeSlider.value = this.gridSize;
                }
                document.getElementById('gridSizeDisplay').textContent = this.gridSize;
                document.getElementById('gridSizeDisplay2').textContent = this.gridSize;
                this.updateGridDisplay();
                this.updateBrushControlsState();
            } else {
                // Even when not in grid mode, update grid size for consistency
                this.gridSize = this.brushSize;
                if (gridSizeSlider) {
                    gridSizeSlider.value = this.gridSize;
                }
                document.getElementById('gridSizeDisplay').textContent = this.gridSize;
                document.getElementById('gridSizeDisplay2').textContent = this.gridSize;
            }
        });
        
        // Spray flow controls
        const sprayFlowSlider = document.getElementById('sprayFlow');
        if (sprayFlowSlider) {
            sprayFlowSlider.addEventListener('input', () => {
                this.sprayFlow = parseInt(sprayFlowSlider.value);
                document.getElementById('sprayFlowDisplay').textContent = this.sprayFlow;
            });
        }

        // Grid mode controls
        const gridModeSettings = document.getElementById('gridModeSettings');
        const gridSizeSlider = document.getElementById('gridSize');
        
        if (gridSizeSlider) {
            gridSizeSlider.addEventListener('input', () => {
                this.gridSize = parseInt(gridSizeSlider.value);
                document.getElementById('gridSizeDisplay').textContent = this.gridSize;
                document.getElementById('gridSizeDisplay2').textContent = this.gridSize;
                
                // In grid mode, sync brush size with grid size
                if (this.gridModeEnabled) {
                    this.brushSize = this.gridSize;
                    document.getElementById('brushSize').value = this.brushSize;
                    document.getElementById('brushSizeDisplay').textContent = this.brushSize;
                    // Also update mobile brush size controls if they exist
                    const mobileBrushSize = document.getElementById('mobileBrushSize');
                    const mobileBrushSizeDisplay = document.getElementById('mobileBrushSizeDisplay');
                    if (mobileBrushSize) {
                        mobileBrushSize.value = this.brushSize;
                    }
                    if (mobileBrushSizeDisplay) {
                        mobileBrushSizeDisplay.textContent = this.brushSize;
                    }
                }
                
                this.updateGridDisplay();
                this.updateBrushControlsState(); // Update brush display to show grid size
            });
        }
        
        // Percentage pattern controls
        this.setupPercentageControls();
        
        // Pattern adjustment controls
        this.setupPatternControls();
        
        // Text controls
        this.setupTextControls();
    }

    setupPatternControls() {
        // Checkerboard controls
        const checkerboardSizeSlider = document.getElementById('checkerboardSize');
        if (checkerboardSizeSlider) {
            checkerboardSizeSlider.addEventListener('input', () => {
                this.checkerboardSize = parseInt(checkerboardSizeSlider.value);
                document.getElementById('checkerboardSizeDisplay').textContent = this.checkerboardSize + 'px';
                this.patterns = this.generatePatterns();
                // Update live preview if using bucket tool with checkerboard pattern
                if (this.currentTool === 'bucket' && this.fillPattern === 'checkerboard') {
                    setTimeout(() => this.updateGradientLivePreview(), 10);
                }
            });
        }
        
        const checkerboardInvertCheck = document.getElementById('checkerboardInvert');
        if (checkerboardInvertCheck) {
            checkerboardInvertCheck.addEventListener('change', () => {
                this.checkerboardInvert = checkerboardInvertCheck.checked;
                this.patterns = this.generatePatterns();
                // Update live preview if using bucket tool with checkerboard pattern
                if (this.currentTool === 'bucket' && this.fillPattern === 'checkerboard') {
                    setTimeout(() => this.updateGradientLivePreview(), 10);
                }
            });
        }
        
        // Clipboard controls
        const clipboardScaleSlider = document.getElementById('clipboardScale');
        if (clipboardScaleSlider) {
            clipboardScaleSlider.addEventListener('input', () => {
                this.clipboardScale = parseInt(clipboardScaleSlider.value);
                document.getElementById('clipboardScaleDisplay').textContent = this.clipboardScale + '%';
                this.patterns = this.generatePatterns();
                // Update live preview if using bucket tool with clipboard pattern
                if (this.currentTool === 'bucket' && this.fillPattern === 'clipboard') {
                    setTimeout(() => this.updateGradientLivePreview(), 10);
                }
            });
        }
        
        const clipboardInvertCheck = document.getElementById('clipboardInvert');
        if (clipboardInvertCheck) {
            clipboardInvertCheck.addEventListener('change', () => {
                this.clipboardInvert = clipboardInvertCheck.checked;
                this.patterns = this.generatePatterns();
                // Update live preview if using bucket tool with clipboard pattern
                if (this.currentTool === 'bucket' && this.fillPattern === 'clipboard') {
                    setTimeout(() => this.updateGradientLivePreview(), 10);
                }
            });
        }
        
        // Dots controls
        const dotsSpacingSlider = document.getElementById('dotsSpacing');
        if (dotsSpacingSlider) {
            dotsSpacingSlider.addEventListener('input', () => {
                this.dotsSpacing = parseInt(dotsSpacingSlider.value);
                document.getElementById('dotsSpacingDisplay').textContent = this.dotsSpacing + 'px';
                this.patterns = this.generatePatterns();
                // Update live preview if using bucket tool with dots pattern
                if (this.currentTool === 'bucket' && this.fillPattern === 'dots') {
                    setTimeout(() => this.updateGradientLivePreview(), 10);
                }
            });
        }
        
        const dotsSizeSlider = document.getElementById('dotsSize');
        if (dotsSizeSlider) {
            dotsSizeSlider.addEventListener('input', () => {
                this.dotsSize = parseInt(dotsSizeSlider.value);
                document.getElementById('dotsSizeDisplay').textContent = this.dotsSize + 'px';
                this.patterns = this.generatePatterns();
                // Update live preview if using bucket tool with dots pattern
                if (this.currentTool === 'bucket' && this.fillPattern === 'dots') {
                    setTimeout(() => this.updateGradientLivePreview(), 10);
                }
            });
        }
        
        const dotsOffsetSlider = document.getElementById('dotsOffset');
        if (dotsOffsetSlider) {
            dotsOffsetSlider.addEventListener('input', () => {
                this.dotsOffset = parseInt(dotsOffsetSlider.value);
                document.getElementById('dotsOffsetDisplay').textContent = this.dotsOffset + '%';
                this.patterns = this.generatePatterns();
                // Update live preview if using bucket tool with dots pattern
                if (this.currentTool === 'bucket' && this.fillPattern === 'dots') {
                    setTimeout(() => this.updateGradientLivePreview(), 10);
                }
            });
        }
        
        const dotsInvertCheck = document.getElementById('dotsInvert');
        if (dotsInvertCheck) {
            dotsInvertCheck.addEventListener('change', () => {
                this.dotsInvert = dotsInvertCheck.checked;
                this.patterns = this.generatePatterns();
                // Update live preview if using bucket tool with dots pattern
                if (this.currentTool === 'bucket' && this.fillPattern === 'dots') {
                    setTimeout(() => this.updateGradientLivePreview(), 10);
                }
            });
        }
    }

    setupPercentageControls() {
        const percentageSlider = document.getElementById('percentageFillSlider');
        if (percentageSlider) {
            percentageSlider.addEventListener('input', () => {
                this.currentPercentage = parseInt(percentageSlider.value);
                document.getElementById('percentageDisplay').textContent = this.currentPercentage;
                
                // Update the percentage button text to show current selection
                const percentageBtn = document.getElementById('percentageFill');
                if (percentageBtn) {
                    percentageBtn.innerHTML = `▦ ${this.currentPercentage}%`;
                    percentageBtn.setAttribute('title', `${this.currentPercentage}% Fill`);
                }
                
                // Regenerate patterns to include new percentage
                this.patterns = this.generatePatterns();
                // Update live preview if using bucket tool with percentage pattern
                if (this.currentTool === 'bucket' && this.fillPattern === 'percentage') {
                    this.isEditingGradientSettings = true;
                    this.ensureGradientEditingPreview();
                    setTimeout(() => this.updateGradientLivePreview(), 50);
                }
            });
        }
    }

    setupTextControls() {
        // Text input
        const textInput = document.getElementById('textInput');
        if (textInput) {
            textInput.addEventListener('input', (e) => {
                this.textInput = e.target.value;
                this.updateTextPreview();
            });
        }

        // Font family
        const fontFamily = document.getElementById('fontFamily');
        if (fontFamily) {
            fontFamily.addEventListener('change', (e) => {
                this.fontFamily = e.target.value;
                this.updateTextPreview();
            });
        }

        // Font size
        const fontSize = document.getElementById('fontSize');
        if (fontSize) {
            fontSize.addEventListener('input', (e) => {
                this.fontSize = parseInt(e.target.value);
                document.getElementById('fontSizeDisplay').textContent = this.fontSize;
                this.updateTextPreview();
            });
        }

        // Bold toggle
        const boldToggle = document.getElementById('boldToggle');
        if (boldToggle) {
            boldToggle.addEventListener('click', () => {
                this.textBold = !this.textBold;
                boldToggle.classList.toggle('active', this.textBold);
                this.updateTextPreview();
            });
        }

        // Italic toggle
        const italicToggle = document.getElementById('italicToggle');
        if (italicToggle) {
            italicToggle.addEventListener('click', () => {
                this.textItalic = !this.textItalic;
                italicToggle.classList.toggle('active', this.textItalic);
                this.updateTextPreview();
            });
        }

        // Text color selection
        document.querySelectorAll('#textSettings .color-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                // Remove active from all text color buttons
                document.querySelectorAll('#textSettings .color-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.textColor = btn.dataset.color;
                this.updateTextPreview();
            });
        });

        // Emoji picker - always visible
        const emojiPicker = document.getElementById('emojiPicker');
        if (emojiPicker) {
            // Always populate the emoji grid on load
            this.populateEmojiGrid();
            
            // Prevent clicks inside the picker from interfering with canvas
            emojiPicker.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        }

        // Emoji category buttons
        document.querySelectorAll('.emoji-cat-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.emoji-cat-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.currentEmojiCategory = btn.dataset.category;
                this.populateEmojiGrid();
            });
        });

        // Emoji brightness control
        const emojiBrightness = document.getElementById('emojiBrightness');
        if (emojiBrightness) {
            emojiBrightness.addEventListener('input', (e) => {
                this.emojiBrightness = parseInt(e.target.value);
                document.getElementById('emojiBrightnessDisplay').textContent = this.emojiBrightness;
                this.updateTextPreview();
            });
        }

        // Emoji contrast control
        const emojiContrast = document.getElementById('emojiContrast');
        if (emojiContrast) {
            emojiContrast.addEventListener('input', (e) => {
                this.emojiContrast = parseInt(e.target.value);
                document.getElementById('emojiContrastDisplay').textContent = this.emojiContrast;
                this.updateTextPreview();
            });
        }

        // Dithering type selector
        const ditheringTypeSelect = document.getElementById('ditheringTypeSelect');
        if (ditheringTypeSelect) {
            ditheringTypeSelect.value = this.ditheringType;
            ditheringTypeSelect.addEventListener('change', (e) => {
                this.ditheringType = e.target.value;
                this.updateTextPreview();
            });
        }

        // Emoji processing mode toggle
        const emojiDitheringToggle = document.getElementById('emojiDitheringToggle');
        if (emojiDitheringToggle) {
            emojiDitheringToggle.addEventListener('click', () => {
                // Cycle through modes: dithering -> thresholding -> edge -> dithering
                switch (this.emojiMode) {
                    case 'dithering':
                        this.emojiMode = 'thresholding';
                        emojiDitheringToggle.textContent = '⬜ Thresholding';
                        break;
                    case 'thresholding':
                        this.emojiMode = 'edge';
                        emojiDitheringToggle.textContent = '🔍 Edge Detection';
                        break;
                    case 'edge':
                        this.emojiMode = 'dithering';
                        emojiDitheringToggle.textContent = '🎨 Dithering';
                        break;
                }
                
                // Show/hide dithering options based on mode
                const ditheringOptionsContainer = document.getElementById('ditheringOptionsContainer');
                if (ditheringOptionsContainer) {
                    ditheringOptionsContainer.style.display = this.emojiMode === 'dithering' ? 'block' : 'none';
                }
                
                // Show/hide brightness control based on mode (show for all modes including edge detection)
                const brightnessContainer = document.getElementById('emojiBrightnessContainer');
                if (brightnessContainer) {
                    brightnessContainer.style.display = 'block';
                }
                
                emojiDitheringToggle.classList.add('active');
                this.updateTextPreview();
            });
        }

        // Initialize text button states
        this.initializeTextButtonStates();
    }

    initializeTextButtonStates() {
        // Initialize bold button state
        const boldToggle = document.getElementById('boldToggle');
        if (boldToggle) {
            boldToggle.classList.toggle('active', this.textBold);
        }

        // Initialize italic button state
        const italicToggle = document.getElementById('italicToggle');
        if (italicToggle) {
            italicToggle.classList.toggle('active', this.textItalic);
        }

        // Initialize color button state
        document.querySelectorAll('#textSettings .color-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.color === this.textColor);
        });

        // Initialize emoji brightness and contrast displays
        const brightnessDisplay = document.getElementById('emojiBrightnessDisplay');
        if (brightnessDisplay) {
            brightnessDisplay.textContent = this.emojiBrightness;
        }
        
        const contrastDisplay = document.getElementById('emojiContrastDisplay');
        if (contrastDisplay) {
            contrastDisplay.textContent = this.emojiContrast;
        }

        // Initialize dithering type selector
        const ditheringTypeSelect = document.getElementById('ditheringTypeSelect');
        if (ditheringTypeSelect) {
            ditheringTypeSelect.value = this.ditheringType;
        }

        // Initialize emoji processing mode button state
        const ditheringToggle = document.getElementById('emojiDitheringToggle');
        if (ditheringToggle) {
            ditheringToggle.classList.add('active');
            switch (this.emojiMode) {
                case 'dithering':
                    ditheringToggle.textContent = '🎨 Dithering';
                    break;
                case 'thresholding':
                    ditheringToggle.textContent = '⬜ Thresholding';
                    break;
                case 'edge':
                    ditheringToggle.textContent = '🔍 Edge Detection';
                    break;
            }
        }
        
        // Initialize dithering options container visibility
        const ditheringOptionsContainer = document.getElementById('ditheringOptionsContainer');
        if (ditheringOptionsContainer) {
            ditheringOptionsContainer.style.display = this.emojiMode === 'dithering' ? 'block' : 'none';
        }
        
        // Initialize brightness container visibility (show for all modes including edge detection)
        const brightnessContainer = document.getElementById('emojiBrightnessContainer');
        if (brightnessContainer) {
            brightnessContainer.style.display = 'block';
        }
    }

    populateEmojiGrid() {
        const emojiGrid = document.getElementById('emojiGrid');
        if (!emojiGrid || !this.emojiCategories[this.currentEmojiCategory]) {
            return;
        }

        // Clear existing emojis
        emojiGrid.innerHTML = '';

        // Add emojis for current category
        this.emojiCategories[this.currentEmojiCategory].forEach(emoji => {
            const emojiBtn = document.createElement('button');
            emojiBtn.className = 'emoji-btn';
            emojiBtn.textContent = emoji;
            emojiBtn.title = emoji;
            
            emojiBtn.addEventListener('click', (e) => {
                // Prevent click from bubbling up to document handlers
                e.stopPropagation();
                
                // Insert emoji at cursor position in text input
                const textInput = document.getElementById('textInput');
                if (textInput) {
                    const start = textInput.selectionStart;
                    const end = textInput.selectionEnd;
                    const currentText = textInput.value;
                    
                    const newText = currentText.substring(0, start) + emoji + currentText.substring(end);
                    textInput.value = newText;
                    this.textInput = newText;
                    
                    // Set cursor position after the inserted emoji
                    const newPosition = start + emoji.length;
                    textInput.setSelectionRange(newPosition, newPosition);
                    textInput.focus();
                    
                    // Update text preview
                    this.updateTextPreview();
                }
            });
            
            emojiGrid.appendChild(emojiBtn);
        });
    }

    // Helper method to render text with controlled letter spacing
    renderTextWithSpacing(ctx, text, x, y, minLetterSpacing = 1) {
        let currentX = x;
        
        // Split text into segments (regular text and emojis)
        const segments = this.parseTextWithEmojis(text);
        
        for (let segment of segments) {
            if (segment.isEmoji) {
                // Render emoji
                currentX += this.renderEmoji(ctx, segment.text, currentX, y);
            } else {
                // Render regular text character by character
                for (let i = 0; i < segment.text.length; i++) {
                    const char = segment.text[i];
                    
                    // Skip spaces - handle them with a fixed width
                    if (char === ' ') {
                        currentX += Math.max(this.fontSize * 0.3, minLetterSpacing * 2);
                        continue;
                    }
                    
                    // Render the character
                    ctx.fillText(char, Math.round(currentX), y);
                    
                    // Measure character width and add spacing
                    const charWidth = ctx.measureText(char).width;
                    currentX += Math.ceil(charWidth) + minLetterSpacing;
                }
            }
        }
        
        return currentX - x; // Return total width
    }

    // Helper method to measure text width with spacing
    measureTextWithSpacing(ctx, text, minLetterSpacing = 1) {
        let totalWidth = 0;
        
        // Split text into segments (regular text and emojis)
        const segments = this.parseTextWithEmojis(text);
        
        for (let segment of segments) {
            if (segment.isEmoji) {
                // Measure emoji width
                totalWidth += this.measureEmojiWidth(ctx, segment.text);
            } else {
                // Measure regular text
                for (let i = 0; i < segment.text.length; i++) {
                    const char = segment.text[i];
                    
                    if (char === ' ') {
                        totalWidth += Math.max(this.fontSize * 0.3, minLetterSpacing * 2);
                        continue;
                    }
                    
                    const charWidth = ctx.measureText(char).width;
                    totalWidth += Math.ceil(charWidth) + minLetterSpacing;
                }
            }
        }
        
        // Remove the extra spacing after the last character
        return Math.max(0, totalWidth - minLetterSpacing);
    }

    // Helper method to parse text and identify emojis vs regular text
    parseTextWithEmojis(text) {
        const segments = [];
        
        // Convert string to array of code points to handle surrogate pairs properly
        const codePoints = Array.from(text);
        let i = 0;
        
        while (i < codePoints.length) {
            const char = codePoints[i];
            
            if (this.isEmoji(char)) {
                // Handle emoji (might include modifiers and ZWJ sequences)
                const emojiResult = this.getEmojiSequence(codePoints, i);
                segments.push({
                    text: emojiResult.emoji,
                    isEmoji: true
                });
                i += emojiResult.length;
            } else {
                // Handle regular text
                let regularText = '';
                while (i < codePoints.length && !this.isEmoji(codePoints[i])) {
                    regularText += codePoints[i];
                    i++;
                }
                if (regularText) {
                    segments.push({
                        text: regularText,
                        isEmoji: false
                    });
                }
            }
        }
        
        return segments;
    }


    // Helper method to detect if a character is an emoji
    // Uses comprehensive regex pattern to match all emojis including complex sequences
    isEmoji(char) {
        // Comprehensive emoji regex pattern
        const emojiRegex = /(\u00a9|\u00ae|[\u2000-\u3300]|\ud83c[\ud000-\udfff]|\ud83d[\ud000-\udfff]|\ud83e[\ud000-\udfff])/;
        return emojiRegex.test(char);
    }

    // Helper method to get complete emoji sequence including modifiers and ZWJ sequences
    getEmojiSequence(codePoints, startIndex) {
        let i = startIndex;
        let emoji = '';
        
        // Start with the base emoji
        emoji += codePoints[i];
        const baseCode = codePoints[i].codePointAt(0);
        i++;
        
        // Check if this is a black flag (U+1F3F4) - subdivision flags use this with tag sequences
        if (baseCode === 0x1F3F4) {
            // Continue collecting tag characters (U+E0000 - U+E007F)
            while (i < codePoints.length) {
                const code = codePoints[i].codePointAt(0);
                if (code >= 0xE0000 && code <= 0xE007F) {
                    emoji += codePoints[i];
                    i++;
                    // U+E007F is the cancel tag that ends the sequence
                    if (code === 0xE007F) break;
                } else {
                    break;
                }
            }
            return {
                emoji: emoji,
                length: i - startIndex
            };
        }
        
        // Check if this is a regional indicator symbol (country flag emoji)
        // Regional indicators are in range 0x1F1E6 - 0x1F1FF
        if (baseCode >= 0x1F1E6 && baseCode <= 0x1F1FF) {
            // Flags are made of two regional indicator symbols
            if (i < codePoints.length) {
                const nextCode = codePoints[i].codePointAt(0);
                if (nextCode >= 0x1F1E6 && nextCode <= 0x1F1FF) {
                    emoji += codePoints[i];
                    i++;
                }
            }
            return {
                emoji: emoji,
                length: i - startIndex
            };
        }
        
        // Continue collecting modifiers, variation selectors, and ZWJ sequences
        while (i < codePoints.length) {
            const char = codePoints[i];
            const code = char.codePointAt(0);
            
            // Skin tone modifiers
            if (code >= 0x1F3FB && code <= 0x1F3FF) {
                emoji += char;
                i++;
            }
            // Variation selector for emoji presentation
            else if (code === 0xFE0F) {
                emoji += char;
                i++;
            }
            // Zero-width joiner sequences
            else if (code === 0x200D) {
                emoji += char;
                i++;
                // Add the next character after ZWJ if it exists and is an emoji-related character
                if (i < codePoints.length) {
                    const nextChar = codePoints[i];
                    emoji += nextChar;
                    i++;
                    
                    // Check for variation selector after the ZWJ sequence component
                    if (i < codePoints.length && codePoints[i].codePointAt(0) === 0xFE0F) {
                        emoji += codePoints[i];
                        i++;
                    }
                }
            }
            else {
                break;
            }
        }
        
        return {
            emoji: emoji,
            length: i - startIndex
        };
    }

    // Helper method to render a single emoji with brightness/contrast adjustments and optional dithering
    renderEmoji(ctx, emoji, x, y) {
        // Create temporary canvas for emoji rendering and processing
        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
        
        // Configure font first to measure text
        const emojiFont = `${this.fontSize}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Android Emoji", "EmojiSymbols", "EmojiOne Mozilla", "Twemoji Mozilla", "Segoe UI Symbol", sans-serif`;
        tempCtx.font = emojiFont;
        
        // Measure text to get appropriate canvas size
        const metrics = tempCtx.measureText(emoji);
        const textWidth = Math.max(metrics.width, this.fontSize);
        const textHeight = this.fontSize * 1.2; // Account for ascenders/descenders
        
        // Set canvas size without padding
        tempCanvas.width = textWidth;
        tempCanvas.height = textHeight;
        
        // Render emoji at 90% size to prevent edge clipping
        const renderSize = Math.floor(this.fontSize * 0.9);
        const smallerEmojiFont = `${renderSize}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Android Emoji", "EmojiSymbols", "EmojiOne Mozilla", "Twemoji Mozilla", "Segoe UI Symbol", sans-serif`;
        
        // Reconfigure after setting canvas size
        tempCtx.font = smallerEmojiFont;
        tempCtx.textBaseline = 'middle';
        tempCtx.textAlign = 'center';
        
        // DON'T fill with white - leave transparent so we can use the emoji's actual alpha channel
        // Clear to transparent
        tempCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);
        
        // Render emoji centered in the canvas
        tempCtx.fillStyle = '#000000';
        tempCtx.fillText(emoji, tempCanvas.width / 2, tempCanvas.height / 2);
        
        // Get image data and create mask from the emoji's actual alpha channel
        const originalImageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
        const maskCanvas = document.createElement('canvas');
        const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
        maskCanvas.width = tempCanvas.width;
        maskCanvas.height = tempCanvas.height;
        
        // Create mask using the emoji's actual alpha channel
        const maskImageData = maskCtx.createImageData(tempCanvas.width, tempCanvas.height);
        for (let i = 0; i < originalImageData.data.length; i += 4) {
            const alpha = originalImageData.data[i + 3];
            
            // Use the actual alpha channel from the emoji rendering
            // If alpha is very low (transparent background), mark as transparent in mask
            // If alpha is high (emoji pixels), mark as opaque in mask
            if (alpha < 10) {
                // Transparent background
                maskImageData.data[i] = 0;     // R
                maskImageData.data[i + 1] = 0; // G
                maskImageData.data[i + 2] = 0; // B
                maskImageData.data[i + 3] = 0; // A (transparent)
            } else {
                // Emoji pixel - keep it
                maskImageData.data[i] = 255;     // R
                maskImageData.data[i + 1] = 255; // G
                maskImageData.data[i + 2] = 255; // B
                maskImageData.data[i + 3] = alpha; // Use original alpha
            }
        }
        maskCtx.putImageData(maskImageData, 0, 0);
        
        // Get image data for processing
        const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
        
        // Apply brightness and processing based on selected mode
        let processedImageData;
        switch (this.emojiMode) {
            case 'dithering':
                processedImageData = this.processEmojiImage(imageData, maskImageData);
                break;
            case 'thresholding':
                processedImageData = this.thresholdEmojiImage(imageData, maskImageData);
                break;
            case 'edge':
                processedImageData = this.applyEdgeDetection(imageData, maskImageData);
                break;
            default:
                processedImageData = this.processEmojiImage(imageData, maskImageData);
        }
        
        // Put processed data back to temp canvas
        tempCtx.putImageData(processedImageData, 0, 0);
        
        // Calculate aspect ratio to preserve emoji proportions
        const aspectRatio = tempCanvas.width / tempCanvas.height;
        const drawWidth = this.fontSize * aspectRatio;
        const drawHeight = this.fontSize;
        
        // Draw processed emoji to main canvas, preserving aspect ratio
        ctx.drawImage(tempCanvas, 0, 0, tempCanvas.width, tempCanvas.height, x, y, drawWidth, drawHeight);
        
        return drawWidth + 2; // Return width for spacing
    }    // Process emoji image with brightness, contrast, and dithering
    processEmojiImage(imageData, maskData) {
        const data = imageData.data;
        const width = imageData.width;
        const height = imageData.height;
        const mask = maskData ? maskData.data : null;

        // First pass: convert to grayscale and apply brightness/contrast
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const index = (y * width + x) * 4;

                // Check mask - if masked pixel is transparent, keep original pixel transparent
                if (mask && mask[index + 3] === 0) {
                    data[index] = 0;     // R
                    data[index + 1] = 0; // G
                    data[index + 2] = 0; // B
                    data[index + 3] = 0; // A
                    continue;
                }

                const r = data[index];
                const g = data[index + 1];
                const b = data[index + 2];
                const alpha = data[index + 3];

                // Skip fully transparent pixels
                if (alpha < 10) {
                    data[index] = 0;     // R
                    data[index + 1] = 0; // G
                    data[index + 2] = 0; // B
                    data[index + 3] = 0; // A
                    continue;
                }

                // Calculate luminance (proper grayscale conversion)
                let gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);

                // Apply brightness adjustment (-100 to +100, scaled to 0-255)
                gray = Math.max(0, Math.min(255, gray + (this.emojiBrightness * 255 / 100)));

                // Apply contrast adjustment (50% to 200%)
                const contrastFactor = this.emojiContrast / 100;
                gray = Math.max(0, Math.min(255, ((gray - 128) * contrastFactor) + 128));

                // Store the adjusted gray value
                data[index] = gray;     // R
                data[index + 1] = gray; // G
                data[index + 2] = gray; // B
                // Keep original alpha
            }
        }

        // Second pass: apply improved dithering
        return this.applyImprovedDithering(imageData, maskData);
    }

    // Apply simple thresholding to emoji image (no dithering)
    thresholdEmojiImage(imageData, maskData) {
        const data = imageData.data;
        const width = imageData.width;
        const height = imageData.height;
        const mask = maskData ? maskData.data : null;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const index = (y * width + x) * 4;

                // Check mask - if masked pixel is transparent, keep pixel transparent
                if (mask && mask[index + 3] === 0) {
                    data[index] = 0;     // R
                    data[index + 1] = 0; // G
                    data[index + 2] = 0; // B
                    data[index + 3] = 0; // A
                    continue;
                }

                const r = data[index];
                const g = data[index + 1];
                const b = data[index + 2];
                const alpha = data[index + 3];

                // Skip fully transparent pixels
                if (alpha === 0) {
                    continue;
                }

                // Calculate luminance (proper grayscale conversion)
                let gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);

                // Apply brightness adjustment (-100 to +100, scaled to 0-255)
                gray = Math.max(0, Math.min(255, gray + (this.emojiBrightness * 255 / 100)));

                // Apply contrast adjustment (50% to 200%)
                const contrastFactor = this.emojiContrast / 100;
                gray = Math.max(0, Math.min(255, ((gray - 128) * contrastFactor) + 128));

                // Simple thresholding: if above 128, white; else black
                const threshold = 128;
                const newGray = gray > threshold ? 255 : 0;

                // Set the pixel, preserving original alpha
                data[index] = newGray;     // R
                data[index + 1] = newGray; // G
                data[index + 2] = newGray; // B
                // Keep original alpha value
            }
        }

        return imageData;
    }

    // Apply edge detection using Sobel operator
    applyEdgeDetection(imageData, maskData) {
        const data = imageData.data;
        const width = imageData.width;
        const height = imageData.height;
        const mask = maskData ? maskData.data : null;
        
        // Store the original alpha channel to preserve emoji shape
        const originalAlpha = new Uint8ClampedArray(data.length / 4);
        for (let i = 0; i < originalAlpha.length; i++) {
            originalAlpha[i] = mask ? mask[i * 4 + 3] : data[i * 4 + 3];
        }
        
        // First pass: convert to grayscale with brightness/contrast adjustments
        const grayData = new Uint8ClampedArray(data.length);
        
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const index = (y * width + x) * 4;
                const pixelIndex = y * width + x;
                
                // Skip masked out pixels (transparent areas) - keep them transparent
                if (originalAlpha[pixelIndex] === 0) {
                    grayData[index] = 0;
                    grayData[index + 1] = 0;
                    grayData[index + 2] = 0;
                    grayData[index + 3] = 0;
                    continue;
                }
                
                const r = data[index];
                const g = data[index + 1];
                const b = data[index + 2];

                // Calculate luminance
                let gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);

                // Apply brightness adjustment
                gray = Math.max(0, Math.min(255, gray + (this.emojiBrightness * 255 / 100)));

                // Apply contrast adjustment
                const contrastFactor = this.emojiContrast / 100;
                gray = Math.max(0, Math.min(255, ((gray - 128) * contrastFactor) + 128));

                grayData[index] = gray;
                grayData[index + 1] = gray;
                grayData[index + 2] = gray;
                grayData[index + 3] = 255; // Temporary full alpha for processing
            }
        }

        // Second pass: apply Sobel edge detection
        const sobelData = new Uint8ClampedArray(data.length);
        
        // Helper function to get gray value at position
        // For transparent pixels, return the center pixel's value to avoid detecting edges at transparency boundaries
        const getGrayValue = (x, y, centerX, centerY) => {
            if (x < 0 || x >= width || y < 0 || y >= height) {
                // Return center pixel value to avoid edge detection at canvas boundaries
                const centerIdx = (centerY * width + centerX) * 4;
                return grayData[centerIdx];
            }
            const pixelIndex = y * width + x;
            if (originalAlpha[pixelIndex] === 0) {
                // Return center pixel value to avoid edge detection at transparency boundaries
                const centerIdx = (centerY * width + centerX) * 4;
                return grayData[centerIdx];
            }
            const idx = (y * width + x) * 4;
            return grayData[idx];
        };

        // Process all pixels
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const index = (y * width + x) * 4;
                const pixelIndex = y * width + x;

                // Use the ORIGINAL alpha - if it was transparent, keep it transparent
                if (originalAlpha[pixelIndex] === 0) {
                    sobelData[index] = 0;
                    sobelData[index + 1] = 0;
                    sobelData[index + 2] = 0;
                    sobelData[index + 3] = 0;
                    continue;
                }

                // Sobel X kernel
                const gx = 
                    -1 * getGrayValue(x - 1, y - 1, x, y) +
                     0 * getGrayValue(x, y - 1, x, y) +
                     1 * getGrayValue(x + 1, y - 1, x, y) +
                    -2 * getGrayValue(x - 1, y, x, y) +
                     0 * getGrayValue(x, y, x, y) +
                     2 * getGrayValue(x + 1, y, x, y) +
                    -1 * getGrayValue(x - 1, y + 1, x, y) +
                     0 * getGrayValue(x, y + 1, x, y) +
                     1 * getGrayValue(x + 1, y + 1, x, y);

                // Sobel Y kernel
                const gy = 
                    -1 * getGrayValue(x - 1, y - 1, x, y) +
                    -2 * getGrayValue(x, y - 1, x, y) +
                    -1 * getGrayValue(x + 1, y - 1, x, y) +
                     0 * getGrayValue(x - 1, y, x, y) +
                     0 * getGrayValue(x, y, x, y) +
                     0 * getGrayValue(x + 1, y, x, y) +
                     1 * getGrayValue(x - 1, y + 1, x, y) +
                     2 * getGrayValue(x, y + 1, x, y) +
                     1 * getGrayValue(x + 1, y + 1, x, y);

                // Calculate gradient magnitude
                const magnitude = Math.sqrt(gx * gx + gy * gy);
                
                // Use brightness to control edge detection threshold
                // Brightness range: -100 to 100
                // Lower brightness = lower threshold = more sensitive to edges (detects more)
                // Higher brightness = higher threshold = less sensitive to edges (detects fewer)
                // Map brightness to threshold: at -100 (min), threshold=20; at 100 (max), threshold=150
                const edgeThreshold = 85 + (this.emojiBrightness * 0.65);
                
                let invertedEdge;
                if (magnitude > edgeThreshold) {
                    // Detected an edge - make it darker
                    // Use brightness to control how dark the edges appear
                    // Lower brightness = darker edges, higher brightness = lighter edges
                    const edgeDarkness = 180 - (this.emojiBrightness + 100) * 0.8;
                    invertedEdge = Math.max(0, edgeDarkness);
                } else {
                    // No significant edge, set to white
                    invertedEdge = 255;
                }

                sobelData[index] = invertedEdge;
                sobelData[index + 1] = invertedEdge;
                sobelData[index + 2] = invertedEdge;
                sobelData[index + 3] = originalAlpha[pixelIndex]; // Use ORIGINAL alpha
            }
        }

        // Copy sobel data back to imageData
        for (let i = 0; i < data.length; i++) {
            data[i] = sobelData[i];
        }

        return imageData;
    }

    // Improved Floyd-Steinberg dithering with better error distribution
    applyImprovedDithering(imageData, maskData) {
        const data = imageData.data;
        const width = imageData.width;
        const height = imageData.height;
        const mask = maskData ? maskData.data : null;
        
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const index = (y * width + x) * 4;
                
                // Skip pixels that are masked out (transparent areas)
                if (mask && mask[index + 3] === 0) {
                    continue;
                }
                
                // Skip fully transparent pixels
                if (data[index + 3] === 0) continue;
                
                const oldGray = data[index]; // All RGB values are the same after preprocessing
                const originalAlpha = data[index + 3]; // Preserve original alpha
                
                // Apply fixed threshold for consistent dithering
                const threshold = 128;
                const newGray = oldGray > threshold ? 255 : 0;
                const error = oldGray - newGray;
                
                // Set the pixel, preserving original alpha
                data[index] = newGray;     // R
                data[index + 1] = newGray; // G
                data[index + 2] = newGray; // B
                // Keep original alpha value
                
                // Distribute error to neighboring pixels with improved coefficients
                this.distributeError(data, width, height, x, y, error, this.ditheringType, maskData);
            }
        }
        
        return imageData;
    }

    // Helper method to distribute dithering error to neighboring pixels
    distributeError(data, width, height, x, y, error, ditheringType, maskData) {
        const mask = maskData ? maskData.data : null;
        
        const distribute = (dx, dy, factor) => {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                const index = (ny * width + nx) * 4;
                // Don't distribute to masked-out pixels (transparent areas)
                if (mask && mask[index + 3] === 0) {
                    return;
                }
                if (data[index + 3] > 0) { // Only distribute to pixels with some opacity
                    const adjustment = error * factor;
                    data[index] = Math.max(0, Math.min(255, data[index] + adjustment));
                    data[index + 1] = Math.max(0, Math.min(255, data[index + 1] + adjustment));
                    data[index + 2] = Math.max(0, Math.min(255, data[index + 2] + adjustment));
                }
            }
        };

        switch (ditheringType) {
            case 'floyd-steinberg':
                // Standard Floyd-Steinberg error distribution pattern
                distribute(1, 0, 7/16);    // Right
                distribute(-1, 1, 3/16);   // Bottom-left
                distribute(0, 1, 5/16);    // Bottom
                distribute(1, 1, 1/16);    // Bottom-right
                break;
                
            case 'atkinson':
                // Atkinson dithering - distributes to 6 pixels with 1/8 each
                distribute(1, 0, 1/8);     // Right
                distribute(2, 0, 1/8);     // Right-right
                distribute(-1, 1, 1/8);    // Bottom-left
                distribute(0, 1, 1/8);     // Bottom
                distribute(1, 1, 1/8);     // Bottom-right
                distribute(0, 2, 1/8);     // Bottom-bottom
                break;
                
            case 'bilayer':
                // Bilayer dithering - simpler 2-pixel distribution
                distribute(1, 0, 1/2);     // Right
                distribute(0, 1, 1/2);     // Bottom
                break;
                
            default:
                // Default to Floyd-Steinberg
                distribute(1, 0, 7/16);
                distribute(-1, 1, 3/16);
                distribute(0, 1, 5/16);
                distribute(1, 1, 1/16);
        }
    }

    // Helper method to measure emoji width
    measureEmojiWidth(ctx, emoji) {
        // Create temporary canvas to measure emoji dimensions accurately
        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
        
        const emojiFont = `${this.fontSize}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Android Emoji", "EmojiSymbols", "EmojiOne Mozilla", "Twemoji Mozilla", "Segoe UI Symbol", sans-serif`;
        tempCtx.font = emojiFont;
        
        const metrics = tempCtx.measureText(emoji);
        const textWidth = Math.max(metrics.width, this.fontSize);
        const textHeight = this.fontSize * 1.2;
        
        // Calculate aspect ratio and return width that preserves it
        const aspectRatio = textWidth / textHeight;
        const drawWidth = this.fontSize * aspectRatio;
        
        return drawWidth + 2; // Add small spacing
    }

    // Apply Floyd-Steinberg dithering to convert color image to monochrome
    applyFloydSteinbergDithering(imageData) {
        const data = imageData.data;
        const width = imageData.width;
        const height = imageData.height;
        
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                
                // Skip transparent pixels
                if (data[idx + 3] === 0) continue;
                
                // Calculate grayscale value
                const oldPixel = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
                const newPixel = oldPixel < 128 ? 0 : 255;
                const error = oldPixel - newPixel;
                
                // Set new pixel value
                data[idx] = newPixel;     // R
                data[idx + 1] = newPixel; // G
                data[idx + 2] = newPixel; // B
                // Keep original alpha
                
                // Distribute error to neighboring pixels
                if (x + 1 < width) {
                    const rightIdx = (y * width + (x + 1)) * 4;
                    data[rightIdx] = Math.max(0, Math.min(255, data[rightIdx] + error * 7 / 16));
                    data[rightIdx + 1] = Math.max(0, Math.min(255, data[rightIdx + 1] + error * 7 / 16));
                    data[rightIdx + 2] = Math.max(0, Math.min(255, data[rightIdx + 2] + error * 7 / 16));
                }
                
                if (y + 1 < height) {
                    if (x - 1 >= 0) {
                        const bottomLeftIdx = ((y + 1) * width + (x - 1)) * 4;
                        data[bottomLeftIdx] = Math.max(0, Math.min(255, data[bottomLeftIdx] + error * 3 / 16));
                        data[bottomLeftIdx + 1] = Math.max(0, Math.min(255, data[bottomLeftIdx + 1] + error * 3 / 16));
                        data[bottomLeftIdx + 2] = Math.max(0, Math.min(255, data[bottomLeftIdx + 2] + error * 3 / 16));
                    }
                    
                    const bottomIdx = ((y + 1) * width + x) * 4;
                    data[bottomIdx] = Math.max(0, Math.min(255, data[bottomIdx] + error * 5 / 16));
                    data[bottomIdx + 1] = Math.max(0, Math.min(255, data[bottomIdx + 1] + error * 5 / 16));
                    data[bottomIdx + 2] = Math.max(0, Math.min(255, data[bottomIdx + 2] + error * 5 / 16));
                    
                    if (x + 1 < width) {
                        const bottomRightIdx = ((y + 1) * width + (x + 1)) * 4;
                        data[bottomRightIdx] = Math.max(0, Math.min(255, data[bottomRightIdx] + error * 1 / 16));
                        data[bottomRightIdx + 1] = Math.max(0, Math.min(255, data[bottomRightIdx + 1] + error * 1 / 16));
                        data[bottomRightIdx + 2] = Math.max(0, Math.min(255, data[bottomRightIdx + 2] + error * 1 / 16));
                    }
                }
            }
        }
        
        return imageData;
    }

    async detectSystemFonts() {
        try {
            // List of common system fonts to test
            const commonFonts = [
                // Windows fonts
                'Arial', 'Arial Black', 'Calibri', 'Cambria', 'Comic Sans MS', 'Consolas', 
                'Courier New', 'Georgia', 'Impact', 'Lucida Console', 'Lucida Sans Unicode',
                'Microsoft Sans Serif', 'Palatino Linotype', 'Segoe UI', 'Tahoma', 
                'Times New Roman', 'Trebuchet MS', 'Verdana',
                
                // macOS fonts
                'Apple Chancery', 'Apple Color Emoji', 'Apple SD Gothic Neo', 'Avenir', 
                'Avenir Next', 'Big Caslon', 'Brush Script MT', 'Chalkboard', 'Chalkboard SE',
                'Cochin', 'Copperplate', 'Didot', 'Futura', 'Geneva', 'Gill Sans', 
                'Helvetica', 'Helvetica Neue', 'Herculanum', 'Hoefler Text', 'Marker Felt',
                'Menlo', 'Monaco', 'Noteworthy', 'Optima', 'Papyrus', 'Phosphate', 
                'Rockwell', 'Signpainter', 'Skia', 'Snell Roundhand', 'System Font',
                
                // Linux fonts
                'DejaVu Sans', 'DejaVu Serif', 'DejaVu Sans Mono', 'Liberation Sans', 
                'Liberation Serif', 'Liberation Mono', 'Ubuntu', 'Ubuntu Mono', 'Droid Sans',
                'Droid Serif', 'Droid Sans Mono', 'Noto Sans', 'Noto Serif', 'Noto Mono',
                
                // Generic/Web fonts
                'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy'
            ];

            const availableFonts = await this.checkFontAvailability(commonFonts);
            this.populateFontDropdown(availableFonts);
        } catch (error) {
            console.error('Font detection failed:', error);
            alert('Font detection failed. Using default fonts.');
        }
    }

    async checkFontAvailability(fonts) {
        const availableFonts = [];
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        
        // Test string and baseline font
        const testString = 'mmmmmmmmmmmmmmm';
        const baselineFont = 'monospace';
        
        // Get baseline width
        ctx.font = '16px ' + baselineFont;
        const baselineWidth = ctx.measureText(testString).width;
        
        for (const font of fonts) {
            try {
                // Test with the font
                ctx.font = `16px "${font}", ${baselineFont}`;
                const testWidth = ctx.measureText(testString).width;
                
                // If width differs from baseline, font is likely available
                if (Math.abs(testWidth - baselineWidth) > 0.1) {
                    availableFonts.push(font);
                } else {
                    // Additional check using font face API if available
                    if ('fonts' in document) {
                        try {
                            const fontFace = new FontFace(font, `local("${font}")`);
                            await fontFace.load();
                            availableFonts.push(font);
                        } catch (e) {
                            // Font not available
                        }
                    }
                }
            } catch (e) {
                // Skip problematic fonts
                continue;
            }
        }
        
        return availableFonts;
    }

    populateFontDropdown(fonts) {
        const fontSelect = document.getElementById('fontFamily');
        if (!fontSelect) return;
        
        // Store current selection
        const currentFont = fontSelect.value;
        
        // Clear all existing options
        fontSelect.innerHTML = '';
        
        // Filter out generic fonts and common duplicates
        const filteredFonts = fonts.filter(font => {
            // Skip generic font families
            if (['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy'].includes(font)) {
                return false;
            }
            return true;
        });
        
        // Add detected fonts (sorted alphabetically)
        filteredFonts.sort().forEach(font => {
            const option = document.createElement('option');
            option.value = font;
            option.textContent = font;
            fontSelect.appendChild(option);
        });
        
        // Restore selection or default to first option
        if (filteredFonts.length > 0) {
            fontSelect.value = fonts.includes(currentFont) ? currentFont : fontSelect.options[0].value;
        }
        
        console.log(`Auto-detected ${filteredFonts.length} system fonts`);
    }

    updateTextPreview() {
        // Update text preview if text tool is active and we're placing text
        if (this.currentTool === 'text' && this.isPlacingText) {
            this.generateTextCanvas();
            this.redrawCanvas();
        }
    }

    generateTextCanvas() {
        // Create a canvas with the text rendered
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        
        // Set canvas size to be large enough for text
        canvas.width = this.canvasWidth;
        canvas.height = this.canvasHeight;
        
        // Configure text style
        let fontStyle = '';
        if (this.textBold) fontStyle += 'bold ';
        if (this.textItalic) fontStyle += 'italic ';
        
        ctx.font = `${fontStyle}${this.fontSize}px ${this.fontFamily}`;
        ctx.fillStyle = this.textColor;
        ctx.textBaseline = 'top';
        
        // Split text into lines
        const lines = this.textInput.split('\n');
        const lineHeight = Math.round(this.fontSize * 1.0); // Use 1.0 for pixel-perfect spacing
        
        // Measure text dimensions with controlled spacing
        let maxWidth = 0;
        const lineWidths = [];
        
        lines.forEach(line => {
            const lineWidth = this.measureTextWithSpacing(ctx, line, 1); // 1px minimum spacing
            lineWidths.push(lineWidth);
            maxWidth = Math.max(maxWidth, lineWidth);
        });
        
        const totalHeight = Math.ceil(lines.length * lineHeight);
        
        // Store text data for later use
        this.textPreviewData = {
            text: this.textInput,
            lines: lines,
            lineWidths: lineWidths,
            width: maxWidth,
            height: totalHeight,
            lineHeight: lineHeight,
            font: ctx.font,
            color: this.textColor
        };
        
        // Store canvas for rendering
        this.textPreviewCanvas = canvas;
    }

    // === LAYER SYSTEM METHODS ===
    
    toggleLayersMode() {
        this.layersEnabled = document.getElementById('layersEnabled').checked;
        const layersPanel = document.getElementById('layersPanel');
        const canvasArea = document.querySelector('.canvas-area');
        const mobileToolbar = document.querySelector('.mobile-bottom-toolbar');
        const toolsPanel = document.querySelector('.tools-panel');
        const exportPanel = document.querySelector('.export-panel');
        
        if (this.layersEnabled) {
            // If animation panel is open, close it first
            if (this.animationEnabled) {
                document.getElementById('animationEnabled').checked = false;
                this.toggleAnimationMode();
            }
            
            // Show layers panel
            layersPanel.style.display = 'flex';
            
            // Add classes to adjust layout
            if (canvasArea) canvasArea.classList.add('with-layers');
            if (mobileToolbar) mobileToolbar.classList.add('with-layers');
            if (toolsPanel) toolsPanel.classList.add('with-layers');
            if (exportPanel) exportPanel.classList.add('with-layers');
            
            // Initialize layers for current frame if not already done
            if (!this.frameLayers[this.currentFrameIndex]) {
                this.initializeLayersForFrame(this.currentFrameIndex);
            }
            
            // Undo/redo stacks are preserved - snapshots support cross-mode restoration
            
            // Update layers UI
            this.updateLayersUI();
        } else {
            // Hide layers panel (but keep layer data intact)
            layersPanel.style.display = 'none';
            
            // Remove layout adjustment classes
            if (canvasArea) canvasArea.classList.remove('with-layers');
            if (mobileToolbar) mobileToolbar.classList.remove('with-layers');
            if (toolsPanel) toolsPanel.classList.remove('with-layers');
            if (exportPanel) exportPanel.classList.remove('with-layers');
            
            // Composite all layers to their frame canvases so they're visible in non-layer mode
            // This preserves the visual appearance while hiding the layer system
            Object.keys(this.frameLayers).forEach(frameIndex => {
                this.compositeLayersToFrame(parseInt(frameIndex));
            });
            
            // Note: We intentionally DON'T call flattenAllFrames() or delete frameLayers
            // This preserves all layer data so it can be restored when layers are re-enabled
            
            // Undo/redo stacks are preserved - snapshots support cross-mode restoration
        }
        
        this.redrawCanvas();
    }
    
    toggleAnimationMode() {
        this.animationEnabled = document.getElementById('animationEnabled').checked;
        const animationPanel = document.getElementById('animationPanel');
        const canvasArea = document.querySelector('.canvas-area');
        const mobileToolbar = document.querySelector('.mobile-bottom-toolbar');
        const toolsPanel = document.querySelector('.tools-panel');
        const exportPanel = document.querySelector('.export-panel');
        
        if (this.animationEnabled) {
            // If layers panel is open, close it first
            if (this.layersEnabled) {
                document.getElementById('layersEnabled').checked = false;
                this.toggleLayersMode();
            }
            
            // Show animation panel
            animationPanel.style.display = 'flex';
            
            // Add classes to adjust layout
            if (canvasArea) canvasArea.classList.add('with-animation');
            if (mobileToolbar) mobileToolbar.classList.add('with-animation');
            if (toolsPanel) toolsPanel.classList.add('with-animation');
            if (exportPanel) exportPanel.classList.add('with-animation');
            
            // Update animation UI
            this.updateAnimationUI();
        } else {
            // Hide animation panel
            animationPanel.style.display = 'none';
            
            // Remove layout adjustment classes
            if (canvasArea) canvasArea.classList.remove('with-animation');
            if (mobileToolbar) mobileToolbar.classList.remove('with-animation');
            if (toolsPanel) toolsPanel.classList.remove('with-animation');
            if (exportPanel) exportPanel.classList.remove('with-animation');
        }
        
        this.redrawCanvas();
    }
    
    updateAnimationUI() {
        const framesList = document.getElementById('framesList');
        if (!framesList) {
            console.error('framesList element not found');
            return;
        }
        
        if (!this.frames || this.frames.length === 0) {
            console.warn('No frames available for animation UI');
            framesList.innerHTML = '<div style="padding: 20px; text-align: center;">No frames available</div>';
            return;
        }
        
        framesList.innerHTML = '';
        
        this.frames.forEach((frame, index) => {
            const thumbDiv = document.createElement('div');
            thumbDiv.className = `frame-thumb ${index === this.currentFrameIndex ? 'active' : ''}`;
            thumbDiv.dataset.frame = index;
            
            const canvas = document.createElement('canvas');
            canvas.className = 'thumb-canvas';
            canvas.width = 80; // Smaller for animation panel
            canvas.height = 80;
            
            const label = document.createElement('span');
            label.className = 'frame-label';
            label.textContent = `${index}`;
            
            thumbDiv.appendChild(canvas);
            thumbDiv.appendChild(label);
            
            // Add click handler to switch frames
            thumbDiv.addEventListener('click', () => {
                this.setCurrentFrame(index);
            });
            
            framesList.appendChild(thumbDiv);
            
            // Draw thumbnail
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.imageSmoothingEnabled = false;
            ctx.clearRect(0, 0, 80, 80);
            ctx.drawImage(frame, 0, 0, 80, 80);
        });
        
        // Update animation controls
        this.updateAnimationControls();
    }
    
    updateAnimationControls() {
        // Sync with existing animation controls
        const animPlayBtn = document.getElementById('animPlayBtn');
        const animCycleMode = document.getElementById('animCycleMode');
        const animBoomerangMode = document.getElementById('animBoomerangMode');
        const animFrameRate = document.getElementById('animFrameRate');
        const animFrameRateDisplay = document.getElementById('animFrameRateDisplay');
        const animOnionSkinToggle = document.getElementById('animOnionSkinToggle');
        const animOnionOpacityDisplay = document.getElementById('animOnionOpacityDisplay');
        
        // Sync with main controls
        const mainPlayBtn = document.getElementById('playBtn');
        const mainCycleMode = document.getElementById('cycleMode');
        const mainBoomerangMode = document.getElementById('boomerangMode');
        const mainFrameRate = document.getElementById('frameRate');
        const mainOnionSkinToggle = document.getElementById('onionSkinToggle');
        const mainOnionOpacity = document.getElementById('onionOpacity');
        
        if (animPlayBtn && mainPlayBtn) {
            animPlayBtn.textContent = mainPlayBtn.textContent;
        }
        
        if (animCycleMode && mainCycleMode) {
            animCycleMode.classList.toggle('active', mainCycleMode.classList.contains('active'));
        }
        
        if (animBoomerangMode && mainBoomerangMode) {
            animBoomerangMode.classList.toggle('active', mainBoomerangMode.classList.contains('active'));
        }
        
        if (animFrameRate && mainFrameRate) {
            animFrameRate.value = mainFrameRate.value;
        }
        
        if (animFrameRateDisplay && mainFrameRate) {
            animFrameRateDisplay.textContent = mainFrameRate.value;
        }
        
        if (animOnionSkinToggle && mainOnionSkinToggle) {
            animOnionSkinToggle.classList.toggle('active', mainOnionSkinToggle.classList.contains('active'));
            
            // Sync container visibility
            const animOpacityContainer = document.getElementById('animOnionOpacityContainer');
            const opacityContainer = document.getElementById('onionOpacityContainer');
            if (animOpacityContainer && opacityContainer) {
                const isActive = mainOnionSkinToggle.classList.contains('active');
                const display = isActive ? 'flex' : 'none';
                animOpacityContainer.style.display = display;
                opacityContainer.style.display = display;
            }
        }
        
        if (animOnionOpacityDisplay && mainOnionOpacity) {
            animOnionOpacityDisplay.textContent = mainOnionOpacity.value + '%';
        }
        
        // Sync onion mode toggle button
        const animModeToggle = document.getElementById('animOnionModeToggle');
        const mainBlackOnWhite = document.getElementById('onionModeBlackOnWhite');
        const mainWhiteOnBlack = document.getElementById('onionModeWhiteOnBlack');
        
        if (animModeToggle && mainBlackOnWhite && mainWhiteOnBlack) {
            const isBlackOnWhite = mainBlackOnWhite.classList.contains('active');
            const mode = isBlackOnWhite ? 'blackOnWhite' : 'whiteOnBlack';
            const text = isBlackOnWhite ? 'B/W' : 'W/B';
            
            animModeToggle.setAttribute('data-mode', mode);
            animModeToggle.textContent = text;
        }
    }

    setCurrentFrame(frameIndex) {
        if (frameIndex < 0 || frameIndex >= this.frames.length) {
            return; // Invalid frame index
        }
        
        this.currentFrameIndex = frameIndex;
        
        // Redraw canvas with new frame
        this.redrawCanvas();
        
        // Update code output
        this.generateCode();
        
        // Update frame thumbnails to show active state
        this.updateFrameUI();
        
        // Update animation panel if it's open
        if (this.animationEnabled) {
            this.updateAnimationUI();
        }
        
        // Update layers UI if layers are enabled
        if (this.layersEnabled) {
            this.updateLayersUI();
        }
    }

    updateFrameUI() {
        // Update main frame thumbnails list
        this.updateFrameList();
        
        // Update frame counter display
        document.getElementById('currentFrame').textContent = this.currentFrameIndex + 1;
        document.getElementById('totalFrames').textContent = this.frames.length;
    }

    initializeLayersForFrame(frameIndex) {
        const frameCanvas = this.frames[frameIndex];
        
        // Create initial layer with current frame content
        const layer1 = {
            name: '0',
            canvas: document.createElement('canvas'),
            visible: true,
            transparencyMode: 'white' // 'white' or 'black' - white by default
        };
        layer1.canvas.width = this.canvasWidth;
        layer1.canvas.height = this.canvasHeight;
        
        // Copy current frame content to layer 1
        const ctx = layer1.canvas.getContext('2d', { willReadFrequently: true });
        
        // First fill with white
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, this.canvasWidth, this.canvasHeight);
        
        // Then draw frame content on top
        ctx.drawImage(frameCanvas, 0, 0);
        
        // Store layers in a separate structure indexed by frame
        if (!this.frameLayers) {
            this.frameLayers = {};
        }
        this.frameLayers[frameIndex] = {
            layers: [layer1],
            currentLayerIndex: 0
        };
        
        // Clear main frame canvas (will be composited from layers)
        const frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });
        frameCtx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
    }
    
    updateLayersUI() {
        const layersList = document.getElementById('layersList');
        layersList.innerHTML = '';
        
        const frameData = this.frameLayers && this.frameLayers[this.currentFrameIndex];
        if (!frameData) return;
        
        // Create layer items in normal order (left to right = Layer 0 to Layer N)
        // This makes new layers appear on the right side
        for (let i = 0; i < frameData.layers.length; i++) {
            const layer = frameData.layers[i];
            const layerItem = document.createElement('div');
            layerItem.className = 'layer-item';
            if (i === frameData.currentLayerIndex) {
                layerItem.classList.add('active');
            }
            if (!layer.visible) {
                layerItem.classList.add('layer-hidden');
            }
            if (this.soloLayerIndex === i) {
                layerItem.classList.add('layer-solo');
            }
            
            // Create preview canvas
            const preview = document.createElement('div');
            preview.className = 'layer-preview';
            const previewCanvas = document.createElement('canvas');
            previewCanvas.width = layer.canvas.width;
            previewCanvas.height = layer.canvas.height;
            const previewCtx = previewCanvas.getContext('2d', { willReadFrequently: true });
            previewCtx.drawImage(layer.canvas, 0, 0);
            preview.appendChild(previewCanvas);
            
            // Create layer info
            const info = document.createElement('div');
            info.className = 'layer-info';
            
            const nameSpan = document.createElement('span');
            nameSpan.className = 'layer-name';
            nameSpan.textContent = layer.name;
            
            const visibilityBtn = document.createElement('button');
            visibilityBtn.className = 'layer-visibility';
            visibilityBtn.textContent = layer.visible ? '👁️' : '👁️‍🗨️';
            visibilityBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleLayerVisibility(i);
            });
            
            const soloBtn = document.createElement('button');
            soloBtn.className = 'layer-solo-btn';
            soloBtn.textContent = 'S';
            soloBtn.title = 'Solo this layer (hide all others)';
            if (this.soloLayerIndex === i) {
                soloBtn.classList.add('active');
            }
            soloBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleSoloLayer(i);
            });
            
            const transparencyBtn = document.createElement('button');
            transparencyBtn.className = 'layer-transparency-btn';
            transparencyBtn.textContent = layer.transparencyMode === 'white' ? '⚪' : '⚫';
            transparencyBtn.title = `Transparency: ${layer.transparencyMode === 'white' ? 'White' : 'Black'}. Click to toggle.`;
            transparencyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleLayerTransparency(i);
            });
            
            info.appendChild(nameSpan);
            info.appendChild(visibilityBtn);
            info.appendChild(soloBtn);
            
            // Only show transparency button for layers above the bottom layer
            if (i > 0) {
                info.appendChild(transparencyBtn);
            }
            
            layerItem.appendChild(preview);
            layerItem.appendChild(info);
            
            // Click to select layer
            layerItem.addEventListener('click', () => {
                this.selectLayer(i);
            });
            
            layersList.appendChild(layerItem);
        }
        
        // Update button states
        document.getElementById('deleteLayer').disabled = frameData.layers.length <= 1;
        document.getElementById('moveLayerLeft').disabled = frameData.currentLayerIndex === 0;
        document.getElementById('moveLayerRight').disabled = frameData.currentLayerIndex === frameData.layers.length - 1;
        document.getElementById('mergeDown').disabled = frameData.currentLayerIndex === 0;
    }
    
    selectLayer(layerIndex) {
        const frameData = this.frameLayers && this.frameLayers[this.currentFrameIndex];
        if (!frameData) return;
        frameData.currentLayerIndex = layerIndex;
        this.updateLayersUI();
        this.redrawCanvas();
    }
    
    selectPreviousLayer() {
        const frameData = this.frameLayers && this.frameLayers[this.currentFrameIndex];
        if (!frameData || frameData.layers.length <= 1) return;
        
        const newIndex = frameData.currentLayerIndex - 1;
        if (newIndex >= 0) {
            frameData.currentLayerIndex = newIndex;
            this.updateLayersUI();
            this.redrawCanvas();
        }
    }
    
    selectNextLayer() {
        const frameData = this.frameLayers && this.frameLayers[this.currentFrameIndex];
        if (!frameData || frameData.layers.length <= 1) return;
        
        const newIndex = frameData.currentLayerIndex + 1;
        if (newIndex < frameData.layers.length) {
            frameData.currentLayerIndex = newIndex;
            this.updateLayersUI();
            this.redrawCanvas();
        }
    }
    
    toggleSoloLayer(layerIndex) {
        // Toggle solo mode for the clicked layer
        if (this.soloLayerIndex === layerIndex) {
            // Exit solo mode
            this.soloLayerIndex = null;
        } else {
            // Enter solo mode for this layer
            this.soloLayerIndex = layerIndex;
            // Also select this layer
            const frameData = this.frameLayers && this.frameLayers[this.currentFrameIndex];
            if (frameData) {
                frameData.currentLayerIndex = layerIndex;
            }
        }
        this.updateLayersUI();
        this.redrawCanvas();
    }
    
    toggleLayerVisibility(layerIndex) {
        const frameData = this.frameLayers && this.frameLayers[this.currentFrameIndex];
        if (!frameData) return;
        const layer = frameData.layers[layerIndex];
        layer.visible = !layer.visible;
        this.updateLayersUI();
        this.compositeLayersToFrame();
        this.redrawCanvas();
    }
    
    toggleLayerTransparency(layerIndex) {
        const frameData = this.frameLayers && this.frameLayers[this.currentFrameIndex];
        if (!frameData) return;
        const layer = frameData.layers[layerIndex];
        layer.transparencyMode = layer.transparencyMode === 'white' ? 'black' : 'white';
        this.updateLayersUI();
        this.compositeLayersToFrame();
        this.redrawCanvas();
    }
    
    toggleCurrentLayerTransparency() {
        const frameData = this.frameLayers && this.frameLayers[this.currentFrameIndex];
        if (!frameData) return;
        
        // Don't allow toggling transparency on the bottom layer (layer 0)
        if (frameData.currentLayerIndex === 0) {
            return;
        }
        
        const layer = frameData.layers[frameData.currentLayerIndex];
        layer.transparencyMode = layer.transparencyMode === 'white' ? 'black' : 'white';
        this.updateLayersUI();
        this.compositeLayersToFrame();
        this.redrawCanvas();
        this.generateCode();
    }
    
    addLayer() {
        const frameData = this.frameLayers && this.frameLayers[this.currentFrameIndex];
        if (!frameData) {
            this.initializeLayersForFrame(this.currentFrameIndex);
            return;
        }
        
        const newLayer = {
            name: `${frameData.layers.length}`,
            canvas: document.createElement('canvas'),
            visible: true,
            transparencyMode: 'white' // Default to white transparency
        };
        newLayer.canvas.width = this.canvasWidth;
        newLayer.canvas.height = this.canvasHeight;
        
        // Fill new layer with white by default
        const ctx = newLayer.canvas.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, this.canvasWidth, this.canvasHeight);
        
        // Use command pattern for undo support
        const command = new AddLayerCommand(this, this.currentFrameIndex, newLayer);
        this.executeCommand(command);
    }
    
    deleteLayer() {
        const frameData = this.frameLayers && this.frameLayers[this.currentFrameIndex];
        if (!frameData || frameData.layers.length <= 1) return;
        
        if (confirm(`Delete ${frameData.layers[frameData.currentLayerIndex].name}?`)) {
            const layerIndex = frameData.currentLayerIndex;
            const layerData = frameData.layers[layerIndex];
            
            // Clone the layer canvas for undo
            const clonedLayer = {
                name: layerData.name,
                canvas: document.createElement('canvas'),
                visible: layerData.visible,
                transparencyMode: layerData.transparencyMode || 'white'
            };
            clonedLayer.canvas.width = layerData.canvas.width;
            clonedLayer.canvas.height = layerData.canvas.height;
            const ctx = clonedLayer.canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(layerData.canvas, 0, 0);
            
            // Use command pattern for undo support
            const command = new DeleteLayerCommand(this, this.currentFrameIndex, layerIndex, clonedLayer);
            this.executeCommand(command);
        }
    }
    
    moveLayerLeft() {
        const frameData = this.frameLayers && this.frameLayers[this.currentFrameIndex];
        if (!frameData || frameData.layers.length <= 1) return;
        
        const currentIndex = frameData.currentLayerIndex;
        
        // Can't move left if already at the leftmost position
        if (currentIndex <= 0) return;
        
        this.swapLayers(currentIndex, currentIndex - 1);
    }
    
    moveLayerRight() {
        const frameData = this.frameLayers && this.frameLayers[this.currentFrameIndex];
        if (!frameData || frameData.layers.length <= 1) return;
        
        const currentIndex = frameData.currentLayerIndex;
        
        // Can't move right if already at the rightmost position
        if (currentIndex >= frameData.layers.length - 1) return;
        
        this.swapLayers(currentIndex, currentIndex + 1);
    }
    
    swapLayers(indexA, indexB) {
        const frameData = this.frameLayers && this.frameLayers[this.currentFrameIndex];
        if (!frameData || indexA === indexB) return;
        
        // Save current state for undo
        this.captureSnapshot();
        
        // Swap the layers
        const temp = frameData.layers[indexA];
        frameData.layers[indexA] = frameData.layers[indexB];
        frameData.layers[indexB] = temp;
        
        // Update current layer index to follow the moved layer
        if (frameData.currentLayerIndex === indexA) {
            frameData.currentLayerIndex = indexB;
        } else if (frameData.currentLayerIndex === indexB) {
            frameData.currentLayerIndex = indexA;
        }
        
        // Update solo layer index if needed
        if (this.soloLayerIndex === indexA) {
            this.soloLayerIndex = indexB;
        } else if (this.soloLayerIndex === indexB) {
            this.soloLayerIndex = indexA;
        }
        
        // Update UI and redraw
        this.updateLayersUI();
        this.compositeLayersToFrame(this.currentFrameIndex);
        this.redrawCanvas();
        this.markAsUnsaved();
        
        // Push to undo stack
        this.pushUndo();
    }
    
    mergeLayerDown() {
        const frameData = this.frameLayers && this.frameLayers[this.currentFrameIndex];
        if (!frameData || frameData.currentLayerIndex === 0) return;
        
        const layerIndex = frameData.currentLayerIndex;
        const currentLayer = frameData.layers[layerIndex];
        const belowLayer = frameData.layers[layerIndex - 1];
        
        // Clone the top layer for undo
        const clonedTopLayer = {
            name: currentLayer.name,
            canvas: document.createElement('canvas'),
            visible: currentLayer.visible
        };
        clonedTopLayer.canvas.width = currentLayer.canvas.width;
        clonedTopLayer.canvas.height = currentLayer.canvas.height;
        const topCtx = clonedTopLayer.canvas.getContext('2d', { willReadFrequently: true });
        topCtx.drawImage(currentLayer.canvas, 0, 0);
        
        // Snapshot bottom layer before merge
        const bottomCtx = belowLayer.canvas.getContext('2d', { willReadFrequently: true });
        const bottomSnapshot = bottomCtx.getImageData(0, 0, belowLayer.canvas.width, belowLayer.canvas.height);
        
        // Use command pattern for undo support
        const command = new MergeLayerCommand(this, this.currentFrameIndex, layerIndex, clonedTopLayer, bottomSnapshot);
        this.executeCommand(command);
    }
    
    copyLayerToFrames() {
        const frameData = this.frameLayers && this.frameLayers[this.currentFrameIndex];
        if (!frameData) return;
        
        const currentLayer = frameData.layers[frameData.currentLayerIndex];
        const layerIndex = frameData.currentLayerIndex;
        
        if (this.frames.length === 1) {
            alert('Only one frame exists. Create more frames to copy layers between them.');
            return;
        }
        
        // Show the modal
        const modal = document.getElementById('copyLayerModal');
        const frameCheckboxList = document.getElementById('frameCheckboxList');
        const layerNameSpan = document.getElementById('copyLayerName');
        
        // Set layer name in modal
        layerNameSpan.textContent = currentLayer.name;
        
        // Clear previous checkboxes
        frameCheckboxList.innerHTML = '';
        
        // Create checkbox for each frame (except current)
        this.frames.forEach((_, i) => {
            if (i !== this.currentFrameIndex) {
                const checkboxWrapper = document.createElement('div');
                checkboxWrapper.style.cssText = 'display: flex; align-items: center; padding: 8px; border-bottom: 1px solid #eee; cursor: pointer;';
                checkboxWrapper.onmouseover = function() { this.style.background = '#f5f5f5'; };
                checkboxWrapper.onmouseout = function() { this.style.background = 'white'; };
                
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.id = `frame-checkbox-${i}`;
                checkbox.value = i;
                checkbox.style.cssText = 'margin-right: 10px; width: 18px; height: 18px; cursor: pointer;';
                
                const label = document.createElement('label');
                label.htmlFor = `frame-checkbox-${i}`;
                label.textContent = `Frame ${i}`;
                label.style.cssText = 'cursor: pointer; flex: 1; user-select: none;';
                
                // Make the whole row clickable
                checkboxWrapper.onclick = function() {
                    checkbox.checked = !checkbox.checked;
                };
                
                checkboxWrapper.appendChild(checkbox);
                checkboxWrapper.appendChild(label);
                frameCheckboxList.appendChild(checkboxWrapper);
            }
        });
        
        // Set up select/deselect all buttons
        document.getElementById('selectAllFrames').onclick = () => {
            frameCheckboxList.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
        };
        
        document.getElementById('deselectAllFrames').onclick = () => {
            frameCheckboxList.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
        };
        
        // Set up confirm button
        document.getElementById('confirmCopyLayer').onclick = () => {
            const selectedFrames = Array.from(frameCheckboxList.querySelectorAll('input[type="checkbox"]:checked'))
                .map(cb => parseInt(cb.value));
            
            if (selectedFrames.length === 0) {
                alert('Please select at least one frame!');
                return;
            }
            
            // Copy layer to selected frames
            selectedFrames.forEach(frameIndex => {
                const targetFrame = this.frameLayers[frameIndex];
                
                // Initialize layers if needed
                if (!targetFrame) {
                    this.initializeLayersForFrame(frameIndex);
                }
                
                const targetData = this.frameLayers[frameIndex];
                
                // Create new layer
                const newLayer = {
                    name: currentLayer.name,
                    canvas: document.createElement('canvas'),
                    visible: currentLayer.visible
                };
                newLayer.canvas.width = this.canvasWidth;
                newLayer.canvas.height = this.canvasHeight;
                const ctx = newLayer.canvas.getContext('2d', { willReadFrequently: true });
                ctx.drawImage(currentLayer.canvas, 0, 0);
                
                // Insert or replace at same index
                if (layerIndex < targetData.layers.length) {
                    targetData.layers[layerIndex] = newLayer;
                } else {
                    targetData.layers.push(newLayer);
                }
                
                // Composite the layers to the frame canvas
                this.compositeLayersToFrame(frameIndex);
                
                // Generate thumbnail for this frame
                this.generateThumbnail(frameIndex);
            });
            
            // Close modal and show success message
            modal.style.display = 'none';
            alert(`Layer copied to ${selectedFrames.length} frame(s)`);
            
            // Mark as unsaved and update code
            this.markAsUnsaved();
            this.generateCode();
        };
        
        // Show the modal
        modal.style.display = 'block';
    }
    
    compositeLayersToFrame(frameIndex = null) {
        const targetFrameIndex = frameIndex !== null ? frameIndex : this.currentFrameIndex;
        const frameData = this.frameLayers && this.frameLayers[targetFrameIndex];
        
        if (!frameData) return;
        
        const frameCanvas = this.frames[targetFrameIndex];
        
        // Get context with proper settings
        const ctx = frameCanvas.getContext('2d', { willReadFrequently: true });
        
        // Ensure proper compositing mode and fill with white background
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1.0;
        
        // Fill with WHITE instead of clearing to transparent!
        // This ensures the bottom layer has something to composite onto
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, this.canvasWidth, this.canvasHeight);
        
        // If in solo mode, only draw the solo layer
        if (this.soloLayerIndex !== null && this.soloLayerIndex < frameData.layers.length) {
            const soloLayer = frameData.layers[this.soloLayerIndex];
            // In solo mode, draw layer directly without transparency processing
            ctx.drawImage(soloLayer.canvas, 0, 0);
        } else {
            // Draw visible layers in order (bottom to top)
            frameData.layers.forEach((layer, index) => {
                if (layer.visible) {
                    // Bottom layer (index 0) should NOT have transparency applied
                    if (index === 0) {
                        // Draw bottom layer directly - no transparency processing
                        ctx.drawImage(layer.canvas, 0, 0);
                    } else {
                        // Upper layers use transparency
                        this.drawLayerWithTransparency(ctx, layer);
                    }
                }
            });
        }
    }
    
    drawLayerWithTransparency(ctx, layer) {
        const transparencyMode = layer.transparencyMode || 'white';
        
        // Get layer pixel data
        const layerCtx = layer.canvas.getContext('2d', { willReadFrequently: true });
        const layerImageData = layerCtx.getImageData(0, 0, this.canvasWidth, this.canvasHeight);
        const layerData = layerImageData.data;
        
        // Create a temporary canvas for the layer with transparency applied
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = this.canvasWidth;
        tempCanvas.height = this.canvasHeight;
        const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
        const tempImageData = tempCtx.createImageData(this.canvasWidth, this.canvasHeight);
        const tempData = tempImageData.data;
        
        // Copy pixels, making the transparency color transparent
        for (let i = 0; i < layerData.length; i += 4) {
            const r = layerData[i];
            const g = layerData[i + 1];
            const b = layerData[i + 2];
            const a = layerData[i + 3];
            
            // Skip already transparent pixels
            if (a === 0) {
                tempData[i] = 0;
                tempData[i + 1] = 0;
                tempData[i + 2] = 0;
                tempData[i + 3] = 0;
                continue;
            }
            
            // Check if pixel matches transparency color (only for opaque pixels)
            let isTransparent = false;
            if (transparencyMode === 'white') {
                // White (255, 255, 255) is transparent
                isTransparent = (r >= 254 && g >= 254 && b >= 254);
            } else {
                // Black (0, 0, 0) is transparent
                isTransparent = (r <= 1 && g <= 1 && b <= 1);
            }
            
            if (isTransparent) {
                // Make pixel fully transparent
                tempData[i] = 0;
                tempData[i + 1] = 0;
                tempData[i + 2] = 0;
                tempData[i + 3] = 0;
            } else {
                // Copy pixel as-is
                tempData[i] = r;
                tempData[i + 1] = g;
                tempData[i + 2] = b;
                tempData[i + 3] = a;
            }
        }
        
        // Draw the processed image data to temp canvas
        tempCtx.putImageData(tempImageData, 0, 0);
        
        // Draw temp canvas to destination
        ctx.drawImage(tempCanvas, 0, 0);
    }
    
    flattenAllFrames() {
        // Merge all layers into main canvas for each frame
        this.frames.forEach((frameCanvas, i) => {
            const frameData = this.frameLayers && this.frameLayers[i];
            if (frameData) {
                const ctx = frameCanvas.getContext('2d', { willReadFrequently: true });
                ctx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
                
                frameData.layers.forEach(layer => {
                    if (layer.visible) {
                        ctx.drawImage(layer.canvas, 0, 0);
                    }
                });
                
                // Clear layers
                delete this.frameLayers[i];
            }
        });
    }
    
    getActiveCanvas() {
        // Return the canvas that should be drawn on
        if (this.layersEnabled) {
            const frameData = this.frameLayers && this.frameLayers[this.currentFrameIndex];
            if (frameData && frameData.layers[frameData.currentLayerIndex]) {
                return frameData.layers[frameData.currentLayerIndex].canvas;
            }
        }
        return this.frames[this.currentFrameIndex];
    }
    
    getActiveContext() {
        return this.getActiveCanvas().getContext('2d', { willReadFrequently: true });
    }

    flattenAllFrames() {
        // Merge all layers into main canvas for each frame
        if (!this.frameLayers) return;
        
        Object.keys(this.frameLayers).forEach(frameIndex => {
            const frameData = this.frameLayers[frameIndex];
            const frameCanvas = this.frames[frameIndex];
            const ctx = frameCanvas.getContext('2d', { willReadFrequently: true });
            ctx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
            
            frameData.layers.forEach(layer => {
                if (layer.visible) {
                    ctx.drawImage(layer.canvas, 0, 0);
                }
            });
        });
        
        // Clear layers
        this.frameLayers = {};
    }
    
    getActiveCanvas() {
        // Return the canvas that should be drawn on
        if (this.layersEnabled) {
            const frameData = this.frameLayers && this.frameLayers[this.currentFrameIndex];
            if (frameData && frameData.layers[frameData.currentLayerIndex]) {
                return frameData.layers[frameData.currentLayerIndex].canvas;
            }
        }
        return this.frames[this.currentFrameIndex];
    }
    
    getActiveContext() {
        return this.getActiveCanvas().getContext('2d', { willReadFrequently: true });
    }

    initializeEvents() {
        // Get the canvas container for panning/zooming events
        const canvasContainer = document.querySelector('.canvas-container');
        
        // Canvas mouse events - add to both drawing and overlay canvas
        [this.drawingCanvas, this.overlayCanvas].forEach(canvas => {
            canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
            canvas.addEventListener('mouseleave', (e) => this.onMouseLeave(e));
            
            // Add touch events
            canvas.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
            canvas.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
            canvas.addEventListener('touchend', (e) => this.onTouchEnd(e), { passive: false });
            canvas.addEventListener('touchcancel', (e) => this.onTouchEnd(e), { passive: false });
            
            // Prevent middle and right mouse button default behavior
            canvas.addEventListener('mousedown', (e) => {
                if (e.button === 1 || e.button === 2) {
                    e.preventDefault();
                }
            });
            
            // Prevent context menu
            canvas.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                return false;
            });
        });
        
        // Add global mousemove and mouseup to allow drawing outside canvas
        document.addEventListener('mousemove', (e) => this.onMouseMove(e));
        document.addEventListener('mouseup', (e) => this.onMouseUp(e));
        
        // Add scroll wheel zooming to the canvas container - this allows zooming anywhere in the container
        if (canvasContainer) {
            canvasContainer.addEventListener('wheel', (e) => this.onMouseWheel(e), { passive: false });
            
            // Add mousedown to container to allow starting shapes from outside canvas
            canvasContainer.addEventListener('mousedown', (e) => {
                // Only handle left click for drawing tools, skip if clicking on canvas (already handled above)
                if (e.button === 0 && e.target === canvasContainer) {
                    this.onMouseDown(e);
                }
                // Handle middle or right click for panning
                else if (e.button === 1 || (e.button === 2 && !this.isDrawing)) {
                    e.preventDefault();
                    this.startPanning(e);
                }
            });
            
            canvasContainer.addEventListener('mousemove', (e) => {
                if (this.isPanning) {
                    e.preventDefault();
                    this.updatePanning(e);
                }
            });
            
            canvasContainer.addEventListener('mouseup', (e) => {
                if (this.isPanning && (e.button === 1 || e.button === 2)) {
                    this.endPanning();
                }
            });
            
            // Add text tool support to canvas container (allows placing text outside canvas)
            canvasContainer.addEventListener('mousedown', (e) => {
                if (this.currentTool === 'text' && e.button === 0 && !this.isPlacingText) {
                    e.preventDefault();
                    const pos = this.getMousePosOutsideCanvas(e);
                    this.startTextPlacement(pos);
                }
            });
            
            canvasContainer.addEventListener('mousemove', (e) => {
                if (this.currentTool === 'text' && this.isPlacingText) {
                    const pos = this.getMousePosOutsideCanvas(e);
                    this.updateTextPreviewPosition(pos);
                }
            });
            
            canvasContainer.addEventListener('mouseup', (e) => {
                if (this.currentTool === 'text' && this.isPlacingText && e.button === 0) {
                    const pos = this.getMousePosOutsideCanvas(e);
                    this.finalizeText(pos);
                }
            });
            
            // Add touch support for text tool on canvas container
            canvasContainer.addEventListener('touchstart', (e) => {
                if (this.currentTool === 'text' && !this.isPlacingText) {
                    e.preventDefault();
                    const touch = e.touches[0] || e.changedTouches[0];
                    const mouseEvent = this.createMouseEventFromTouch(touch, 'mousedown');
                    const pos = this.getMousePosOutsideCanvas(mouseEvent);
                    this.startTextPlacement(pos);
                }
            }, { passive: false });
            
            canvasContainer.addEventListener('touchmove', (e) => {
                if (this.currentTool === 'text' && this.isPlacingText) {
                    e.preventDefault();
                    const touch = e.touches[0] || e.changedTouches[0];
                    const mouseEvent = this.createMouseEventFromTouch(touch, 'mousemove');
                    const pos = this.getMousePosOutsideCanvas(mouseEvent);
                    this.updateTextPreviewPosition(pos);
                }
            }, { passive: false });
            
            canvasContainer.addEventListener('touchend', (e) => {
                if (this.currentTool === 'text' && this.isPlacingText) {
                    e.preventDefault();
                    const touch = e.changedTouches[0];
                    const mouseEvent = this.createMouseEventFromTouch(touch, 'mouseup');
                    const pos = this.getMousePosOutsideCanvas(mouseEvent);
                    this.finalizeText(pos);
                }
            }, { passive: false });
            
            // Prevent context menu on the container
            canvasContainer.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                return false;
            });
        }
        
        // Add horizontal scrolling to layers list with mouse wheel
        const layersList = document.getElementById('layersList');
        if (layersList) {
            layersList.addEventListener('wheel', (e) => {
                // Prevent default vertical scroll behavior
                e.preventDefault();
                // Scroll horizontally based on wheel delta
                layersList.scrollLeft += e.deltaY;
            }, { passive: false });
        }
        
        // Add horizontal scrolling to animation frames list with mouse wheel
        const framesList = document.getElementById('framesList');
        if (framesList) {
            framesList.addEventListener('wheel', (e) => {
                // Prevent default vertical scroll behavior
                e.preventDefault();
                // Scroll horizontally based on wheel delta
                framesList.scrollLeft += e.deltaY;
            }, { passive: false });
        }
        
        // Add global mouse events to handle drawing outside canvas
        document.addEventListener('mousemove', (e) => {
            // Store the current mouse event for panning
            this.lastMouseEvent = e;
            
            // Handle panning regardless of mouse position with throttling
            if (this.isPanning) {
                // Throttle panning updates for better performance
                if (!this.panningThrottle) {
                    this.panningThrottle = requestAnimationFrame(() => {
                        this.updatePanning();
                        this.panningThrottle = null;
                    });
                }
                return;
            }

            // Handle previews for all tools when mouse is outside canvas
            if (!this.isDrawing) {
                const pos = this.getMousePos(e);
                
                // Show pen preview when hovering with pen tool (but not in spray mode)
                if (this.currentTool === 'pen' && !this.gridModeEnabled && this.penMode !== 'spray') {
                    this.showPenPreview(pos.x, pos.y);
                }
                
                // Show spray preview when hovering with spray mode
                if (this.currentTool === 'pen' && this.penMode === 'spray') {
                    this.showSprayPreview(pos.x, pos.y);
                }

                // Show fill preview when hovering with bucket tool
                if (this.currentTool === 'bucket') {
                    // Don't interfere if we're editing gradient settings
                    if (!this.isEditingGradientSettings) {
                        this.showFillPreview(pos.x, pos.y);
                    }
                }

                // Show paste preview when in paste mode (even while drawing/clicking)
                if (this.currentTool === 'select' && this.isPasteModeActive) {
                    // Allow paste preview to show even when partially off-canvas
                    this.showPastePreview(pos.x, pos.y);
                }
            }
            
            if (this.isDrawing && this.currentTool === 'pen' && !this.shiftKey && this.penMode !== 'line') {
                // Only handle normal pen drawing here, not straight lines (shift mode or line mode)
                // Check if mouse is over one of our canvases
                const canvasRect = this.drawingCanvas.getBoundingClientRect();
                const x = e.clientX - canvasRect.left;
                const y = e.clientY - canvasRect.top;
                
                // Convert to canvas coordinates
                const canvasX = Math.floor(x / this.zoom);
                const canvasY = Math.floor(y / this.zoom);
                
                // Check if current position is within canvas bounds
                const isWithinBounds = canvasX >= 0 && canvasX < this.canvasWidth && canvasY >= 0 && canvasY < this.canvasHeight;
                
                if (this.lastPos) {
                    // Check if either the start or end point is within canvas bounds
                    const startInBounds = this.lastPos.x >= 0 && this.lastPos.x < this.canvasWidth && 
                                         this.lastPos.y >= 0 && this.lastPos.y < this.canvasHeight;
                    const endInBounds = canvasX >= 0 && canvasX < this.canvasWidth && 
                                       canvasY >= 0 && canvasY < this.canvasHeight;
                    
                    // Only draw if at least one endpoint is within bounds (this creates a line that crosses the canvas)
                    if (startInBounds || endInBounds) {
                        const clamped = this.clampLineToCanvas(this.lastPos.x, this.lastPos.y, canvasX, canvasY);
                        
                        // Only draw if there's actually a visible line segment within canvas
                        if (clamped.x1 !== clamped.x2 || clamped.y1 !== clamped.y2) {
                            this.drawLine(clamped.x1, clamped.y1, clamped.x2, clamped.y2);
                        }
                    }
                    
                    // Always update last position regardless of bounds - this keeps the "virtual" drawing continuous
                    this.lastPos = {x: canvasX, y: canvasY};
                } else {
                    // Start tracking position regardless of bounds
                    this.lastPos = {x: canvasX, y: canvasY};
                }
            }

            // Handle drawing previews for other tools
            if (this.isDrawing) {
                const pos = this.getMousePos(e);
                
                // Handle straight line preview for pen tool with shift or in line mode
                if (this.currentTool === 'pen' && (this.shiftKey || this.penMode === 'line') && this.startPos) {
                    this.drawStraightLinePreview(this.startPos.x, this.startPos.y, pos.x, pos.y);
                }
                
                // Handle shape previews for circle, square, and polygon tools
                if ((this.currentTool === 'circle' || this.currentTool === 'square' || this.currentTool === 'polygon')) {
                    this.updateShapePreview(pos);
                }
            }
        });
        
        document.addEventListener('mouseup', (e) => {
            // Handle panning end regardless of mouse position
            if (this.isPanning) {
                this.endPanning();
            }
            
            if (this.isDrawing) {
                this.onMouseUp(e);
            }
        });
        
        // Canvas size change
        document.getElementById('canvasSize').addEventListener('change', (e) => {
            if (e.target.value === 'custom') {
                document.getElementById('customSize').style.display = 'flex';
            } else {
                document.getElementById('customSize').style.display = 'none';
                const [width, height] = e.target.value.split('x').map(n => parseInt(n));
                this.setCanvasSize(width, height);
            }
        });
        
        document.getElementById('applyCustomSize').addEventListener('click', () => {
            const width = parseInt(document.getElementById('customWidth').value);
            const height = parseInt(document.getElementById('customHeight').value);
            if (width > 0 && height > 0) {
                this.setCanvasSize(width, height);
            }
        });
        
        // Edit buttons
        document.getElementById('copyBtn').addEventListener('click', () => this.copy());
        document.getElementById('cutBtn').addEventListener('click', () => this.cut());
        document.getElementById('pasteModeBtn').addEventListener('click', () => this.togglePasteMode());
        
        // Transparency toggle
        document.getElementById('transparencyToggle').addEventListener('click', () => {
            this.toggleTransparencyMode();
        });
        
        // Rotation controls
        document.getElementById('rotationAngle').addEventListener('input', (e) => {
            document.getElementById('rotationAngleDisplay').textContent = e.target.value;
            this.updateRotationWarning(parseInt(e.target.value));
        });
        document.getElementById('rotateBtn').addEventListener('click', () => {
            const angle = parseInt(document.getElementById('rotationAngle').value);
            this.rotateSelectionByAngle(angle);
        });
        document.getElementById('resetRotationBtn').addEventListener('click', () => {
            document.getElementById('rotationAngle').value = '0';
            document.getElementById('rotationAngleDisplay').textContent = '0';
            this.updateRotationWarning(0);
        });
        
        // Export buttons
        document.getElementById('exportBtn').addEventListener('click', () => this.export());
        document.getElementById('copyCodeBtn').addEventListener('click', () => this.copyCode());
        
        // Asset name input
        document.getElementById('assetName').addEventListener('input', (e) => {
            this.validateAssetName(e.target);
            this.generateCode();
        });
        
        // Export format change - update default name and regenerate code
        document.getElementById('exportFormat').addEventListener('change', (e) => {
            this.updateAssetNameDefault(e.target.value);
            this.generateCode();
        });
        
        // File operations
        document.getElementById('newBtn').addEventListener('click', () => this.newDrawing());
        document.getElementById('saveBtn').addEventListener('click', () => this.save());
        document.getElementById('loadBtn').addEventListener('click', () => this.load());
        
        // Help button
        document.getElementById('helpBtn').addEventListener('click', () => this.showHelp());
        document.getElementById('closeHelp').addEventListener('click', () => this.hideHelp());
        
        // Close modal when clicking outside
        document.getElementById('helpModal').addEventListener('click', (e) => {
            if (e.target.id === 'helpModal') {
                this.hideHelp();
            }
        });
        
        // Zoom controls
        document.getElementById('zoomIn').addEventListener('click', () => this.setZoom(this.zoom * 1.5));
        document.getElementById('zoomOut').addEventListener('click', () => this.setZoom(this.zoom / 1.5));
        document.getElementById('actualSize').addEventListener('click', () => this.zoomToActualSize());
        document.getElementById('fitToScreen').addEventListener('click', () => this.fitToScreen());
        document.getElementById('centerCanvas').addEventListener('click', () => this.centerCanvas());
        
        // Pixel grid control
        document.getElementById('pixelGrid').addEventListener('change', () => this.togglePixelGrid());
        
        // Mirror drawing controls
        document.getElementById('mirrorHorizontal').addEventListener('click', () => this.toggleMirrorHorizontal());
        document.getElementById('mirrorVertical').addEventListener('click', () => this.toggleMirrorVertical());
        
        // Canvas transform controls
        document.getElementById('flipHorizontal').addEventListener('click', () => this.flipCanvasHorizontal());
        document.getElementById('flipVertical').addEventListener('click', () => this.flipCanvasVertical());
        document.getElementById('rotateLeft').addEventListener('click', () => this.rotateCanvas(-90));
        document.getElementById('rotateRight').addEventListener('click', () => this.rotateCanvas(90));
    }
    
    initializeMobileMenus() {
        // Mobile menu dropdown toggle
        const menuDropdown = document.getElementById('mobileMenuDropdown');
        
        if (menuDropdown) {
            menuDropdown.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleMobileDropdown('mobileMainMenu');
            });
        }
        
        // Mobile panel toggles - left and right buttons
        const toolsToggle = document.getElementById('mobileToolsToggle');
        const exportToggle = document.getElementById('mobileExportToggle');
        
        if (toolsToggle) {
            toolsToggle.addEventListener('click', () => {
                const toolsPanel = document.getElementById('toolsPanel');
                toolsPanel.classList.toggle('open');
                toolsToggle.classList.toggle('active');
                
                // Close export panel if it's open
                const exportPanel = document.getElementById('exportPanel');
                if (exportPanel.classList.contains('open')) {
                    exportPanel.classList.remove('open');
                    exportToggle.classList.remove('active');
                }
            });
        }
        
        if (exportToggle) {
            exportToggle.addEventListener('click', () => {
                const exportPanel = document.getElementById('exportPanel');
                exportPanel.classList.toggle('open');
                exportToggle.classList.toggle('active');
                
                // Close tools panel if it's open
                const toolsPanel = document.getElementById('toolsPanel');
                if (toolsPanel.classList.contains('open')) {
                    toolsPanel.classList.remove('open');
                    toolsToggle.classList.remove('active');
                }
            });
        }
        
        // Mobile bottom bar controls
        const mobileGridBtn = document.getElementById('mobileGridBtn');
        const mobileZoomIn = document.getElementById('mobileZoomIn');
        const mobileZoomOut = document.getElementById('mobileZoomOut');
        const mobileFitBtn = document.getElementById('mobileFitBtn');
        const mobileCenterBtn = document.getElementById('mobileCenterBtn');
        
        if (mobileGridBtn) {
            mobileGridBtn.addEventListener('click', () => {
                this.toggleGrid();
                mobileGridBtn.classList.toggle('active');
            });
        }
        
        if (mobileZoomIn) {
            mobileZoomIn.addEventListener('click', () => {
                this.setZoom(this.zoom * 1.5);
                this.updateMobileZoomDisplay();
            });
        }
        
        if (mobileZoomOut) {
            mobileZoomOut.addEventListener('click', () => {
                this.setZoom(this.zoom / 1.5);
                this.updateMobileZoomDisplay();
            });
        }
        
        if (mobileFitBtn) {
            mobileFitBtn.addEventListener('click', () => {
                this.fitToScreen();
                this.updateMobileZoomDisplay();
            });
        }
        
        if (mobileCenterBtn) {
            mobileCenterBtn.addEventListener('click', () => {
                this.centerCanvas();
            });
        }
        
        // Handle clicks outside dropdowns to close them
        document.addEventListener('click', () => this.closeMobileDropdowns());
        
        // Handle window resize to manage mobile state
        window.addEventListener('resize', () => this.handleMobileResize());
        
        // Initialize mobile state - ensure panels start collapsed
        this.handleMobileResize();
        
        // Ensure panels start collapsed on mobile
        if (window.innerWidth <= 768) {
            const toolsPanel = document.getElementById('toolsPanel');
            const exportPanel = document.getElementById('exportPanel');
            if (toolsPanel) toolsPanel.classList.remove('open');
            if (exportPanel) exportPanel.classList.remove('open');
            if (toolsToggle) toolsToggle.classList.remove('active');
            if (exportToggle) exportToggle.classList.remove('active');
        }
        
        // Initialize mobile zoom display
        this.updateMobileZoomDisplay();
    }
    
    updateMobileZoomDisplay() {
        const mobileZoomDisplay = document.getElementById('mobileZoomDisplay');
        if (mobileZoomDisplay) {
            mobileZoomDisplay.textContent = Math.round(this.zoom * 100 / 4) + '%';
        }
    }
    
    toggleMobileDropdown(menuId) {
        const menu = document.getElementById(menuId);
        if (menu) {
            const isActive = menu.classList.contains('active');
            // Close all dropdowns first
            this.closeMobileDropdowns();
            // Open this one if it wasn't already visible
            if (!isActive) {
                menu.classList.add('active');
            }
        }
    }
    
    closeMobileDropdowns() {
        const dropdowns = ['mobileMainMenu'];
        dropdowns.forEach(id => {
            const menu = document.getElementById(id);
            if (menu) {
                menu.classList.remove('active');
            }
        });
    }
    
    handleMobileResize() {
        // Handle mobile interface adjustments on resize
        if (window.innerWidth <= 768) {
            // Mobile mode
            if (!this.mobileInterface) {
                this.mobileInterface = new MobileInterface(this);
            }
        } else {
            // Desktop mode - hide mobile elements
            this.closeMobileDropdowns();
        }
    }
    
    initializeFrameSystem() {
        // Frame navigation
        document.getElementById('prevFrame').addEventListener('click', () => this.previousFrame());
        document.getElementById('nextFrame').addEventListener('click', () => this.nextFrame());
        document.getElementById('addFrame').addEventListener('click', () => this.addFrame());
        document.getElementById('copyFrame').addEventListener('click', () => this.copyFrame());
        document.getElementById('moveFrameLeft').addEventListener('click', () => this.moveFrameLeft());
        document.getElementById('moveFrameRight').addEventListener('click', () => this.moveFrameRight());
        document.getElementById('deleteFrame').addEventListener('click', () => this.deleteFrame());
        
        // Animation controls
        document.getElementById('playBtn').addEventListener('click', () => this.toggleAnimation());
        
        // Frame rate
        const frameRateSlider = document.getElementById('frameRate');
        frameRateSlider.addEventListener('input', () => {
            const fps = parseFloat(frameRateSlider.value);
            document.getElementById('frameRateDisplay').textContent = fps.toFixed(1);
            
            // Update code output with new frame rate
            this.generateCode();
            
            // If animation is playing, restart with new speed
            if (this.isPlaying) {
                clearInterval(this.animationInterval);
                this.animationInterval = setInterval(() => {
                    this.advanceFrame();
                    this.updateUI();
                    this.redrawCanvas();
                }, 1000 / fps);
            }
        });
        
        // Animation mode buttons
        // Animation mode buttons (Cycle/Boomerang) - use specific IDs
        document.getElementById('cycleMode')?.addEventListener('click', () => {
            this.setAnimationMode('cycle');
        });
        document.getElementById('boomerangMode')?.addEventListener('click', () => {
            this.setAnimationMode('boomerang');
        });
        
        // Shape fill mode buttons
        document.querySelectorAll('.fill-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setShapeFillMode(btn.dataset.fill);
            });
        });
        
        // Shape mode toggle button
        document.getElementById('shapeModeToggle').addEventListener('click', () => {
            this.cycleShapeMode();
        });
        
        // Shape thickness controls
        document.getElementById('shapeThicknessSlider').addEventListener('input', (e) => {
            this.shapeThickness = parseInt(e.target.value);
            document.getElementById('shapeThicknessDisplay').textContent = e.target.value;
        });
        
        // Shape stroke position buttons
        document.querySelectorAll('.style-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setShapeStrokePosition(btn.dataset.style);
            });
        });

        // Polygon controls
        // Polygon sides slider
        document.getElementById('polygonSides').addEventListener('input', (e) => {
            this.polygonSides = parseInt(e.target.value);
            document.getElementById('polygonSidesDisplay').textContent = e.target.value;
        });

        // Polygon fill mode buttons
        document.querySelectorAll('#polygonSettings .fill-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setPolygonFillMode(btn.dataset.fill);
            });
        });

        // Polygon thickness controls
        document.getElementById('polygonThicknessSlider').addEventListener('input', (e) => {
            this.polygonThickness = parseInt(e.target.value);
            document.getElementById('polygonThicknessDisplay').textContent = e.target.value;
        });

        // Polygon color selection
        document.querySelectorAll('#polygonSettings .color-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                // Remove active from all polygon color buttons
                document.querySelectorAll('#polygonSettings .color-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.currentColor = btn.dataset.color;
            });
        });
        
        // Onion skinning
        document.getElementById('onionSkinToggle').addEventListener('click', () => this.toggleOnionSkin());
        document.getElementById('onionOpacity').addEventListener('input', () => {
            const opacity = document.getElementById('onionOpacity').value;
            document.getElementById('onionOpacityDisplay').textContent = opacity;
            this.updateOnionSkin();
        });

        // Onion skin mode buttons
        document.getElementById('onionModeBlackOnWhite').addEventListener('click', () => this.setOnionMode('blackOnWhite'));
        document.getElementById('onionModeWhiteOnBlack').addEventListener('click', () => this.setOnionMode('whiteOnBlack'));
        
        // Clear canvas button
        document.getElementById('clearCanvas').addEventListener('click', () => this.clearCurrentFrame());
        
        // Undo/Redo buttons
        document.getElementById('undoBtn').addEventListener('click', () => this.undo());
        document.getElementById('redoBtn').addEventListener('click', () => this.redo());
        
        // Mirror & Transform toggle button
        document.getElementById('mirrorTransformToggle').addEventListener('click', () => this.toggleMirrorTransformSettings());
        
        // Fill Patterns toggle button
        document.getElementById('fillPatternsToggle').addEventListener('click', () => this.toggleFillPatternsSettings());
        
        // Animation toggle button
        document.getElementById('animationToggle').addEventListener('click', () => this.toggleAnimationSettings());
        
        // Layers system
        document.getElementById('layersEnabled').addEventListener('change', () => this.toggleLayersMode());
        document.getElementById('addLayer').addEventListener('click', () => this.addLayer());
        document.getElementById('deleteLayer').addEventListener('click', () => this.deleteLayer());
        document.getElementById('moveLayerLeft').addEventListener('click', () => this.moveLayerLeft());
        document.getElementById('moveLayerRight').addEventListener('click', () => this.moveLayerRight());
        document.getElementById('mergeDown').addEventListener('click', () => this.mergeLayerDown());
        document.getElementById('copyLayerToFrames').addEventListener('click', () => this.copyLayerToFrames());
        
        // Animation panel system
        document.getElementById('animationEnabled').addEventListener('change', () => this.toggleAnimationMode());
        
        // Animation panel buttons - connect to existing functions
        document.getElementById('animAddFrame').addEventListener('click', () => this.addFrame());
        document.getElementById('animDeleteFrame').addEventListener('click', () => this.deleteFrame());
        document.getElementById('animMoveLeft').addEventListener('click', () => this.moveFrameLeft());
        document.getElementById('animMoveRight').addEventListener('click', () => this.moveFrameRight());
        document.getElementById('animCopyFrame').addEventListener('click', () => this.copyFrame());
        document.getElementById('animPlayBtn').addEventListener('click', () => this.toggleAnimation());
        
        // Animation panel mode buttons
        document.getElementById('animCycleMode').addEventListener('click', () => {
            this.setAnimationMode('cycle');
            this.updateAnimationControls();
        });
        document.getElementById('animBoomerangMode').addEventListener('click', () => {
            this.setAnimationMode('boomerang');
            this.updateAnimationControls();
        });
        
        // Animation panel frame rate
        document.getElementById('animFrameRate').addEventListener('input', (e) => {
            const mainFrameRate = document.getElementById('frameRate');
            mainFrameRate.value = e.target.value;
            this.frameRate = parseFloat(e.target.value);
            document.getElementById('frameRateDisplay').textContent = e.target.value;
            document.getElementById('animFrameRateDisplay').textContent = e.target.value;
            if (this.isPlaying) {
                this.stopAnimation();
                this.startAnimation();
            }
        });
        
        // Animation panel onion skin
        document.getElementById('animOnionSkinToggle').addEventListener('click', () => {
            const mainOnionToggle = document.getElementById('onionSkinToggle');
            mainOnionToggle.click(); // Trigger the main toggle
            this.updateAnimationControls();
        });
        
        // Animation panel opacity controls
        document.getElementById('animOnionOpacityDecrease').addEventListener('click', () => {
            const mainOnionOpacity = document.getElementById('onionOpacity');
            const currentValue = parseInt(mainOnionOpacity.value);
            const newValue = Math.max(10, currentValue - 10);
            mainOnionOpacity.value = newValue;
            document.getElementById('onionOpacityDisplay').textContent = newValue;
            document.getElementById('animOnionOpacityDisplay').textContent = newValue + '%';
            this.onionOpacity = newValue;
            this.redrawCanvas();
        });
        
        document.getElementById('animOnionOpacityIncrease').addEventListener('click', () => {
            const mainOnionOpacity = document.getElementById('onionOpacity');
            const currentValue = parseInt(mainOnionOpacity.value);
            const newValue = Math.min(80, currentValue + 10);
            mainOnionOpacity.value = newValue;
            document.getElementById('onionOpacityDisplay').textContent = newValue;
            document.getElementById('animOnionOpacityDisplay').textContent = newValue + '%';
            this.onionOpacity = newValue;
            this.redrawCanvas();
        });
        
        // Animation panel onion mode toggle button
        document.getElementById('animOnionModeToggle').addEventListener('click', () => {
            const button = document.getElementById('animOnionModeToggle');
            const currentMode = button.getAttribute('data-mode');
            const newMode = currentMode === 'blackOnWhite' ? 'whiteOnBlack' : 'blackOnWhite';
            const newText = newMode === 'blackOnWhite' ? 'B/W' : 'W/B';
            
            button.setAttribute('data-mode', newMode);
            button.textContent = newText;
            
            this.setOnionMode(newMode);
            this.updateAnimationControls();
        });
        
        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => this.handleKeyboardShortcuts(e));
        
        // Import image functionality
        document.getElementById('importImageBtn').addEventListener('click', () => this.showImageImportModal());
        this.setupImageImporter();
    }
    
    handleKeyboardShortcuts(e) {
        // Prevent shortcuts when typing in inputs
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
            return;
        }
        
        // Handle F7 for layer panel toggle
        if (e.key === 'F7') {
            const layersCheckbox = document.getElementById('layersEnabled');
            layersCheckbox.checked = !layersCheckbox.checked;
            this.toggleLayersMode();
            e.preventDefault();
            return;
        }
        
        switch (e.key.toLowerCase()) {
            case 'p':
                // P: Pen tool (freehand)
                this.setTool('pen');
                this.penMode = 'freehand';
                this.updatePenModeButton();
                e.preventDefault();
                break;
            case 'l':
                if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
                    // Ctrl+Shift+L: Add new layer
                    if (this.layersEnabled) {
                        this.addLayer();
                        e.preventDefault();
                    }
                } else {
                    // L: Line tool
                    this.setTool('pen');
                    this.penMode = 'line';
                    this.updatePenModeButton();
                    e.preventDefault();
                }
                break;
            case 'c':
                if (e.ctrlKey || e.metaKey) {
                    this.copySelection();
                    e.preventDefault();
                } else {
                    // C: Circle tool
                    this.setTool('circle');
                    e.preventDefault();
                }
                break;
            case 'r':
                // R: Rectangle/Square tool
                this.setTool('square');
                e.preventDefault();
                break;
            case 'g':
                if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
                    // Future use for Ctrl+Shift+G
                } else {
                    // G: Grid pen mode
                    this.setTool('pen');
                    this.penMode = 'grid';
                    this.updatePenModeButton();
                    e.preventDefault();
                }
                break;
            case 's':
                if (e.ctrlKey || e.metaKey) {
                    this.saveDrawing();
                    e.preventDefault();
                } else {
                    // S: Spray tool
                    this.setTool('pen');
                    this.penMode = 'spray';
                    this.updatePenModeButton();
                    e.preventDefault();
                }
                break;
            case 'f':
                // F: Fill/Bucket tool
                this.setTool('bucket');
                e.preventDefault();
                break;
            case 'e':
                // E: sElect tool
                this.setTool('select');
                e.preventDefault();
                break;
            case 'm':
                // M: Hand tool (Move/pan)
                this.setTool('hand');
                e.preventDefault();
                break;
            case 'h':
                if (e.ctrlKey || e.metaKey) {
                    this.showHelp();
                    e.preventDefault();
                } else {
                    // H: Hand tool
                    this.setTool('hand');
                    e.preventDefault();
                }
                break;
            case 't':
                // T: Text tool
                this.setTool('text');
                e.preventDefault();
                break;
            case 'y':
                if (e.ctrlKey || e.metaKey) {
                    // Ctrl+Y for redo (Windows style)
                    this.redo();
                    e.preventDefault();
                } else {
                    // Y: PolYgon tool
                    this.setTool('polygon');
                    e.preventDefault();
                }
                break;
            case 'i':
                if (e.ctrlKey || e.metaKey) {
                    // Ctrl+I: Toggle transparency mode for current layer
                    if (this.layersEnabled) {
                        this.toggleCurrentLayerTransparency();
                        e.preventDefault();
                    }
                } else {
                    this.showImageImportModal();
                    e.preventDefault();
                }
                break;
            case 'z':
                if (e.ctrlKey || e.metaKey) {
                    if (e.shiftKey) {
                        // Ctrl+Shift+Z or Cmd+Shift+Z for redo
                        this.redo();
                    } else {
                        // Ctrl+Z or Cmd+Z for undo
                        this.undo();
                    }
                    e.preventDefault();
                }
                break;
            case 'o':
                if (e.ctrlKey || e.metaKey) {
                    this.loadDrawing();
                    e.preventDefault();
                }
                break;
            case 'n':
                if (e.ctrlKey || e.metaKey) {
                    if (e.shiftKey) {
                        // Ctrl+Shift+N: Add new layer
                        if (this.layersEnabled) {
                            this.addLayer();
                            e.preventDefault();
                        }
                    } else {
                        this.newDrawing();
                        e.preventDefault();
                    }
                }
                break;
            case 'v':
                if (e.ctrlKey || e.metaKey) {
                    this.paste();
                    e.preventDefault();
                }
                break;
            case 'x':
                if (e.ctrlKey || e.metaKey) {
                    this.cutSelection();
                    e.preventDefault();
                }
                break;
            case 'delete':
            case 'backspace':
                this.clearCurrentFrame();
                e.preventDefault();
                break;
            case 'arrowleft':
                this.previousFrame();
                e.preventDefault();
                break;
            case 'arrowright':
                this.nextFrame();
                e.preventDefault();
                break;
            case ' ':
                this.toggleAnimation();
                e.preventDefault();
                break;
            case '1':
            case '2':
            case '3':
            case '4':
            case '5':
            case '6':
            case '7':
            case '8':
            case '9':
                const num = parseInt(e.key);
                // For circle/square tools, number keys change fill mode
                if (this.currentTool === 'circle' || this.currentTool === 'square') {
                    const fillModeSelect = document.getElementById('fillMode');
                    if (num === 1) fillModeSelect.value = 'outline';
                    else if (num === 2) fillModeSelect.value = 'filled';
                    else if (num === 3) fillModeSelect.value = 'pattern';
                    this.updateFillMode();
                } 
                // For polygon tool, number keys change polygon sides
                else if (this.currentTool === 'polygon' && num >= 3) {
                    this.polygonSides = num;
                    document.getElementById('polygonSides').value = num;
                    document.getElementById('polygonSidesDisplay').textContent = num;
                }
                // For other tools, number keys change brush size
                else if (num <= 10) {
                    this.brushSize = num;
                    document.getElementById('brushSize').value = num;
                    document.getElementById('brushSizeDisplay').textContent = num;
                }
                e.preventDefault();
                break;
            case 'b':
                this.currentColor = 'black';
                this.updateColorButtons();
                e.preventDefault();
                break;
            case 'w':
                this.currentColor = 'white';
                this.updateColorButtons();
                e.preventDefault();
                break;
            case '+':
            case '=':
                this.zoomIn();
                e.preventDefault();
                break;
            case '-':
                this.zoomOut();
                e.preventDefault();
                break;
            case '0':
                this.fitToScreen();
                e.preventDefault();
                break;
            case '1':
                // Only trigger actual size zoom if not modifying a tool setting
                if (!this.isPenTool() && !this.isShapeTool() && this.currentTool !== 'polygon' && this.currentTool !== 'bucket') {
                    this.zoomToActualSize();
                    e.preventDefault();
                }
                break;
            case '.':
                this.centerCanvas();
                e.preventDefault();
                break;
            case '?':
                this.showHelp();
                e.preventDefault();
                break;
            case '[':
                // Switch to previous layer
                if (this.layersEnabled) {
                    this.selectPreviousLayer();
                    e.preventDefault();
                }
                break;
            case ']':
                // Switch to next layer
                if (this.layersEnabled) {
                    this.selectNextLayer();
                    e.preventDefault();
                }
                break;
            case 'escape':
                this.hideHelp();
                e.preventDefault();
                break;
        }
    }
    
    getMousePos(e) {
        const rect = this.drawingCanvas.getBoundingClientRect();
        const scaleX = this.canvasWidth / rect.width;
        const scaleY = this.canvasHeight / rect.height;
        
        let pos = {
            x: Math.floor((e.clientX - rect.left) * scaleX),
            y: Math.floor((e.clientY - rect.top) * scaleY)
        };
        
        // Apply grid snapping if grid mode is enabled
        if (this.gridModeEnabled) {
            pos = this.snapToGrid(pos);
        }
        
        return pos;
    }
    
    getMousePosOutsideCanvas(e) {
        const rect = this.drawingCanvas.getBoundingClientRect();
        const scaleX = this.canvasWidth / rect.width;
        const scaleY = this.canvasHeight / rect.height;
        
        let pos = {
            x: Math.floor((e.clientX - rect.left) * scaleX),
            y: Math.floor((e.clientY - rect.top) * scaleY)
        };
        
        // For text tool, allow positions outside canvas bounds
        // Don't clamp to canvas dimensions
        
        // Apply grid snapping if grid mode is enabled
        if (this.gridModeEnabled) {
            pos = this.snapToGrid(pos);
        }
        
        return pos;
    }
    
    snapToGrid(pos) {
        // Use the current grid size for snapping in grid mode
        const gridSize = this.gridModeEnabled ? this.gridSize : this.gridSize;
        return {
            x: Math.floor(pos.x / gridSize) * gridSize,
            y: Math.floor(pos.y / gridSize) * gridSize
        };
    }
    
    updateBrushControlsState() {
        const brushSizeSlider = document.getElementById('brushSize');
        const brushSizeDisplay = document.getElementById('brushSizeDisplay');
        const brushShapeButtons = document.querySelectorAll('.brush-shape-btn');
        const sprayFlowControl = document.getElementById('sprayFlowControl');
        
        if (this.gridModeEnabled) {
            // Keep brush controls enabled in grid mode - user should be able to adjust grid size
            if (brushSizeSlider) {
                brushSizeSlider.disabled = false;
                brushSizeSlider.style.opacity = '1';
            }
            if (brushSizeDisplay) {
                // Show current grid size and visibility status
                const gridVisible = (this.gridSize * this.zoom) >= 3 ? ' (Grid)' : ' (Grid - zoom to see lines)';
                brushSizeDisplay.textContent = `${this.gridSize}${gridVisible}`;
            }
            // Keep shape buttons enabled but they affect grid behavior
            brushShapeButtons.forEach(btn => {
                btn.disabled = false;
                btn.style.opacity = '1';
            });
            // Hide flow control
            if (sprayFlowControl) {
                sprayFlowControl.style.display = 'none';
            }
        } else if (this.penMode === 'spray') {
            // Spray mode - hide shape buttons, show flow control
            if (brushSizeSlider) {
                brushSizeSlider.disabled = false;
                brushSizeSlider.style.opacity = '1';
            }
            if (brushSizeDisplay) {
                brushSizeDisplay.textContent = this.brushSize;
            }
            // Hide shape buttons in spray mode
            brushShapeButtons.forEach(btn => {
                btn.disabled = true;
                btn.style.opacity = '0.3';
            });
            // Show flow control
            if (sprayFlowControl) {
                sprayFlowControl.style.display = 'block';
            }
        } else {
            // Normal brush mode
            if (brushSizeSlider) {
                brushSizeSlider.disabled = false;
                brushSizeSlider.style.opacity = '1';
            }
            if (brushSizeDisplay) {
                brushSizeDisplay.textContent = this.brushSize;
            }
            brushShapeButtons.forEach(btn => {
                btn.disabled = false;
                btn.style.opacity = '1';
            });
            // Hide flow control
            if (sprayFlowControl) {
                sprayFlowControl.style.display = 'none';
            }
        }
    }
    
    updateGridDisplay() {
        // Clear overlay and redraw base layers (which includes grid if appropriate)
        this.overlayCtx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
        this.drawBaseOverlays();
        
        if (this.gridModeEnabled && this.showGridLines) {
            console.log(`Grid enabled: size=${this.gridSize}, zoom=${this.zoom}`); // Debug
        } else {
            console.log('Grid disabled'); // Debug
        }
    }
    
    drawBaseOverlays() {
        // Draw grid mode lines if grid mode is enabled and zoom makes grid size >= 3 pixels on screen
        if (this.gridModeEnabled && this.showGridLines && (this.gridSize * this.zoom) >= 3) {
            this.drawGridLines();
        }
        
        // Draw pixel grid checkerboard if enabled (independent of grid mode)
        if (this.showPixelGrid && this.zoom >= 2) {
            this.drawPixelGridOnly();
        }
        
        // Note: Selection overlay is handled separately by drawSelectionOverlay()
        // to avoid circular dependencies in the overlay system
    }

    onMouseDown(e) {
        this.lastMouseEvent = e; // Store for panning
        
        // Handle middle mouse button (button 1) or right mouse button (button 2) for panning regardless of current tool
        if (e.button === 1 || e.button === 2) {
            e.preventDefault(); // Prevent browser's default behavior
            const pos = this.getMousePos(e);
            this.startPanning(pos);
            return;
        }
        
        if (e.button !== 0) return; // Only handle left mouse button for drawing tools
        
        const pos = this.getMousePos(e);
        this.lastPos = pos;
        this.startPos = pos; // Store start position for straight lines
        this.shiftKey = e.shiftKey;
        
        // Handle hand tool separately - don't set isDrawing
        if (this.currentTool === 'hand') {
            this.startPanning(pos);
            return;
        }
        
        this.isDrawing = true;
        
        switch (this.currentTool) {
            case 'pen':
                // Start stroke for undo system
                this.startStroke();
                // Only draw initial pixel if not holding Shift (for straight lines) and not in line mode
                if (!this.shiftKey && this.penMode !== 'line') {
                    this.drawPixel(pos.x, pos.y);
                }
                
                // Start continuous spray if in spray mode
                if (this.penMode === 'spray') {
                    this.startContinuousSpray(pos);
                }
                break;
            case 'circle':
                this.startShape('circle', pos);
                break;
            case 'square':
                this.startShape('square', pos);
                break;
            case 'polygon':
                this.startShape('polygon', pos);
                break;
            case 'bucket':
                this.executeFloodFill(pos.x, pos.y);
                break;
            case 'text':
                this.startTextPlacement(pos);
                break;
            case 'select':
                if (this.isPasteModeActive) {
                    // Start tracking for potential drag-to-paste
                    this.pasteDragActive = true;
                    this.pasteDragStartTime = Date.now();
                    this.pasteDragStartX = pos.x;
                    this.pasteDragStartY = pos.y;
                    // Don't paste immediately - wait to see if it's a drag or quick click
                } else {
                    this.startSelection(pos.x, pos.y);
                }
                break;
        }
        
        this.updateMousePosition(pos);
    }
    
    onMouseLeave(e) {
        // Stop continuous spray when leaving canvas
        this.stopContinuousSpray();
        
        // When mouse leaves, restore the proper overlay state without cursor highlights
        // This will preserve grids, selections, and other overlays
        this.restoreOverlayState();
        
        // If we're using the select tool and have an active selection, redraw the selection overlay
        // to keep the selection preview visible even when mouse is outside canvas
        if (this.currentTool === 'select' && this.selection && this.selection.active) {
            this.drawSelectionOverlay();
        }
    }
    
    onMouseWheel(e) {
        e.preventDefault();
        
        // Ctrl+Wheel: Change brush size or polygon sides
        if (e.ctrlKey || e.metaKey) {
            if (this.currentTool === 'polygon') {
                // Change polygon sides
                const delta = e.deltaY > 0 ? -1 : 1;
                this.polygonSides = Math.max(3, Math.min(20, this.polygonSides + delta));
                document.getElementById('polygonSides').value = this.polygonSides;
                document.getElementById('polygonSidesDisplay').textContent = this.polygonSides;
            } else {
                // Change brush size
                const delta = e.deltaY > 0 ? -1 : 1;
                this.brushSize = Math.max(1, Math.min(10, this.brushSize + delta));
                document.getElementById('brushSize').value = this.brushSize;
                document.getElementById('brushSizeDisplay').textContent = this.brushSize;
            }
            return;
        }
        
        // Zoom in/out based on wheel direction
        const zoomFactor = 1.1;
        const oldZoom = this.zoom;
        let newZoom;
        
        if (e.deltaY < 0) {
            // Zoom in
            newZoom = oldZoom * zoomFactor;
        } else {
            // Zoom out
            newZoom = oldZoom / zoomFactor;
        }
        
        // Constrain zoom levels (max 10,000% = 100x)
        newZoom = Math.max(0.5, Math.min(newZoom, 100));
        
        // Debug: Track mouse position before zoom
        const canvasRect = this.drawingCanvas.getBoundingClientRect();
        const mouseX = e.clientX - canvasRect.left;
        const mouseY = e.clientY - canvasRect.top;
        
        // Calculate canvas coordinates (logical pixel position on canvas)
        const canvasX = mouseX / oldZoom;
        const canvasY = mouseY / oldZoom;
        
        // Step 3: Apply zoom change (this changes canvas display size)
        this.zoom = newZoom;

        
        // Step 4: Reposition canvas to keep mouse cursor at same logical position
        const canvasWrapper = document.querySelector('.canvas-wrapper');
        if (canvasWrapper) {
            // Temporarily disable transitions for instant repositioning
            canvasWrapper.style.transition = 'none';
            
            // Calculate new position to keep mouse at same logical coordinates
            // mouse_screen = canvas_offset + (canvas_logical_coords * new_zoom)
            // So: new_canvas_offset = mouse_screen - (canvas_logical_coords * new_zoom)
            
            const containerRect = document.querySelector('.canvas-container').getBoundingClientRect();
            const mouseScreenX = e.clientX - containerRect.left;
            const mouseScreenY = e.clientY - containerRect.top;
            
            const newLeft = mouseScreenX - (canvasX * newZoom);
            const newTop = mouseScreenY - (canvasY * newZoom);
            
            canvasWrapper.style.left = newLeft + 'px';
            canvasWrapper.style.top = newTop + 'px';
            canvasWrapper.style.transform = 'none';
            
            // Re-enable transitions after a short delay
            setTimeout(() => {
                canvasWrapper.style.transition = '';
            }, 10);
        }
        
        // Debug: Track mouse position after zoom
        const newCanvasRect = this.drawingCanvas.getBoundingClientRect();
        const newMouseX = e.clientX - newCanvasRect.left;
        const newMouseY = e.clientY - newCanvasRect.top;
        const newCanvasX = newMouseX / newZoom;
        const newCanvasY = newMouseY / newZoom;

        this.setCanvasSize(this.canvasWidth, this.canvasHeight);
        
        // After zoom, redraw any active preview based on current tool
        this.redrawCurrentPreview();
    }
    
    // Touch event handlers
    onTouchStart(e) {
        const touches = e.touches;
        
        if (touches.length === 1) {
            // Single touch - treat as drawing/tool use or hand tool panning
            e.preventDefault();
            const touch = touches[0];
            
            // Store the active touch ID for consistent tracking
            this.activeTouchId = touch.identifier;
            this.touchStartTime = Date.now();
            
            // For hand tool, start panning with single touch
            if (this.currentTool === 'hand') {
                this.startPanning(this.createMouseEventFromTouch(touch, 'mousedown'));
            } else {
                const mouseEvent = this.createMouseEventFromTouch(touch, 'mousedown');
                this.onMouseDown(mouseEvent);
            }
        } else if (touches.length === 2) {
            // Two finger touch - prepare for pinch zoom and pan
            e.preventDefault();
            this.lastTouchDistance = this.getTouchDistance(touches[0], touches[1]);
            this.lastTouchCenter = this.getTouchCenter(touches[0], touches[1]);
            
            // Enable panning mode for two-finger gestures
            this.isPanning = true;
            
            // Clear active touch ID since we're now in gesture mode
            this.activeTouchId = null;
            
            // Stop any drawing that might be in progress
            if (this.isDrawing) {
                this.isDrawing = false;
            }
        } else if (touches.length > 2) {
            // Three or more fingers - pan only
            e.preventDefault();
            this.lastTouchCenter = this.getTouchCenter(touches[0], touches[1]);
            this.isPanning = true;
            
            // Clear active touch ID
            this.activeTouchId = null;
            
            // Stop any drawing that might be in progress
            if (this.isDrawing) {
                this.isDrawing = false;
            }
        }
    }
    
    onTouchMove(e) {
        const touches = e.touches;
        
        if (touches.length === 1) {
            // Single touch - treat as drawing/tool use or hand tool panning
            // Only process if it's the active touch
            const touch = touches[0];
            
            if (this.activeTouchId === null || touch.identifier === this.activeTouchId) {
                e.preventDefault();
                
                // For hand tool, handle panning (even if isPanning is true)
                if (this.currentTool === 'hand') {
                    this.updatePanning(this.createMouseEventFromTouch(touch, 'mousemove'));
                } else if (!this.isPanning) {
                    // For other tools, only handle if not in multi-touch panning mode
                    const mouseEvent = this.createMouseEventFromTouch(touch, 'mousemove');
                    this.onMouseMove(mouseEvent);
                }
            }
        } else if (touches.length === 2) {
            // Two finger touch - handle pinch zoom and pan
            e.preventDefault();
            
            const currentDistance = this.getTouchDistance(touches[0], touches[1]);
            const currentCenter = this.getTouchCenter(touches[0], touches[1]);
            
            // Handle pinch zoom if we have a previous distance
            if (this.lastTouchDistance) {
                const zoomChange = currentDistance / this.lastTouchDistance;
                const newZoom = this.zoom * zoomChange;
                this.setZoom(newZoom);
            }
            
            // Handle panning
            if (this.lastTouchCenter) {
                const canvasContainer = document.querySelector('.canvas-container');
                const deltaX = currentCenter.x - this.lastTouchCenter.x;
                const deltaY = currentCenter.y - this.lastTouchCenter.y;
                
                canvasContainer.scrollLeft -= deltaX;
                canvasContainer.scrollTop -= deltaY;
            }
            
            // Update for next frame
            this.lastTouchDistance = currentDistance;
            this.lastTouchCenter = currentCenter;
        } else if (touches.length > 2) {
            // Three or more fingers - pan only (no zoom)
            e.preventDefault();
            
            const currentCenter = this.getTouchCenter(touches[0], touches[1]);
            
            // Handle panning
            if (this.lastTouchCenter) {
                const canvasContainer = document.querySelector('.canvas-container');
                const deltaX = currentCenter.x - this.lastTouchCenter.x;
                const deltaY = currentCenter.y - this.lastTouchCenter.y;
                
                canvasContainer.scrollLeft -= deltaX;
                canvasContainer.scrollTop -= deltaY;
            }
            
            this.lastTouchCenter = currentCenter;
        }
    }
    
    onTouchEnd(e) {
        const touches = e.touches;
        const changedTouches = e.changedTouches;
        
        if (touches.length === 0) {
            // All touches ended
            e.preventDefault();
            
            // If we were panning, just stop
            if (this.isPanning) {
                this.isPanning = false;
            } else if (changedTouches.length > 0) {
                // Check if the ended touch was our active touch
                const endedTouch = changedTouches[0];
                if (this.activeTouchId === null || endedTouch.identifier === this.activeTouchId) {
                    // For hand tool, end panning
                    if (this.currentTool === 'hand') {
                        this.endPanning();
                    } else {
                        // Otherwise treat as mouse up for drawing
                        const mouseEvent = this.createMouseEventFromTouch(endedTouch, 'mouseup');
                        this.onMouseUp(mouseEvent);
                    }
                }
            }
            
            // Reset touch tracking
            this.lastTouchDistance = null;
            this.lastTouchCenter = null;
            this.activeTouchId = null;
        } else if (touches.length === 1) {
            // Went from multi-touch to single touch
            e.preventDefault();
            this.lastTouchDistance = null;
            this.lastTouchCenter = null;
            this.isPanning = false;
            
            // If we had no active touch, set it to the remaining touch
            // This handles the case where user lifts one finger while drawing with another
            if (this.activeTouchId === null && !this.isDrawing) {
                this.activeTouchId = touches[0].identifier;
            }
        } else {
            // Still multiple touches, update tracking
            e.preventDefault();
            if (touches.length === 2) {
                this.lastTouchDistance = this.getTouchDistance(touches[0], touches[1]);
                this.lastTouchCenter = this.getTouchCenter(touches[0], touches[1]);
            } else {
                this.lastTouchDistance = null;
                this.lastTouchCenter = this.getTouchCenter(touches[0], touches[1]);
            }
        }
    }
    
    // Helper methods for touch handling
    createMouseEventFromTouch(touch, type) {
        return {
            type: type,
            clientX: touch.clientX,
            clientY: touch.clientY,
            button: 0,
            buttons: 1,
            preventDefault: () => {},
            target: touch.target
        };
    }
    
    getTouchDistance(touch1, touch2) {
        const dx = touch1.clientX - touch2.clientX;
        const dy = touch1.clientY - touch2.clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }
    
    getTouchCenter(touch1, touch2) {
        return {
            x: (touch1.clientX + touch2.clientX) / 2,
            y: (touch1.clientY + touch2.clientY) / 2
        };
    }
    
    onMouseMove(e) {
        this.lastMouseEvent = e; // Store for panning
        const pos = this.getMousePos(e);
        this.updateMousePosition(pos);
        
        // Update shift key state during mouse movement
        this.shiftKey = e.shiftKey;
        
        // Handle right-click panning
        if (this.isPanning) {
            this.updatePanning();
            return;
        }
        
        // Show grid cursor when in grid mode
        if (this.gridModeEnabled && this.currentTool === 'pen') {
            this.showGridCursor(pos.x, pos.y);
        }

        if (!this.isDrawing) {
            // Show pen preview when hovering with pen tool (but not while actively drawing)
            if (this.currentTool === 'pen' && !this.gridModeEnabled && this.penMode !== 'spray') {
                // Only show preview if cursor is within canvas bounds
                if (this.isWithinCanvas(pos.x, pos.y)) {
                    this.showPenPreview(pos.x, pos.y);
                } else {
                    // Clear preview when outside canvas
                    this.clearOverlayAndRedrawBase();
                }
            }
            
            // Show spray preview when hovering with spray mode (but not while actively spraying)
            if (this.currentTool === 'pen' && this.penMode === 'spray') {
                // Only show preview if cursor is within canvas bounds
                if (this.isWithinCanvas(pos.x, pos.y)) {
                    this.showSprayPreview(pos.x, pos.y);
                } else {
                    // Clear preview when outside canvas
                    this.clearOverlayAndRedrawBase();
                }
            }

            // Show fill preview when hovering with bucket tool
            if (this.currentTool === 'bucket') {
                // Only show preview if cursor is within canvas bounds
                if (this.isWithinCanvas(pos.x, pos.y)) {
                    // Always show targeted area preview when mouse is on canvas
                    // The showFillPreview function will handle the editing state properly
                    this.showFillPreview(pos.x, pos.y, this.isEditingGradientSettings);
                } else {
                    // When mouse is outside canvas
                    // Clear any targeted preview area so full preview can show
                    this.lastPreviewArea = null;
                    
                    if (this.fillPattern.startsWith('gradient-') || this.fillPattern !== 'solid') {
                        // For gradients and patterns, show full canvas preview when mouse is outside
                        this.updateGradientLivePreview();
                    } else {
                        // For solid fills, clear preview when outside canvas
                        this.clearOverlayAndRedrawBase();
                    }
                }
            }

            // Show text preview when hovering with text tool (even when not placing)
            if (this.currentTool === 'text' && this.textInput.trim()) {
                this.generateTextCanvas();
                this.clearOverlayAndRedrawBase();
                this.showTextPreview(pos);
            }
            
            return;
        }
        
        // Handle panning for hand tool
        if (this.currentTool === 'hand' && this.isPanning) {
            this.updatePanning(e);
            return;
        }
        
        // Handle middle mouse panning (any tool)
        if (this.isPanning) {
            this.updatePanning();
            return;
        }
        
        // Show paste preview when in paste mode (even while drawing/clicking)
        if (this.currentTool === 'select' && this.isPasteModeActive) {
            // Allow paste preview to show even when partially off-canvas
            this.showPastePreview(pos.x, pos.y);
        }
        
        switch (this.currentTool) {
            case 'pen':
                if ((this.shiftKey && this.startPos) || (this.penMode === 'line' && this.startPos)) {
                    // Draw straight line from start position - only preview, don't draw to canvas yet
                    this.drawStraightLinePreview(this.startPos.x, this.startPos.y, pos.x, pos.y);
                } else {
                    // Normal drawing - draw line and update position
                    this.drawLine(this.lastPos.x, this.lastPos.y, pos.x, pos.y);
                    this.lastPos = pos;
                    
                    // Update spray position if in spray mode
                    if (this.penMode === 'spray') {
                        this.sprayPos = pos;
                    }
                }
                break;
            case 'circle':
            case 'square':
            case 'polygon':
                this.updateShapePreview(pos);
                break;
            case 'text':
                this.updateTextPreviewPosition(pos);
                break;
            case 'hand':
                this.updatePanning();
                break;
            case 'select':
                if (this.isPasteModeActive && this.pasteDragActive && this.isDrawing) {
                    // Check if we've moved enough to consider it a drag
                    const deltaX = Math.abs(pos.x - this.pasteDragStartX);
                    const deltaY = Math.abs(pos.y - this.pasteDragStartY);
                    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
                    const timePassed = Date.now() - this.pasteDragStartTime;
                    
                    // If we've moved enough distance OR held long enough, start dragging
                    if (distance > this.pasteDragThreshold || timePassed > this.pasteDragTimeThreshold) {
                        // Throttle pasting during drag to prevent lag
                        const now = Date.now();
                        if (now - this.lastPasteTime >= this.pasteThrottleInterval) {
                            this.pasteAtPosition(pos.x, pos.y);
                            this.lastPasteTime = now;
                        }
                    }
                } else if (!this.isPasteModeActive) {
                    this.updateSelection(pos.x, pos.y);
                }
                break;
        }
    }
    
    onMouseUp(e) {
        // Stop continuous spray if active
        this.stopContinuousSpray();
        
        // Handle paste mode drag completion even if not in drawing mode
        if (this.isPasteModeActive && this.pasteDragActive) {
            const pos = this.getMousePos(e);
            const deltaX = Math.abs(pos.x - this.pasteDragStartX);
            const deltaY = Math.abs(pos.y - this.pasteDragStartY);
            const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
            const timePassed = Date.now() - this.pasteDragStartTime;
            
            // If it was a quick click (small movement and short time), paste once
            if (distance <= this.pasteDragThreshold && timePassed <= this.pasteDragTimeThreshold) {
                this.pasteAtPosition(pos.x, pos.y);
                // Update code output after paste operation
                this.generateThumbnail(this.currentFrameIndex);
                this.generateCode();
                if (this.layersEnabled) {
                    this.updateLayersUI();
                }
            }
            // If it was a drag, the pasting already happened during mousemove
            
            // Reset drag state
            this.pasteDragActive = false;
        }
        
        if (!this.isDrawing && !this.isPanning) return;
        
        // End panning for any mouse button
        if (this.isPanning) {
            this.endPanning();
            return;
        }
        
        this.isDrawing = false;
        
        // Update shift key state during mouse up
        this.shiftKey = e.shiftKey;
        
        // Handle selection dragging completion
        if (this.selection && this.selection.isDragging) {
            this.finishDraggingSelection();
            // Update code output after selection drag completion
            this.generateThumbnail(this.currentFrameIndex);
            this.generateCode();
            if (this.layersEnabled) {
                this.updateLayersUI();
            }
        }
        
        // Finalize lasso selection when mouse is released
        if (this.currentTool === 'select' && this.selection && this.selection.active && this.selection.mode === 'lasso' && !this.selection.isDragging) {
            // Close the lasso path by connecting back to the start
            const firstPoint = this.selection.lassoPoints[0];
            const lastPoint = this.selection.lassoPoints[this.selection.lassoPoints.length - 1];
            
            // Only close if the lasso has enough points and isn't already closed
            if (this.selection.lassoPoints.length > 2 && 
                (Math.abs(lastPoint.x - firstPoint.x) > 2 || Math.abs(lastPoint.y - firstPoint.y) > 2)) {
                this.selection.lassoPoints.push({x: firstPoint.x, y: firstPoint.y});
            }
            
            this.drawSelectionOverlay();
        }
        
        // If we were drawing a straight line, finalize it
        if (this.currentTool === 'pen' && ((this.shiftKey && this.startPos) || (this.penMode === 'line' && this.startPos))) {
            const pos = this.getMousePos(e);
            this.drawStraightLine(this.startPos.x, this.startPos.y, pos.x, pos.y);
            // Clear the overlay after drawing the final line and restore base layers
            this.clearOverlayAndRedrawBase();
        }
        
        // Finalize shapes
        if ((this.currentTool === 'circle' || this.currentTool === 'square' || this.currentTool === 'polygon') && this.startPos) {
            const pos = this.getMousePos(e);
            this.finalizeShape(pos);
        }
        
        // Finalize text placement
        if (this.currentTool === 'text' && this.isPlacingText) {
            const pos = this.getMousePos(e);
            this.finalizeText(pos);
        }
        
        // End panning (for hand tool or middle mouse)
        if (this.isPanning) {
            this.endPanning();
            return;
        }
        
        if (this.currentTool === 'pen' || this.currentTool === 'circle' || this.currentTool === 'square' || this.currentTool === 'text') {
            this.generateThumbnail(this.currentFrameIndex);
            this.generateCode();
            
            // Update layer previews if layers are enabled
            if (this.layersEnabled) {
                this.updateLayersUI();
            }
        }
        
        // Finish stroke for undo system
        if (this.currentTool === 'pen' && this.currentStroke) {
            this.finishStroke();
            
            // Ensure final redraw after pen drawing is complete
            if (this.pendingRedrawTimeout) {
                clearTimeout(this.pendingRedrawTimeout);
                this.pendingRedrawTimeout = null;
            }
            this.redrawCanvas();
            this.lastRedrawTime = Date.now();
        }
    }
    
    finishDraggingSelection() {
        if (!this.selection || !this.selection.cutContent) return;
        
        // Place the cut content at the new location
        const { startX, startY, endX, endY } = this.selection;
        const minX = Math.min(startX, endX);
        const minY = Math.min(startY, endY);
        
        const ctx = this.getCurrentFrameContext();
        ctx.drawImage(this.selection.cutContent, minX, minY);
        
        // Clear the cut content and selection
        this.selection.cutContent = null;
        this.selection.isDragging = false;
        this.selection.active = false;
        this.selection = null;
        
        this.redrawCanvas();
        // Since selection is now cleared, restore the overlay state
        this.restoreOverlayState();
    }
    
    drawPixel(x, y) {
        const ctx = this.getCurrentFrameContext();
        const color = this.currentColor;
        
        // Start pixel tracking for this operation
        this.startPixelTracking();
        
        if (this.gridModeEnabled) {
            // In grid mode, completely override brush settings and fill entire grid squares
            this.drawGridSquare(x, y, ctx, color);
            
            // Handle mirroring for grid mode
            if (this.mirrorHorizontal || this.mirrorVertical) {
                this.drawMirroredGridSquares(x, y, ctx, color);
            }
        } else if (this.penMode === 'spray') {
            // Spray mode - use Gaussian noise distribution
            this.drawSprayBrush(x, y, this.brushSize, ctx, color);
            
            // Handle mirroring for spray mode
            if (this.mirrorHorizontal || this.mirrorVertical) {
                this.drawMirroredSpray(x, y, ctx, color);
            }
        } else {
            // Normal drawing mode - use brush size and shape
            if (this.brushShape === 'circle') {
                this.drawCircleBrush(x, y, this.brushSize, ctx, color);
            } else {
                this.drawSquareBrush(x, y, this.brushSize, ctx, color);
            }
            
            // Handle mirroring for normal mode
            if (this.mirrorHorizontal || this.mirrorVertical) {
                this.drawMirroredPixels(x, y, ctx, color);
            }
        }
        
        // End pixel tracking and add to stroke
        this.endPixelTracking();
        
        // Throttle canvas updates during continuous drawing for better performance
        this.throttledRedrawCanvas();
    }
    
    drawGridSquare(x, y, ctx, color) {
        const gridSize = this.gridSize;
        
        // Calculate the top-left corner of the grid square
        const gridX = Math.floor(x / gridSize) * gridSize;
        const gridY = Math.floor(y / gridSize) * gridSize;
        
        // Fill the entire grid square
        for (let px = gridX; px < gridX + gridSize && px < this.canvasWidth; px++) {
            for (let py = gridY; py < gridY + gridSize && py < this.canvasHeight; py++) {
                this.setPixelInFrameWithColor(px, py, color, ctx);
            }
        }
    }
    
    drawMirroredGridSquares(x, y, ctx, color) {
        const centerX = Math.floor(this.canvasWidth / 2);
        const centerY = Math.floor(this.canvasHeight / 2);
        
        if (this.mirrorHorizontal) {
            const mirrorX = centerX - (x - centerX);
            if (mirrorX >= 0 && mirrorX < this.canvasWidth) {
                this.drawGridSquare(mirrorX, y, ctx, color);
            }
        }
        
        if (this.mirrorVertical) {
            const mirrorY = centerY - (y - centerY);
            if (mirrorY >= 0 && mirrorY < this.canvasHeight) {
                this.drawGridSquare(x, mirrorY, ctx, color);
            }
        }
        
        if (this.mirrorHorizontal && this.mirrorVertical) {
            const mirrorX = centerX - (x - centerX);
            const mirrorY = centerY - (y - centerY);
            if (mirrorX >= 0 && mirrorX < this.canvasWidth && mirrorY >= 0 && mirrorY < this.canvasHeight) {
                this.drawGridSquare(mirrorX, mirrorY, ctx, color);
            }
        }
    }
    
    throttledRedrawCanvas() {
        const now = Date.now();
        const timeSinceLastRedraw = now - (this.lastRedrawTime || 0);
        
        // If it's been more than 20ms since last redraw, or this is the first draw, redraw immediately
        if (timeSinceLastRedraw >= 20) {
            this.redrawCanvas();
            this.lastRedrawTime = now;
            // Redraw preview on top if we're drawing with pen tool
            this.redrawPreviewAfterCanvas();
        } else {
            // Schedule a redraw for the remaining time
            if (this.pendingRedrawTimeout) {
                clearTimeout(this.pendingRedrawTimeout);
            }
            
            this.pendingRedrawTimeout = setTimeout(() => {
                this.redrawCanvas();
                this.lastRedrawTime = Date.now();
                this.pendingRedrawTimeout = null;
                // Redraw preview on top if we're drawing with pen tool
                this.redrawPreviewAfterCanvas();
            }, 20 - timeSinceLastRedraw);
        }
    }
    
    redrawPreviewAfterCanvas() {
        // If we're actively drawing with the pen tool, redraw the preview on top
        if (this.isDrawing && this.currentTool === 'pen' && this.lastPos) {
            if (!this.gridModeEnabled && this.penMode !== 'spray') {
                // Only show pen preview if center is within bounds (pen is point-based)
                if (this.isWithinCanvas(this.lastPos.x, this.lastPos.y)) {
                    this.showPenPreview(this.lastPos.x, this.lastPos.y);
                }
            } else if (this.penMode === 'spray') {
                // Show spray preview even near edges (it handles clipping internally)
                this.showSprayPreview(this.lastPos.x, this.lastPos.y);
            }
        }
    }
    
    drawMirroredPixels(x, y, ctx, color) {
        // Calculate mirror lines based on even/odd pixel count
        // For even width: mirror across line between center pixels (e.g. 144 pixels: mirror line at 71.5)
        // For odd width: center pixel serves as mirror line (e.g. 143 pixels: center at 71)
        
        if (this.mirrorHorizontal && !this.mirrorVertical) {
            // Horizontal mirror only
            let mirrorX;
            if (this.canvasWidth % 2 === 0) {
                // Even width: mirror across line between center pixels
                const centerLine = (this.canvasWidth / 2) - 0.5;
                mirrorX = Math.floor(2 * centerLine - x);
            } else {
                // Odd width: mirror across center pixel
                const centerPixel = Math.floor(this.canvasWidth / 2);
                mirrorX = 2 * centerPixel - x;
            }
            
            if (mirrorX >= 0 && mirrorX < this.canvasWidth && mirrorX !== x) {
                if (this.brushShape === 'circle') {
                    this.drawCircleBrush(mirrorX, y, this.brushSize, ctx, color);
                } else {
                    this.drawSquareBrush(mirrorX, y, this.brushSize, ctx, color);
                }
            }
        }
        
        if (this.mirrorVertical && !this.mirrorHorizontal) {
            // Vertical mirror only
            let mirrorY;
            if (this.canvasHeight % 2 === 0) {
                // Even height: mirror across line between center pixels
                const centerLine = (this.canvasHeight / 2) - 0.5;
                mirrorY = Math.floor(2 * centerLine - y);
            } else {
                // Odd height: mirror across center pixel
                const centerPixel = Math.floor(this.canvasHeight / 2);
                mirrorY = 2 * centerPixel - y;
            }
            
            if (mirrorY >= 0 && mirrorY < this.canvasHeight && mirrorY !== y) {
                if (this.brushShape === 'circle') {
                    this.drawCircleBrush(x, mirrorY, this.brushSize, ctx, color);
                } else {
                    this.drawSquareBrush(x, mirrorY, this.brushSize, ctx, color);
                }
            }
        }
        
        if (this.mirrorHorizontal && this.mirrorVertical) {
            // Both mirrors - calculate both mirror positions
            let mirrorX, mirrorY;
            
            if (this.canvasWidth % 2 === 0) {
                const centerLine = (this.canvasWidth / 2) - 0.5;
                mirrorX = Math.floor(2 * centerLine - x);
            } else {
                const centerPixel = Math.floor(this.canvasWidth / 2);
                mirrorX = 2 * centerPixel - x;
            }
            
            if (this.canvasHeight % 2 === 0) {
                const centerLine = (this.canvasHeight / 2) - 0.5;
                mirrorY = Math.floor(2 * centerLine - y);
            } else {
                const centerPixel = Math.floor(this.canvasHeight / 2);
                mirrorY = 2 * centerPixel - y;
            }
            
            // Horizontal mirror
            if (mirrorX >= 0 && mirrorX < this.canvasWidth && mirrorX !== x) {
                if (this.brushShape === 'circle') {
                    this.drawCircleBrush(mirrorX, y, this.brushSize, ctx, color);
                } else {
                    this.drawSquareBrush(mirrorX, y, this.brushSize, ctx, color);
                }
            }
            
            // Vertical mirror
            if (mirrorY >= 0 && mirrorY < this.canvasHeight && mirrorY !== y) {
                if (this.brushShape === 'circle') {
                    this.drawCircleBrush(x, mirrorY, this.brushSize, ctx, color);
                } else {
                    this.drawSquareBrush(x, mirrorY, this.brushSize, ctx, color);
                }
            }
            
            // Diagonal mirror (both axes)
            if (mirrorX >= 0 && mirrorX < this.canvasWidth && mirrorY >= 0 && mirrorY < this.canvasHeight && 
                (mirrorX !== x || mirrorY !== y)) {
                if (this.brushShape === 'circle') {
                    this.drawCircleBrush(mirrorX, mirrorY, this.brushSize, ctx, color);
                } else {
                    this.drawSquareBrush(mirrorX, mirrorY, this.brushSize, ctx, color);
                }
            }
        }
    }
    
    drawMirroredShapePixels(x, y, ctx) {
        // Mirror pixels for shapes - only sets individual pixels, doesn't use brush size
        if (this.mirrorHorizontal && !this.mirrorVertical) {
            // Horizontal mirror only
            let mirrorX;
            if (this.canvasWidth % 2 === 0) {
                const centerLine = (this.canvasWidth / 2) - 0.5;
                mirrorX = Math.floor(2 * centerLine - x);
            } else {
                const centerPixel = Math.floor(this.canvasWidth / 2);
                mirrorX = 2 * centerPixel - x;
            }
            
            if (mirrorX >= 0 && mirrorX < this.canvasWidth && mirrorX !== x) {
                this.setPixelInFrame(mirrorX, y, ctx);
            }
        }
        
        if (this.mirrorVertical && !this.mirrorHorizontal) {
            // Vertical mirror only
            let mirrorY;
            if (this.canvasHeight % 2 === 0) {
                const centerLine = (this.canvasHeight / 2) - 0.5;
                mirrorY = Math.floor(2 * centerLine - y);
            } else {
                const centerPixel = Math.floor(this.canvasHeight / 2);
                mirrorY = 2 * centerPixel - y;
            }
            
            if (mirrorY >= 0 && mirrorY < this.canvasHeight && mirrorY !== y) {
                this.setPixelInFrame(x, mirrorY, ctx);
            }
        }
        
        if (this.mirrorHorizontal && this.mirrorVertical) {
            // Both mirrors - create four-way symmetry
            const centerX = this.canvasWidth % 2 === 0 ? (this.canvasWidth / 2) - 0.5 : Math.floor(this.canvasWidth / 2);
            const centerY = this.canvasHeight % 2 === 0 ? (this.canvasHeight / 2) - 0.5 : Math.floor(this.canvasHeight / 2);
            
            let mirrorX, mirrorY;
            if (this.canvasWidth % 2 === 0) {
                mirrorX = Math.floor(2 * centerX - x);
            } else {
                mirrorX = 2 * centerX - x;
            }
            
            if (this.canvasHeight % 2 === 0) {
                mirrorY = Math.floor(2 * centerY - y);
            } else {
                mirrorY = 2 * centerY - y;
            }
            
            // Draw mirrored pixels
            if (mirrorX >= 0 && mirrorX < this.canvasWidth && mirrorX !== x) {
                this.setPixelInFrame(mirrorX, y, ctx);
            }
            if (mirrorY >= 0 && mirrorY < this.canvasHeight && mirrorY !== y) {
                this.setPixelInFrame(x, mirrorY, ctx);
            }
            if (mirrorX >= 0 && mirrorX < this.canvasWidth && mirrorY >= 0 && mirrorY < this.canvasHeight && (mirrorX !== x || mirrorY !== y)) {
                this.setPixelInFrame(mirrorX, mirrorY, ctx);
            }
        }
    }
    
    drawSquareBrush(x, y, size, ctx, color) {
        const halfSize = Math.floor(size / 2);
        for (let dx = 0; dx < size; dx++) {
            for (let dy = 0; dy < size; dy++) {
                const px = x + dx - halfSize;
                const py = y + dy - halfSize;
                
                if (px >= 0 && px < this.canvasWidth && py >= 0 && py < this.canvasHeight) {
                    ctx.fillStyle = color;
                    ctx.fillRect(px, py, 1, 1);
                }
            }
        }
    }
    
    drawCircleBrush(x, y, size, ctx, color) {
        const radius = size / 2;
        const halfSize = Math.floor(size / 2);
        
        for (let dx = 0; dx < size; dx++) {
            for (let dy = 0; dy < size; dy++) {
                const px = x + dx - halfSize;
                const py = y + dy - halfSize;
                
                // Check if point is within circle
                const distance = Math.sqrt((dx - halfSize) ** 2 + (dy - halfSize) ** 2);
                if (distance <= radius && px >= 0 && px < this.canvasWidth && py >= 0 && py < this.canvasHeight) {
                    ctx.fillStyle = color;
                    ctx.fillRect(px, py, 1, 1);
                }
            }
        }
    }
    
    // Generate a random number with Gaussian (normal) distribution
    // Uses Box-Muller transform
    gaussianRandom(mean = 0, stdDev = 1) {
        const u1 = Math.random();
        const u2 = Math.random();
        const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
        return z0 * stdDev + mean;
    }
    
    drawSprayBrush(x, y, size, ctx, color) {
        // Number of particles per spray - scales with brush size and flow setting
        // Flow is divided by 3 to make the effect more subtle
        // Ensure at least 1 particle is always drawn
        const particleCount = Math.max(1, Math.floor(size * ((this.sprayFlow - 1) / 20)));
        
        // Standard deviation for the Gaussian distribution
        // Smaller values = tighter spray, larger = more spread out
        const spread = size / 5; // Adjust spread factor as needed
        
        for (let i = 0; i < particleCount; i++) {
            // Generate random offsets using Gaussian distribution
            const offsetX = this.gaussianRandom(0, spread);
            const offsetY = this.gaussianRandom(0, spread);
            
            const px = Math.round(x + offsetX);
            const py = Math.round(y + offsetY);
            
            // Only draw if within canvas bounds
            if (px >= 0 && px < this.canvasWidth && py >= 0 && py < this.canvasHeight) {
                ctx.fillStyle = color;
                ctx.fillRect(px, py, 1, 1);
            }
        }
    }
    
    drawMirroredSpray(x, y, ctx, color) {
        const centerX = Math.floor(this.canvasWidth / 2);
        const centerY = Math.floor(this.canvasHeight / 2);
        
        if (this.mirrorHorizontal) {
            const mirrorX = centerX - (x - centerX);
            if (mirrorX >= 0 && mirrorX < this.canvasWidth) {
                this.drawSprayBrush(mirrorX, y, this.brushSize, ctx, color);
            }
        }
        
        if (this.mirrorVertical) {
            const mirrorY = centerY - (y - centerY);
            if (mirrorY >= 0 && mirrorY < this.canvasHeight) {
                this.drawSprayBrush(x, mirrorY, this.brushSize, ctx, color);
            }
        }
        
        if (this.mirrorHorizontal && this.mirrorVertical) {
            const mirrorX = centerX - (x - centerX);
            const mirrorY = centerY - (y - centerY);
            if (mirrorX >= 0 && mirrorX < this.canvasWidth && mirrorY >= 0 && mirrorY < this.canvasHeight) {
                this.drawSprayBrush(mirrorX, mirrorY, this.brushSize, ctx, color);
            }
        }
    }
    
    startContinuousSpray(pos) {
        // Clear any existing spray timer
        this.stopContinuousSpray();
        
        // Store spray position
        this.sprayPos = pos;
        
        // Create interval that continuously sprays
        this.sprayInterval = setInterval(() => {
            if (this.isDrawing && this.penMode === 'spray' && this.sprayPos) {
                this.drawPixel(this.sprayPos.x, this.sprayPos.y);
            }
        }, 50); // Spray every 50ms (20 times per second)
    }
    
    stopContinuousSpray() {
        if (this.sprayInterval) {
            clearInterval(this.sprayInterval);
            this.sprayInterval = null;
        }
        this.sprayPos = null;
    }
    
    drawLine(x0, y0, x1, y1) {
        // Bresenham's line algorithm
        const dx = Math.abs(x1 - x0);
        const dy = Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1;
        const sy = y0 < y1 ? 1 : -1;
        let err = dx - dy;
        
        let x = x0;
        let y = y0;
        
        while (true) {
            this.drawPixel(x, y);
            
            if (x === x1 && y === y1) break;
            
            const e2 = 2 * err;
            if (e2 > -dy) {
                err -= dy;
                x += sx;
            }
            if (e2 < dx) {
                err += dx;
                y += sy;
            }
        }
    }
    
    getLinePixels(x0, y0, x1, y1) {
        // Bresenham's line algorithm - returns array of pixel coordinates
        const pixels = [];
        const dx = Math.abs(x1 - x0);
        const dy = Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1;
        const sy = y0 < y1 ? 1 : -1;
        let err = dx - dy;
        
        let x = x0;
        let y = y0;
        
        while (true) {
            pixels.push({ x: x, y: y });
            
            if (x === x1 && y === y1) break;
            
            const e2 = 2 * err;
            if (e2 > -dy) {
                err -= dy;
                x += sx;
            }
            if (e2 < dx) {
                err += dx;
                y += sy;
            }
        }
        
        return pixels;
    }
    
    drawStraightLinePreview(x0, y0, x1, y1) {
        // Clear overlay completely first
        this.overlayCtx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
        
        // Phase 1: Draw base overlays (bottom layer) - includes pixel grid and grid lines if enabled
        this.drawBaseOverlays();
        
        // Phase 2: Draw selection overlay if active (middle layer)
        if (this.selection && this.selection.active) {
            this.drawSelectionOverlay();
        }
        
        // Phase 3: Draw actual pixels that will be drawn for the straight line (top layer)
        this.overlayCtx.save();
        this.overlayCtx.fillStyle = 'rgba(255, 0, 0, 0.9)'; // Very strong red with 90% opacity for clear visibility
        
        // Get all pixels along the line using Bresenham algorithm (same as actual drawing)
        const linePixels = this.getLinePixels(Math.floor(x0), Math.floor(y0), Math.floor(x1), Math.floor(y1));
        
        // Draw each pixel that would be affected by the brush, but only if within canvas bounds
        linePixels.forEach(pixel => {
            // Only draw pixels that are within canvas bounds
            if (this.isWithinCanvas(pixel.x, pixel.y)) {
                if (this.brushShape === 'circle') {
                    this.drawCircleBrushPreview(pixel.x, pixel.y, this.brushSize);
                } else {
                    this.drawSquareBrushPreview(pixel.x, pixel.y, this.brushSize);
                }
            }
        });
        
        this.overlayCtx.restore();
    }
    
    drawStraightLine(x0, y0, x1, y1) {
        // Draw the actual straight line to the canvas
        // Floor coordinates to ensure we use pixel coordinates (same as preview)
        // The brush functions will handle clipping to canvas bounds
        this.drawLine(Math.floor(x0), Math.floor(y0), Math.floor(x1), Math.floor(y1));
    }
    
    showPenPreview(x, y) {
        // Ensure coordinates are integers for pixel-perfect positioning
        x = Math.floor(x);
        y = Math.floor(y);
        
        // Clear overlay completely first
        this.overlayCtx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
        
        // Phase 1: Draw base overlays (which includes grid if appropriate)
        this.drawBaseOverlays();
        
        // Phase 2: Draw pen preview (top layer)
        this.overlayCtx.save();
        
        // Disable anti-aliasing for crisp, pixel-perfect rendering
        this.overlayCtx.imageSmoothingEnabled = false;
        this.overlayCtx.webkitImageSmoothingEnabled = false;
        this.overlayCtx.mozImageSmoothingEnabled = false;
        this.overlayCtx.msImageSmoothingEnabled = false;
        
        this.overlayCtx.fillStyle = 'rgba(255, 0, 0, 0.9)'; // Very strong red with 90% opacity for clear visibility
        
        // Draw pen preview based on brush shape and size
        if (this.brushShape === 'circle') {
            this.drawCircleBrushPreview(x, y, this.brushSize);
        } else {
            this.drawSquareBrushPreview(x, y, this.brushSize);
        }
        
        // Draw mirrored previews if mirror mode is enabled
        if (this.mirrorHorizontal || this.mirrorVertical) {
            this.drawMirroredPenPreview(x, y);
        }
        
        // Restore overlay context
        this.overlayCtx.restore();
    }
    
    showSprayPreview(x, y) {
        // Ensure coordinates are integers for pixel-perfect positioning
        x = Math.floor(x);
        y = Math.floor(y);
        
        // Clear overlay completely first
        this.overlayCtx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
        
        // Phase 1: Draw base overlays (which includes grid if appropriate)
        this.drawBaseOverlays();
        
        // Phase 2: Draw spray preview (top layer)
        this.overlayCtx.save();
        
        // Disable anti-aliasing for crisp, pixel-perfect rendering
        this.overlayCtx.imageSmoothingEnabled = false;
        this.overlayCtx.webkitImageSmoothingEnabled = false;
        this.overlayCtx.mozImageSmoothingEnabled = false;
        this.overlayCtx.msImageSmoothingEnabled = false;
        
        // Draw a pixel-perfect circle outline to show spray area
        const radius = this.brushSize / 2;
        this.overlayCtx.fillStyle = 'rgba(255, 0, 0, 0.8)';
        
        // Use Bresenham's circle algorithm for pixel-perfect outline with dashed pattern
        this.drawPixelPerfectCircleOutline(x, y, radius, true);
        
        // Draw mirrored previews if mirror mode is enabled
        if (this.mirrorHorizontal || this.mirrorVertical) {
            this.drawMirroredSprayPreview(x, y);
        }
        
        // Restore overlay context
        this.overlayCtx.restore();
    }
    
    drawPixelPerfectCircleOutline(cx, cy, radius, dashed = false) {
        // Bresenham's circle algorithm for pixel-perfect rendering
        let x = 0;
        let y = Math.floor(radius);
        let d = 3 - 2 * Math.floor(radius);
        let dashCounter = 0;
        
        const drawPixelIfInBounds = (px, py) => {
            if (px >= 0 && px < this.canvasWidth && py >= 0 && py < this.canvasHeight) {
                this.overlayCtx.fillRect(px, py, 1, 1);
            }
        };
        
        while (y >= x) {
            // For dashed pattern, increment counter once per iteration, not per pixel
            const shouldDraw = !dashed || (Math.floor(dashCounter / 2) % 2 === 0);
            
            if (shouldDraw) {
                // Draw 8 octants with bounds checking
                drawPixelIfInBounds(cx + x, cy + y);
                drawPixelIfInBounds(cx - x, cy + y);
                drawPixelIfInBounds(cx + x, cy - y);
                drawPixelIfInBounds(cx - x, cy - y);
                drawPixelIfInBounds(cx + y, cy + x);
                drawPixelIfInBounds(cx - y, cy + x);
                drawPixelIfInBounds(cx + y, cy - x);
                drawPixelIfInBounds(cx - y, cy - x);
            }
            
            dashCounter++;
            x++;
            if (d > 0) {
                y--;
                d = d + 4 * (x - y) + 10;
            } else {
                d = d + 4 * x + 6;
            }
        }
    }
    
    drawMirroredSprayPreview(x, y) {
        const centerX = Math.floor(this.canvasWidth / 2);
        const centerY = Math.floor(this.canvasHeight / 2);
        const radius = this.brushSize / 2;
        
        if (this.mirrorHorizontal) {
            const mirrorX = centerX - (x - centerX);
            if (mirrorX >= 0 && mirrorX < this.canvasWidth) {
                this.drawPixelPerfectCircleOutline(mirrorX, y, radius, true);
            }
        }
        
        if (this.mirrorVertical) {
            const mirrorY = centerY - (y - centerY);
            if (mirrorY >= 0 && mirrorY < this.canvasHeight) {
                this.drawPixelPerfectCircleOutline(x, mirrorY, radius, true);
            }
        }
        
        if (this.mirrorHorizontal && this.mirrorVertical) {
            const mirrorX = centerX - (x - centerX);
            const mirrorY = centerY - (y - centerY);
            if (mirrorX >= 0 && mirrorX < this.canvasWidth && mirrorY >= 0 && mirrorY < this.canvasHeight) {
                this.drawPixelPerfectCircleOutline(mirrorX, mirrorY, radius, true);
            }
        }
    }
    
    showGridCursor(x, y) {
        // Start with base overlays (which includes grid if appropriate)
        this.overlayCtx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
        this.drawBaseOverlays();
        
        // Add grid cursor on top with pixel-perfect rendering
        this.overlayCtx.save();
        
        // Disable anti-aliasing for crisp, pixel-perfect rendering
        this.overlayCtx.imageSmoothingEnabled = false;
        this.overlayCtx.webkitImageSmoothingEnabled = false;
        this.overlayCtx.mozImageSmoothingEnabled = false;
        this.overlayCtx.msImageSmoothingEnabled = false;
        
        // Calculate the grid square boundaries - use actual grid size
        const gridSize = this.gridModeEnabled ? this.gridSize : this.gridSize;
        const gridX = Math.floor(x / gridSize) * gridSize;
        const gridY = Math.floor(y / gridSize) * gridSize;
        
        // Clamp to canvas boundaries
        const endX = Math.min(gridX + gridSize, this.canvasWidth);
        const endY = Math.min(gridY + gridSize, this.canvasHeight);
        const actualWidth = endX - gridX;
        const actualHeight = endY - gridY;
        
        // Fill the grid square - pixel perfect
        this.overlayCtx.fillStyle = 'rgba(255, 0, 0, 0.3)';
        this.overlayCtx.fillRect(gridX, gridY, actualWidth, actualHeight);
        
        // Draw crisp border - use integer coordinates for pixel-perfect lines
        this.overlayCtx.strokeStyle = 'rgba(255, 0, 0, 0.9)';
        this.overlayCtx.lineWidth = 1;
        this.overlayCtx.translate(0.5, 0.5); // Shift for pixel-perfect lines
        this.overlayCtx.strokeRect(gridX - 0.5, gridY - 0.5, actualWidth, actualHeight);
        
        this.overlayCtx.restore();
        
        // Draw mirrored grid cursors if mirror mode is enabled
        if (this.mirrorHorizontal || this.mirrorVertical) {
            this.drawMirroredGridCursor(x, y);
        }
    }
    
    drawMirroredGridCursor(x, y) {
        const centerX = Math.floor(this.canvasWidth / 2);
        const centerY = Math.floor(this.canvasHeight / 2);
        const gridSize = this.gridSize;
        
        this.overlayCtx.save();
        
        // Disable anti-aliasing for crisp, pixel-perfect rendering
        this.overlayCtx.imageSmoothingEnabled = false;
        this.overlayCtx.webkitImageSmoothingEnabled = false;
        this.overlayCtx.mozImageSmoothingEnabled = false;
        this.overlayCtx.msImageSmoothingEnabled = false;
        
        this.overlayCtx.fillStyle = 'rgba(255, 165, 0, 0.3)'; // Orange for mirrored cursors
        this.overlayCtx.strokeStyle = 'rgba(255, 165, 0, 0.9)';
        this.overlayCtx.lineWidth = 1;
        this.overlayCtx.translate(0.5, 0.5); // Pixel-perfect lines
        
        if (this.mirrorHorizontal) {
            const mirrorX = centerX - (x - centerX);
            if (mirrorX >= 0 && mirrorX < this.canvasWidth) {
                const gridX = Math.floor(mirrorX / gridSize) * gridSize;
                const gridY = Math.floor(y / gridSize) * gridSize;
                const endX = Math.min(gridX + gridSize, this.canvasWidth);
                const endY = Math.min(gridY + gridSize, this.canvasHeight);
                const actualWidth = endX - gridX;
                const actualHeight = endY - gridY;
                
                // Render without additional translation
                this.overlayCtx.fillRect(gridX - 0.5, gridY - 0.5, actualWidth, actualHeight);
                this.overlayCtx.strokeRect(gridX - 0.5, gridY - 0.5, actualWidth, actualHeight);
            }
        }
        
        if (this.mirrorVertical) {
            const mirrorY = centerY - (y - centerY);
            if (mirrorY >= 0 && mirrorY < this.canvasHeight) {
                const gridX = Math.floor(x / gridSize) * gridSize;
                const gridY = Math.floor(mirrorY / gridSize) * gridSize;
                const endX = Math.min(gridX + gridSize, this.canvasWidth);
                const endY = Math.min(gridY + gridSize, this.canvasHeight);
                const actualWidth = endX - gridX;
                const actualHeight = endY - gridY;
                
                // Render without additional translation
                this.overlayCtx.fillRect(gridX - 0.5, gridY - 0.5, actualWidth, actualHeight);
                this.overlayCtx.strokeRect(gridX - 0.5, gridY - 0.5, actualWidth, actualHeight);
            }
        }
        
        if (this.mirrorHorizontal && this.mirrorVertical) {
            const mirrorX = centerX - (x - centerX);
            const mirrorY = centerY - (y - centerY);
            if (mirrorX >= 0 && mirrorX < this.canvasWidth && mirrorY >= 0 && mirrorY < this.canvasHeight) {
                const gridX = Math.floor(mirrorX / gridSize) * gridSize;
                const gridY = Math.floor(mirrorY / gridSize) * gridSize;
                const endX = Math.min(gridX + gridSize, this.canvasWidth);
                const endY = Math.min(gridY + gridSize, this.canvasHeight);
                const actualWidth = endX - gridX;
                const actualHeight = endY - gridY;
                
                // Render without additional translation
                this.overlayCtx.fillRect(gridX - 0.5, gridY - 0.5, actualWidth, actualHeight);
                this.overlayCtx.strokeRect(gridX - 0.5, gridY - 0.5, actualWidth, actualHeight);
            }
        }
        
        this.overlayCtx.restore();
    }
    
    drawCircleBrushPreview(x, y, size) {
        const radius = size / 2;
        const halfSize = Math.floor(size / 2);
        
        // Ensure x and y are integers for pixel-perfect positioning
        x = Math.floor(x);
        y = Math.floor(y);
        
        for (let dx = 0; dx < size; dx++) {
            for (let dy = 0; dy < size; dy++) {
                const px = x + dx - halfSize;
                const py = y + dy - halfSize;
                
                // Check if point is within circle and canvas bounds
                const distance = Math.sqrt((dx - halfSize) ** 2 + (dy - halfSize) ** 2);
                if (distance <= radius && px >= 0 && px < this.canvasWidth && py >= 0 && py < this.canvasHeight) {
                    // Use integer coordinates for crisp pixel rendering
                    this.overlayCtx.fillRect(Math.floor(px), Math.floor(py), 1, 1);
                }
            }
        }
    }
    
    drawSquareBrushPreview(x, y, size) {
        const halfSize = Math.floor(size / 2);
        
        // Ensure x and y are integers for pixel-perfect positioning
        x = Math.floor(x);
        y = Math.floor(y);
        
        for (let dx = 0; dx < size; dx++) {
            for (let dy = 0; dy < size; dy++) {
                const px = x + dx - halfSize;
                const py = y + dy - halfSize;
                
                if (px >= 0 && px < this.canvasWidth && py >= 0 && py < this.canvasHeight) {
                    // Use integer coordinates for crisp pixel rendering
                    this.overlayCtx.fillRect(Math.floor(px), Math.floor(py), 1, 1);
                }
            }
        }
    }
    
    showFillPreview(x, y, preserveEditingState = false) {
        // Clear gradient editing flag when actually showing a fill preview (mouse on artpiece)
        // Unless we're explicitly preserving the editing state for temporary preview
        if (this.isEditingGradientSettings && !preserveEditingState) {
            this.isEditingGradientSettings = false;
            // Clear the recurring preview interval
            if (this.gradientEditingInterval) {
                clearInterval(this.gradientEditingInterval);
                this.gradientEditingInterval = null;
            }
        }
        
        // Clear overlay and redraw base layers
        this.clearOverlayAndRedrawBase();
        
        // Get the target color at this position
        const ctx = this.getCurrentFrameContext();
        const imageData = ctx.getImageData(0, 0, this.canvasWidth, this.canvasHeight);
        const data = imageData.data;
        const targetColor = this.getPixelColor(data, x, y);
        const fillColor = this.currentColor === 'black' ? [0, 0, 0, 255] : [255, 255, 255, 255];
        
        // Don't show preview if colors are the same
        if (this.colorsEqual(targetColor, fillColor)) {
            return;
        }
        
        // Find all pixels that would be filled using flood fill algorithm
        const fillPixels = this.getFillPreviewPixels(x, y, targetColor, imageData);
        
        // Store this as the last preview area for live pattern updates
        this.lastPreviewArea = {
            pixels: fillPixels,
            targetColor: targetColor,
            clickX: x,
            clickY: y
        };
        
        // Draw preview based on the current fill pattern
        fillPixels.forEach(pixel => {
            let shouldShowPixel = true;
            let previewColor = 'rgba(255, 0, 0, 0.6)'; // Red preview for consistency
            
            if (this.fillPattern.startsWith('gradient-')) {
                // For gradients, use the exact same logic as performFloodFill
                if (this.fillPattern.includes('-dither') || this.fillPattern.includes('-stipple')) {
                    // For dithered gradients, check if this pixel would be filled
                    const hexColor = this.getGradientColor(pixel.x, pixel.y, this.fillPattern, this.currentColor);
                    if ((this.currentColor === 'black' && hexColor === '#ffffff') ||
                        (this.currentColor === 'white' && hexColor === '#000000')) {
                        shouldShowPixel = false;
                    }
                }
                // For regular gradients, all pixels are filled (shouldShowPixel stays true)
            } else if (this.fillPattern !== 'solid') {
                // For stippling patterns, check if pixel should be filled
                shouldShowPixel = this.shouldFillPixel(pixel.x, pixel.y, this.fillPattern);
            }
            
            if (shouldShowPixel) {
                this.overlayCtx.fillStyle = previewColor;
                this.overlayCtx.fillRect(pixel.x, pixel.y, 1, 1);
            }
        });
        
        // Reset overlay context
        this.overlayCtx.globalAlpha = 1;
    }
    
    getFillPreviewPixels(startX, startY, targetColor, imageData) {
        const data = imageData.data;
        const fillPixels = [];
        const stack = [[startX, startY]];
        const visited = new Set();
        
        while (stack.length > 0) {
            const [x, y] = stack.pop();
            const key = `${x},${y}`;
            
            if (visited.has(key)) continue;
            if (x < 0 || x >= this.canvasWidth || y < 0 || y >= this.canvasHeight) continue;
            
            const currentColor = this.getPixelColor(data, x, y);
            if (!this.colorsEqual(currentColor, targetColor)) continue;
            
            visited.add(key);
            fillPixels.push({x, y});
            
            stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
        }
        
        return fillPixels;
    }

    calculateMirrorPositions(x, y) {
        const positions = [];
        
        if (this.mirrorHorizontal && !this.mirrorVertical) {
            // Horizontal mirror only
            let mirrorX;
            if (this.canvasWidth % 2 === 0) {
                const centerLine = (this.canvasWidth / 2) - 0.5;
                mirrorX = Math.floor(2 * centerLine - x);
            } else {
                const centerPixel = Math.floor(this.canvasWidth / 2);
                mirrorX = 2 * centerPixel - x;
            }
            
            // Allow mirror positions even if original position is off-canvas
            if (mirrorX !== x) {
                positions.push({x: mirrorX, y: y});
            }
        }
        
        if (this.mirrorVertical && !this.mirrorHorizontal) {
            // Vertical mirror only
            let mirrorY;
            if (this.canvasHeight % 2 === 0) {
                const centerLine = (this.canvasHeight / 2) - 0.5;
                mirrorY = Math.floor(2 * centerLine - y);
            } else {
                const centerPixel = Math.floor(this.canvasHeight / 2);
                mirrorY = 2 * centerPixel - y;
            }
            
            // Allow mirror positions even if original position is off-canvas
            if (mirrorY !== y) {
                positions.push({x: x, y: mirrorY});
            }
        }
        
        if (this.mirrorHorizontal && this.mirrorVertical) {
            // Both mirrors - calculate all mirror positions
            let mirrorX, mirrorY;
            
            if (this.canvasWidth % 2 === 0) {
                const centerLine = (this.canvasWidth / 2) - 0.5;
                mirrorX = Math.floor(2 * centerLine - x);
            } else {
                const centerPixel = Math.floor(this.canvasWidth / 2);
                mirrorX = 2 * centerPixel - x;
            }
            
            if (this.canvasHeight % 2 === 0) {
                const centerLine = (this.canvasHeight / 2) - 0.5;
                mirrorY = Math.floor(2 * centerLine - y);
            } else {
                const centerPixel = Math.floor(this.canvasHeight / 2);
                mirrorY = 2 * centerPixel - y;
            }
            
            // Horizontal mirror
            if (mirrorX !== x) {
                positions.push({x: mirrorX, y: y});
            }
            
            // Vertical mirror
            if (mirrorY !== y) {
                positions.push({x: x, y: mirrorY});
            }
            
            // Diagonal mirror (both axes)
            if (mirrorX !== x || mirrorY !== y) {
                positions.push({x: mirrorX, y: mirrorY});
            }
        }
        
        return positions;
    }
    
    showPastePreview(x, y) {
        if (!this.clipboard) return;
        
        // Ensure coordinates are integers for pixel-perfect positioning
        x = Math.floor(x);
        y = Math.floor(y);
        
        // Clear overlay completely first
        this.overlayCtx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
        
        // Draw base overlays (grids etc.)
        this.drawBaseOverlays();
        
        // Save overlay context
        this.overlayCtx.save();
        
        // Disable anti-aliasing for crisp, pixel-perfect rendering
        this.overlayCtx.imageSmoothingEnabled = false;
        this.overlayCtx.webkitImageSmoothingEnabled = false;
        this.overlayCtx.mozImageSmoothingEnabled = false;
        this.overlayCtx.msImageSmoothingEnabled = false;
        
        // Calculate paste position (center the clipboard content at mouse position)
        const pasteX = Math.floor(x - this.clipboard.width / 2);
        const pasteY = Math.floor(y - this.clipboard.height / 2);
        
        // Get the clipboard image data for pixel analysis
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = this.clipboard.width;
        tempCanvas.height = this.clipboard.height;
        const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
        tempCtx.drawImage(this.clipboard.data, 0, 0);
        const imageData = tempCtx.getImageData(0, 0, this.clipboard.width, this.clipboard.height);
        const data = imageData.data;
        
        // Collect all preview positions first (including mirrors)
        const previewPositions = new Map(); // Map of "x,y" -> {redIntensity, alpha, count}
        
        // Draw preview with varying red intensity based on pixel brightness
        for (let py = 0; py < this.clipboard.height; py++) {
            for (let px = 0; px < this.clipboard.width; px++) {
                const dataIndex = (py * this.clipboard.width + px) * 4;
                const r = data[dataIndex];
                const g = data[dataIndex + 1];
                const b = data[dataIndex + 2];
                const a = data[dataIndex + 3];
                
                // Skip fully transparent pixels
                if (a === 0) continue;
                
                // Check if pixel is white or black
                const isWhite = r >= 240 && g >= 240 && b >= 240;
                const isBlack = r <= 15 && g <= 15 && b <= 15;
                
                // Determine if we should show this pixel in preview
                let showPixel = true;
                
                if (this.pasteTransparencyMode === 'white' && isWhite) {
                    showPixel = false;
                }
                if (this.pasteTransparencyMode === 'black' && isBlack) {
                    showPixel = false;
                }
                
                // Only show pixels that would actually be pasted
                if (showPixel) {
                    const drawX = pasteX + px;
                    const drawY = pasteY + py;
                    
                    // Only process if within canvas bounds
                    if (drawX >= 0 && drawX < this.canvasWidth && drawY >= 0 && drawY < this.canvasHeight) {
                        // Calculate brightness (0-255) using luminance formula
                        const brightness = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
                        
                        // Map brightness to red intensity
                        const redIntensity = Math.max(100, 255 - brightness);
                        const baseAlpha = 0.7;
                        
                        // Collect all positions for this pixel (original + mirrors)
                        const allPositions = [{ x: drawX, y: drawY }];
                        
                        // Handle mirroring for paste preview
                        if (this.mirrorHorizontal || this.mirrorVertical) {
                            const mirrorCoords = this.calculateMirrorCoordinates(drawX, drawY);
                            
                            for (const mirrorCoord of mirrorCoords) {
                                // Make sure mirror coordinates are within canvas bounds
                                if (mirrorCoord.x >= 0 && mirrorCoord.x < this.canvasWidth && 
                                    mirrorCoord.y >= 0 && mirrorCoord.y < this.canvasHeight) {
                                    allPositions.push(mirrorCoord);
                                }
                            }
                        }
                        
                        // Add all positions to the map
                        for (const pos of allPositions) {
                            const key = `${pos.x},${pos.y}`;
                            const existing = previewPositions.get(key);
                            
                            if (existing) {
                                // Accumulate effects for overlapping positions
                                previewPositions.set(key, {
                                    redIntensity: Math.max(existing.redIntensity, redIntensity),
                                    alpha: Math.min(1.0, existing.alpha + baseAlpha * 0.4),
                                    count: existing.count + 1
                                });
                            } else {
                                previewPositions.set(key, {
                                    redIntensity: redIntensity,
                                    alpha: baseAlpha,
                                    count: 1
                                });
                            }
                        }
                    }
                }
            }
        }
        
        // Now draw all collected positions
        for (const [posKey, data] of previewPositions) {
            const [x, y] = posKey.split(',').map(Number);
            // Use a more intense color for overlapping positions
            const finalAlpha = data.count > 1 ? Math.min(1.0, data.alpha * 1.2) : data.alpha;
            this.overlayCtx.fillStyle = `rgba(${data.redIntensity}, 0, 0, ${finalAlpha})`;
            this.overlayCtx.fillRect(x, y, 1, 1);
        }
        
        // Restore overlay context
        this.overlayCtx.restore();
    }
    
    // Ensure gradient editing preview is maintained
    ensureGradientEditingPreview() {
        if (this.isEditingGradientSettings && 
            this.currentTool === 'bucket' && 
            (this.fillPattern.startsWith('gradient-') || this.fillPattern !== 'solid')) {
            // Force update the preview to show red
            this.updateGradientLivePreview();
            
            // Set up a recurring check to maintain the preview
            if (!this.gradientEditingInterval) {
                this.gradientEditingInterval = setInterval(() => {
                    if (this.isEditingGradientSettings && 
                        this.currentTool === 'bucket' && 
                        (this.fillPattern.startsWith('gradient-') || this.fillPattern !== 'solid')) {
                        
                        // Only update full preview if mouse is NOT on canvas AND no targeted preview is showing
                        if (this.lastMouseEvent) {
                            const pos = this.getMousePos(this.lastMouseEvent);
                            const isOnCanvas = this.isWithinCanvas(pos.x, pos.y);
                            
                            // Only show full preview when mouse is off canvas
                            // And don't interfere if we have a lastPreviewArea (targeted preview active)
                            if (!isOnCanvas && !this.lastPreviewArea) {
                                this.updateGradientLivePreview();
                            }
                        } else {
                            // If no mouse position and no targeted preview, default to full preview
                            if (!this.lastPreviewArea) {
                                this.updateGradientLivePreview();
                            }
                        }
                    } else {
                        // Clear interval if no longer editing
                        clearInterval(this.gradientEditingInterval);
                        this.gradientEditingInterval = null;
                    }
                }, 100); // Reduced frequency to 100ms to reduce conflicts
            }
        }
    }

    updateGradientLivePreview() {
        // Only show live preview when bucket tool is selected
        if (this.currentTool !== 'bucket') {
            return;
        }
        
        // Clear overlay and redraw base layers
        this.overlayCtx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
        
        // For gradients and other patterns, show full canvas preview
        if (this.fillPattern.startsWith('gradient-') || this.fillPattern !== 'solid') {
            // For gradients, show a full canvas preview with transparency
            this.overlayCtx.globalAlpha = 0.5; // Semi-transparent so you can see the underlying canvas
            
            // Sample the pattern at regular intervals for performance
            const sampleRate = 1; // Use 1 for better detail
            
            for (let y = 0; y < this.canvasHeight; y += sampleRate) {
                for (let x = 0; x < this.canvasWidth; x += sampleRate) {
                    let shouldShowPixel = true;
                    
                    if (this.fillPattern.startsWith('gradient-')) {
                        // Get the actual gradient color for this position
                        const hexColor = this.getGradientColor(x, y, this.fillPattern, this.currentColor);
                        
                        if (this.fillPattern.includes('-dither') || this.fillPattern.includes('-stipple')) {
                            // For dithered gradients, check if this pixel would be filled
                            if ((this.currentColor === 'black' && hexColor === '#ffffff') ||
                                (this.currentColor === 'white' && hexColor === '#000000')) {
                                shouldShowPixel = false;
                            }
                        }
                    } else {
                        // For non-gradient patterns, use shouldFillPixel
                        shouldShowPixel = this.shouldFillPixel(x, y, this.fillPattern);
                    }
                    
                    if (shouldShowPixel) {
                        // Show red preview when editing settings, actual colors otherwise
                        if (this.isEditingGradientSettings) {
                            this.overlayCtx.fillStyle = 'rgba(255, 0, 0, 1.0)'; // Red when editing
                        } else {
                            // Show the actual color for preview
                            if (this.fillPattern.startsWith('gradient-')) {
                                const hexColor = this.getGradientColor(x, y, this.fillPattern, this.currentColor);
                                const { r, g, b } = this.hexToRgba(hexColor);
                                this.overlayCtx.fillStyle = `rgba(${r}, ${g}, ${b}, 1.0)`;
                            } else {
                                // For non-gradient patterns, use current color
                                const color = this.currentColor === 'black' ? '0, 0, 0' : '255, 255, 255';
                                this.overlayCtx.fillStyle = `rgba(${color}, 1.0)`;
                            }
                        }
                        this.overlayCtx.fillRect(x, y, sampleRate, sampleRate);
                    }
                }
            }
        } else if (this.lastPreviewArea && this.lastPreviewArea.pixels) {
            // For all other patterns, use targeted area preview if available
            this.overlayCtx.globalAlpha = 0.6; // Semi-transparent for area preview
            
            // Apply the current pattern to the stored preview area
            this.lastPreviewArea.pixels.forEach(pixel => {
                let shouldShowPixel = true;
                
                if (this.fillPattern.startsWith('gradient-')) {
                    // For gradient patterns, use the exact same logic as performFloodFill
                    if (this.fillPattern.includes('-dither') || this.fillPattern.includes('-stipple')) {
                        // For dithered gradients, check if this pixel would be filled
                        const hexColor = this.getGradientColor(pixel.x, pixel.y, this.fillPattern, this.currentColor);
                        if ((this.currentColor === 'black' && hexColor === '#ffffff') ||
                            (this.currentColor === 'white' && hexColor === '#000000')) {
                            shouldShowPixel = false;
                        }
                    }
                    // For regular gradients, all pixels are filled (shouldShowPixel stays true)
                } else if (this.fillPattern !== 'solid') {
                    // For non-gradient patterns, check if pixel should be filled
                    shouldShowPixel = this.shouldFillPixel(pixel.x, pixel.y, this.fillPattern);
                }
                
                if (shouldShowPixel) {
                    this.overlayCtx.fillStyle = 'rgba(255, 0, 0, 1)';
                    this.overlayCtx.fillRect(pixel.x, pixel.y, 1, 1);
                }
            });
        }
        
        // Reset overlay context
        this.overlayCtx.globalAlpha = 1;
    }

    drawMirroredPenPreview(x, y) {
        // Calculate mirror lines based on even/odd pixel count
        // For even width: mirror across line between center pixels (e.g. 144 pixels: mirror line at 71.5)
        // For odd width: center pixel serves as mirror line (e.g. 143 pixels: center at 71)
        
        if (this.mirrorHorizontal && !this.mirrorVertical) {
            // Horizontal mirror only
            let mirrorX;
            if (this.canvasWidth % 2 === 0) {
                // Even width: mirror across line between center pixels
                const centerLine = (this.canvasWidth / 2) - 0.5;
                mirrorX = Math.floor(2 * centerLine - x);
            } else {
                // Odd width: mirror across center pixel
                const centerPixel = Math.floor(this.canvasWidth / 2);
                mirrorX = 2 * centerPixel - x;
            }
            
            if (mirrorX >= 0 && mirrorX < this.canvasWidth && mirrorX !== x) {
                if (this.brushShape === 'circle') {
                    this.drawCircleBrushPreview(mirrorX, y, this.brushSize);
                } else {
                    this.drawSquareBrushPreview(mirrorX, y, this.brushSize);
                }
            }
        }
        
        if (this.mirrorVertical && !this.mirrorHorizontal) {
            // Vertical mirror only
            let mirrorY;
            if (this.canvasHeight % 2 === 0) {
                // Even height: mirror across line between center pixels
                const centerLine = (this.canvasHeight / 2) - 0.5;
                mirrorY = Math.floor(2 * centerLine - y);
            } else {
                // Odd height: mirror across center pixel
                const centerPixel = Math.floor(this.canvasHeight / 2);
                mirrorY = 2 * centerPixel - y;
            }
            
            if (mirrorY >= 0 && mirrorY < this.canvasHeight && mirrorY !== y) {
                if (this.brushShape === 'circle') {
                    this.drawCircleBrushPreview(x, mirrorY, this.brushSize);
                } else {
                    this.drawSquareBrushPreview(x, mirrorY, this.brushSize);
                }
            }
        }
        
        if (this.mirrorHorizontal && this.mirrorVertical) {
            // Both mirrors - calculate both mirror positions
            let mirrorX, mirrorY;
            
            if (this.canvasWidth % 2 === 0) {
                const centerLine = (this.canvasWidth / 2) - 0.5;
                mirrorX = Math.floor(2 * centerLine - x);
            } else {
                const centerPixel = Math.floor(this.canvasWidth / 2);
                mirrorX = 2 * centerPixel - x;
            }
            
            if (this.canvasHeight % 2 === 0) {
                const centerLine = (this.canvasHeight / 2) - 0.5;
                mirrorY = Math.floor(2 * centerLine - y);
            } else {
                const centerPixel = Math.floor(this.canvasHeight / 2);
                mirrorY = 2 * centerPixel - y;
            }
            
            // Horizontal mirror
            if (mirrorX >= 0 && mirrorX < this.canvasWidth && mirrorX !== x) {
                if (this.brushShape === 'circle') {
                    this.drawCircleBrushPreview(mirrorX, y, this.brushSize);
                } else {
                    this.drawSquareBrushPreview(mirrorX, y, this.brushSize);
                }
            }
            
            // Vertical mirror
            if (mirrorY >= 0 && mirrorY < this.canvasHeight && mirrorY !== y) {
                if (this.brushShape === 'circle') {
                    this.drawCircleBrushPreview(x, mirrorY, this.brushSize);
                } else {
                    this.drawSquareBrushPreview(x, mirrorY, this.brushSize);
                }
            }
            
            // Diagonal mirror (both axes)
            if (mirrorX >= 0 && mirrorX < this.canvasWidth && mirrorY >= 0 && mirrorY < this.canvasHeight && 
                (mirrorX !== x || mirrorY !== y)) {
                if (this.brushShape === 'circle') {
                    this.drawCircleBrushPreview(mirrorX, mirrorY, this.brushSize);
                } else {
                    this.drawSquareBrushPreview(mirrorX, mirrorY, this.brushSize);
                }
            }
        }
    }
    
    // Shape drawing methods
    startShape(shapeType, pos) {
        this.shapeStart = pos;
        this.currentShape = shapeType;
        // Capture snapshot before drawing shape
        this.captureSnapshot();
    }
    
    updateShapePreview(pos) {
        if (!this.shapeStart || !this.currentShape) return;
        
        // Clear overlay and redraw base layers
        this.clearOverlayAndRedrawBase();
        
        // Set preview style once for the entire operation
        this.overlayCtx.fillStyle = '#ff0000';
        this.overlayCtx.globalAlpha = 1.0;
        
        const startX = this.shapeStart.x;
        const startY = this.shapeStart.y;
        const endX = pos.x;
        const endY = pos.y;
        
        if (this.currentShape === 'circle') {
            const isPerfect = this.shapeMode.includes('perfect') || this.shiftKey;
            const isCenter = this.shapeMode.includes('center') || this.shiftKey;
            
            if (isPerfect && isCenter) {
                // Perfect center: draw perfect circle bounded by rectangle from center
                const halfWidth = Math.abs(endX - startX);
                const halfHeight = Math.abs(endY - startY);
                const radius = Math.max(halfWidth, halfHeight); // Use larger dimension for perfect circle
                this.drawCirclePreview(startX, startY, radius);
                this.showMirroredShapePreview('circle', startX, startY, radius, 0, 0);
            } else if (isPerfect) {
                // Perfect corner: draw circle bounded by perfect square from corner
                const width = Math.abs(endX - startX);
                const height = Math.abs(endY - startY);
                const size = Math.max(width, height); // Make it a perfect square
                const x2 = startX + (endX > startX ? size : -size);
                const y2 = startY + (endY > startY ? size : -size);
                
                // Draw pixel-perfect circle bounded by this perfect square
                // Use precise center calculation for better symmetry
                const centerX = (startX + x2) / 2;
                const centerY = (startY + y2) / 2;
                const radius = size / 2;
                
                // Use ellipse preview with equal width/height for pixel-perfect circle
                const x1 = startX;
                const y1 = startY;
                this.drawEllipsePreview(x1, y1, x2, y2);
                this.showMirroredShapePreview('ellipse', x1, y1, 0, x2, y2);
            } else if (isCenter) {
                // Center: draw ellipse bounded by rectangle from center
                const halfWidth = Math.abs(endX - startX);
                const halfHeight = Math.abs(endY - startY);
                const x1 = startX - halfWidth;
                const y1 = startY - halfHeight;
                const x2 = startX + halfWidth;
                const y2 = startY + halfHeight;
                this.drawEllipsePreview(x1, y1, x2, y2);
                this.showMirroredShapePreview('ellipse', x1, y1, 0, x2, y2);
            } else {
                // Corner: draw ellipse from corner to corner
                this.drawEllipsePreview(startX, startY, endX, endY);
                this.showMirroredShapePreview('ellipse', startX, startY, 0, endX, endY);
            }
        } else if (this.currentShape === 'square') {
            const isPerfect = this.shapeMode.includes('perfect') || this.shiftKey;
            const isCenter = this.shapeMode.includes('center') || this.shiftKey;
            
            if (isPerfect && isCenter) {
                // Perfect center: draw perfect square from center outward
                const halfWidth = Math.abs(endX - startX);
                const halfHeight = Math.abs(endY - startY);
                const halfSize = Math.max(halfWidth, halfHeight); // Make it square
                const x1 = startX - halfSize;
                const y1 = startY - halfSize;
                const x2 = startX + halfSize;
                const y2 = startY + halfSize;
                this.drawRectanglePreview(x1, y1, x2, y2);
                this.showMirroredShapePreview('rectangle', x1, y1, 0, x2, y2);
            } else if (isPerfect) {
                // Perfect corner: draw perfect square from corner
                const width = Math.abs(endX - startX);
                const height = Math.abs(endY - startY);
                const size = Math.max(width, height);
                const x2 = startX + (endX > startX ? size : -size);
                const y2 = startY + (endY > startY ? size : -size);
                this.drawRectanglePreview(startX, startY, x2, y2);
                this.showMirroredShapePreview('rectangle', startX, startY, 0, x2, y2);
            } else if (isCenter) {
                // Center: draw rectangle from center outward
                const halfWidth = Math.abs(endX - startX);
                const halfHeight = Math.abs(endY - startY);
                const x1 = startX - halfWidth;
                const y1 = startY - halfHeight;
                const x2 = startX + halfWidth;
                const y2 = startY + halfHeight;
                this.drawRectanglePreview(x1, y1, x2, y2);
                this.showMirroredShapePreview('rectangle', x1, y1, 0, x2, y2);
            } else {
                // Corner: draw rectangle from corner to corner
                this.drawRectanglePreview(startX, startY, endX, endY);
                this.showMirroredShapePreview('rectangle', startX, startY, 0, endX, endY);
            }
        } else if (this.currentShape === 'polygon') {
            // Always use perfect center mode: draw perfect polygon bounded by rectangle from center
            const halfWidth = Math.abs(endX - startX);
            const halfHeight = Math.abs(endY - startY);
            const radius = Math.max(halfWidth, halfHeight); // Use larger dimension for perfect polygon
            
            // Calculate rotation angle from center to mouse (unless shift is held)
            let rotation = 0;
            if (!this.shiftKey) {
                const deltaX = endX - startX;
                const deltaY = endY - startY;
                rotation = Math.atan2(deltaY, deltaX);
            }
            
            this.drawPolygonPreview(startX, startY, radius, rotation);
            this.showMirroredShapePreview('polygon', startX, startY, radius, rotation, 0);
        }
    }
    
    drawEllipsePreview(x1, y1, x2, y2) {
        // Calculate precise center and radii for better circle symmetry
        const width = Math.abs(x2 - x1);
        const height = Math.abs(y2 - y1);
        const centerX = (x1 + x2) / 2;
        const centerY = (y1 + y2) / 2;
        const radiusX = width / 2;
        const radiusY = height / 2;
        
        if (radiusX < 1 || radiusY < 1) return; // Skip tiny ellipses
        
        if (this.shapeFillMode === 'filled') {
            // Draw filled ellipse preview - use floor/ceil for pixel boundaries
            const minX = Math.floor(centerX - radiusX);
            const maxX = Math.floor(centerX + radiusX);
            const minY = Math.floor(centerY - radiusY);
            const maxY = Math.floor(centerY + radiusY);
            
            for (let x = minX; x <= maxX; x++) {
                for (let y = minY; y <= maxY; y++) {
                    // Use actual pixel center for ellipse equation
                    const dx = x - centerX;
                    const dy = y - centerY;
                    // Ellipse equation: (x/rx)² + (y/ry)² <= 1
                    if ((dx * dx) / (radiusX * radiusX) + (dy * dy) / (radiusY * radiusY) <= 1) {
                        this.setPreviewPixel(x, y);
                    }
                }
            }
            return;
        }
        
        // Draw ellipse outline with thickness
        const thickness = this.shapeThickness;
        
        if (thickness === 1) {
            // Single pixel outline - use proper edge detection with pixel centers
            const minX = Math.floor(centerX - radiusX - 1);
            const maxX = Math.floor(centerX + radiusX + 1);
            const minY = Math.floor(centerY - radiusY - 1);
            const maxY = Math.floor(centerY + radiusY + 1);
            
            for (let x = minX; x <= maxX; x++) {
                for (let y = minY; y <= maxY; y++) {
                    const dx = x - centerX;
                    const dy = y - centerY;
                    const distance = (dx * dx) / (radiusX * radiusX) + (dy * dy) / (radiusY * radiusY);
                    
                    // Check if this pixel is on the edge by seeing if it's inside but neighbors are outside
                    if (distance <= 1.0) {
                        // This pixel is inside the ellipse, check if it's on the edge
                        const dx1 = (x + 1) - centerX;
                        const dx_1 = (x - 1) - centerX;
                        const dy1 = (y + 1) - centerY;
                        const dy_1 = (y - 1) - centerY;
                        
                        const hasOutsideNeighbor = 
                            (dx1 * dx1) / (radiusX * radiusX) + (dy * dy) / (radiusY * radiusY) > 1.0 ||
                            (dx_1 * dx_1) / (radiusX * radiusX) + (dy * dy) / (radiusY * radiusY) > 1.0 ||
                            (dx * dx) / (radiusX * radiusX) + (dy1 * dy1) / (radiusY * radiusY) > 1.0 ||
                            (dx * dx) / (radiusX * radiusX) + (dy_1 * dy_1) / (radiusY * radiusY) > 1.0;
                        
                        if (hasOutsideNeighbor) {
                            this.setPreviewPixel(x, y);
                        }
                    }
                }
            }
        } else {
            // Multi-pixel thickness - draw between outer and inner ellipse
            const halfThickness = thickness / 2;
            const outerRadiusX = radiusX + halfThickness;
            const outerRadiusY = radiusY + halfThickness;
            const innerRadiusX = Math.max(0, radiusX - halfThickness);
            const innerRadiusY = Math.max(0, radiusY - halfThickness);
            
            const minX = Math.floor(centerX - outerRadiusX - 1);
            const maxX = Math.floor(centerX + outerRadiusX + 1);
            const minY = Math.floor(centerY - outerRadiusY - 1);
            const maxY = Math.floor(centerY + outerRadiusY + 1);
            
            for (let x = minX; x <= maxX; x++) {
                for (let y = minY; y <= maxY; y++) {
                    const dx = x - centerX;
                    const dy = y - centerY;
                    const outerTest = (dx * dx) / (outerRadiusX * outerRadiusX) + (dy * dy) / (outerRadiusY * outerRadiusY);
                    const innerTest = (dx * dx) / (innerRadiusX * innerRadiusX) + (dy * dy) / (innerRadiusY * innerRadiusY);
                    
                    if (outerTest <= 1 && (innerRadiusX <= 0 || innerRadiusY <= 0 || innerTest > 1)) {
                        this.setPreviewPixel(x, y);
                    }
                }
            }
        }
    }

    drawCirclePreview(centerX, centerY, radius) {
        if (radius < 1) return; // Skip tiny circles
        
        if (this.shapeFillMode === 'filled') {
            // Use pixel-perfect filled circle preview with bounds checking
            for (let y = -radius; y <= radius; y++) {
                for (let x = -radius; x <= radius; x++) {
                    if (x * x + y * y <= radius * radius) {
                        this.setPreviewPixel(centerX + x, centerY + y);
                    }
                }
            }
            return;
        }
        
        // Draw circle outline preview with thickness
        const thickness = this.shapeThickness;
        
        if (thickness === 1) {
            // Single pixel outline using Bresenham
            this.bresenhamCirclePreview(centerX, centerY, radius);
        } else {
            // For thick outlines, draw pixel by pixel to avoid compositing issues
            const outerRadius = this.shapeStrokePosition === 'outside' ? radius + thickness - 1 : 
                               this.shapeStrokePosition === 'centered' ? radius + Math.floor((thickness - 1) / 2) : radius;
            const innerRadius = this.shapeStrokePosition === 'outside' ? radius : 
                               this.shapeStrokePosition === 'centered' ? radius - Math.floor(thickness / 2) : radius - thickness + 1;
            
            // Draw the thick circle preview pixel by pixel to avoid erasing other previews
            for (let x = -outerRadius; x <= outerRadius; x++) {
                for (let y = -outerRadius; y <= outerRadius; y++) {
                    const distance = Math.sqrt(x * x + y * y);
                    if (distance <= outerRadius) {
                        // If innerRadius is 0 or negative, fill the entire circle
                        // Otherwise, only fill the ring between inner and outer radius
                        if (innerRadius <= 0 || distance >= innerRadius) {
                            this.setPreviewPixel(centerX + x, centerY + y);
                        }
                    }
                }
            }
        }
    }
    
    bresenhamCirclePreview(centerX, centerY, radius) {
        // Bresenham's circle algorithm for pixel-perfect preview
        // Handle floating point centers by rounding
        const cx = Math.round(centerX);
        const cy = Math.round(centerY);
        const r = Math.floor(radius);
        
        let x = 0;
        let y = r;
        let d = 3 - 2 * r;
        
        while (y >= x) {
            // Draw 8 points of the circle in red
            this.setPreviewPixel(cx + x, cy + y);
            this.setPreviewPixel(cx - x, cy + y);
            this.setPreviewPixel(cx + x, cy - y);
            this.setPreviewPixel(cx - x, cy - y);
            this.setPreviewPixel(cx + y, cy + x);
            this.setPreviewPixel(cx - y, cy + x);
            this.setPreviewPixel(cx + y, cy - x);
            this.setPreviewPixel(cx - y, cy - x);
            
            x++;
            
            if (d > 0) {
                y--;
                d = d + 4 * (x - y) + 10;
            } else {
                d = d + 4 * x + 6;
            }
        }
    }
    
    drawRectanglePreview(x1, y1, x2, y2) {
        const minX = Math.min(x1, x2);
        const maxX = Math.max(x1, x2);
        const minY = Math.min(y1, y2);
        const maxY = Math.max(y1, y2);
        
        if (this.shapeFillMode === 'filled') {
            // Preview filled rectangle
            for (let x = minX; x <= maxX; x++) {
                for (let y = minY; y <= maxY; y++) {
                    this.setPreviewPixel(x, y);
                }
            }
            return;
        }
        
        // Preview rectangle outline with thickness
        const thickness = this.shapeThickness;
        
        if (this.shapeStrokePosition === 'outside') {
            // Preview outside rectangle
            for (let t = 0; t < thickness; t++) {
                const adjustedMinX = minX - t;
                const adjustedMaxX = maxX + t;
                const adjustedMinY = minY - t;
                const adjustedMaxY = maxY + t;
                
                // Draw preview border
                for (let x = adjustedMinX; x <= adjustedMaxX; x++) {
                    this.setPreviewPixel(x, adjustedMinY);
                    this.setPreviewPixel(x, adjustedMaxY);
                }
                for (let y = adjustedMinY; y <= adjustedMaxY; y++) {
                    this.setPreviewPixel(adjustedMinX, y);
                    this.setPreviewPixel(adjustedMaxX, y);
                }
            }
        } else if (this.shapeStrokePosition === 'inside') {
            // Preview inside rectangle
            for (let t = 0; t < thickness; t++) {
                const adjustedMinX = minX + t;
                const adjustedMaxX = maxX - t;
                const adjustedMinY = minY + t;
                const adjustedMaxY = maxY - t;
                
                if (adjustedMinX > adjustedMaxX || adjustedMinY > adjustedMaxY) break;
                
                for (let x = adjustedMinX; x <= adjustedMaxX; x++) {
                    this.setPreviewPixel(x, adjustedMinY);
                    this.setPreviewPixel(x, adjustedMaxY);
                }
                for (let y = adjustedMinY; y <= adjustedMaxY; y++) {
                    this.setPreviewPixel(adjustedMinX, y);
                    this.setPreviewPixel(adjustedMaxX, y);
                }
            }
        } else { // 'centered'
            // Preview centered rectangle
            const halfThickness = Math.floor(thickness / 2);
            
            for (let t = -halfThickness; t <= halfThickness; t++) {
                const adjustedMinX = minX + t;
                const adjustedMaxX = maxX - t;
                const adjustedMinY = minY + t;
                const adjustedMaxY = maxY - t;
                
                if (adjustedMinX > adjustedMaxX || adjustedMinY > adjustedMaxY) continue;
                
                for (let x = adjustedMinX; x <= adjustedMaxX; x++) {
                    this.setPreviewPixel(x, adjustedMinY);
                    this.setPreviewPixel(x, adjustedMaxY);
                }
                for (let y = adjustedMinY; y <= adjustedMaxY; y++) {
                    this.setPreviewPixel(adjustedMinX, y);
                    this.setPreviewPixel(adjustedMaxX, y);
                }
            }
        }
    }
    
    setPreviewPixel(x, y) {
        if (x >= 0 && x < this.canvasWidth && y >= 0 && y < this.canvasHeight) {
            // Use red color for polygon preview
            this.overlayCtx.fillStyle = '#ff0000';
            this.overlayCtx.fillRect(x, y, 1, 1);
        }
    }
    
    showMirroredShapePreview(shapeType, startX, startY, radius, endX, endY) {
        // Only show mirror previews if mirroring is enabled
        if (!this.mirrorHorizontal && !this.mirrorVertical) return;
        
        if (shapeType === 'circle') {
            // Calculate mirror positions for the circle center
            const mirrorPositions = this.calculateMirrorPositions(startX, startY);
            mirrorPositions.forEach(mirrorPos => {
                this.drawCirclePreview(mirrorPos.x, mirrorPos.y, radius);
            });
        } else if (shapeType === 'ellipse') {
            // For ellipses, we need to mirror both corners properly
            const mirrorPositions = this.calculateMirrorShapePositions(startX, startY, endX, endY);
            mirrorPositions.forEach(mirror => {
                this.drawEllipsePreview(mirror.x1, mirror.y1, mirror.x2, mirror.y2);
            });
        } else if (shapeType === 'rectangle') {
            // For rectangles, we need to mirror both corners properly
            const mirrorPositions = this.calculateMirrorShapePositions(startX, startY, endX, endY);
            mirrorPositions.forEach(mirror => {
                this.drawRectanglePreview(mirror.x1, mirror.y1, mirror.x2, mirror.y2);
            });
        } else if (shapeType === 'polygon') {
            // For polygons, mirror the center position and keep the same radius and rotation
            const rotation = endX; // endX parameter is used for rotation in polygon case
            const mirrorPositions = this.calculateMirrorPositions(startX, startY);
            mirrorPositions.forEach(mirrorPos => {
                this.drawPolygonPreview(mirrorPos.x, mirrorPos.y, radius, rotation);
            });
        }
    }
    
    getMirrorX(x) {
        let mirrorX;
        if (this.canvasWidth % 2 === 0) {
            const centerLine = (this.canvasWidth / 2) - 0.5;
            mirrorX = Math.floor(2 * centerLine - x);
        } else {
            const centerPixel = Math.floor(this.canvasWidth / 2);
            mirrorX = 2 * centerPixel - x;
        }
        
        if (mirrorX !== x) {
            return mirrorX;
        }
        return null;
    }
    
    getMirrorY(y) {
        let mirrorY;
        if (this.canvasHeight % 2 === 0) {
            const centerLine = (this.canvasHeight / 2) - 0.5;
            mirrorY = Math.floor(2 * centerLine - y);
        } else {
            const centerPixel = Math.floor(this.canvasHeight / 2);
            mirrorY = 2 * centerPixel - y;
        }
        
        if (mirrorY !== y) {
            return mirrorY;
        }
        return null;
    }
    
    finalizeShape(pos) {
        if (!this.shapeStart || !this.currentShape) return;
        
        const ctx = this.getCurrentFrameContext();
        const startX = this.shapeStart.x;
        const startY = this.shapeStart.y;
        const endX = pos.x;
        const endY = pos.y;
        
        // Capture canvas state before drawing
        const beforeImageData = ctx.getImageData(0, 0, this.canvasWidth, this.canvasHeight);
        
        // Draw the shape
        if (this.currentShape === 'circle') {
            const isPerfect = this.shapeMode.includes('perfect') || this.shiftKey;
            const isCenter = this.shapeMode.includes('center') || this.shiftKey;
            
            if (isPerfect && isCenter) {
                // Perfect center: draw perfect circle bounded by rectangle from center
                const halfWidth = Math.abs(endX - startX);
                const halfHeight = Math.abs(endY - startY);
                const radius = Math.max(halfWidth, halfHeight); // Use larger dimension for perfect circle
                this.drawCircle(startX, startY, radius, ctx);
                
                // Draw mirrored circles
                if (this.mirrorHorizontal || this.mirrorVertical) {
                    const mirrorPositions = this.calculateMirrorPositions(startX, startY);
                    mirrorPositions.forEach(mirrorPos => {
                        this.drawCircle(mirrorPos.x, mirrorPos.y, radius, ctx);
                    });
                }
            } else if (isPerfect) {
                // Perfect corner: draw circle bounded by perfect square from corner
                const width = Math.abs(endX - startX);
                const height = Math.abs(endY - startY);
                const size = Math.max(width, height); // Make it a perfect square
                const x2 = startX + (endX > startX ? size : -size);
                const y2 = startY + (endY > startY ? size : -size);
                
                // Draw pixel-perfect circle bounded by this perfect square using ellipse method
                // Use precise coordinates for better symmetry
                this.drawEllipse(startX, startY, x2, y2, ctx);
                
                // Draw mirrored ellipses
                if (this.mirrorHorizontal || this.mirrorVertical) {
                    const mirrorPositions = this.calculateMirrorShapePositions(startX, startY, x2, y2);
                    mirrorPositions.forEach(mirror => {
                        this.drawEllipse(mirror.x1, mirror.y1, mirror.x2, mirror.y2, ctx);
                    });
                }
            } else if (isCenter) {
                // Center: draw ellipse bounded by rectangle from center
                const halfWidth = Math.abs(endX - startX);
                const halfHeight = Math.abs(endY - startY);
                const x1 = startX - halfWidth;
                const y1 = startY - halfHeight;
                const x2 = startX + halfWidth;
                const y2 = startY + halfHeight;
                this.drawEllipse(x1, y1, x2, y2, ctx);
                
                // Draw mirrored ellipses
                if (this.mirrorHorizontal || this.mirrorVertical) {
                    const mirrorPositions = this.calculateMirrorShapePositions(x1, y1, x2, y2);
                    mirrorPositions.forEach(mirror => {
                        this.drawEllipse(mirror.x1, mirror.y1, mirror.x2, mirror.y2, ctx);
                    });
                }
            } else {
                // Corner: draw ellipse from corner to corner
                this.drawEllipse(startX, startY, endX, endY, ctx);
                
                // Draw mirrored ellipses
                if (this.mirrorHorizontal || this.mirrorVertical) {
                    const mirrorPositions = this.calculateMirrorShapePositions(startX, startY, endX, endY);
                    mirrorPositions.forEach(mirror => {
                        this.drawEllipse(mirror.x1, mirror.y1, mirror.x2, mirror.y2, ctx);
                    });
                }
            }
        } else if (this.currentShape === 'square') {
            const isPerfect = this.shapeMode.includes('perfect') || this.shiftKey;
            const isCenter = this.shapeMode.includes('center') || this.shiftKey;
            
            if (isPerfect && isCenter) {
                // Perfect center: draw perfect square from center outward
                const halfWidth = Math.abs(endX - startX);
                const halfHeight = Math.abs(endY - startY);
                const halfSize = Math.max(halfWidth, halfHeight); // Make it square
                const x1 = startX - halfSize;
                const y1 = startY - halfSize;
                const x2 = startX + halfSize;
                const y2 = startY + halfSize;
                this.drawRectangle(x1, y1, x2, y2, ctx);
                
                // Draw mirrored squares
                if (this.mirrorHorizontal || this.mirrorVertical) {
                    const mirrorPositions = this.calculateMirrorShapePositions(x1, y1, x2, y2);
                    mirrorPositions.forEach(mirror => {
                        this.drawRectangle(mirror.x1, mirror.y1, mirror.x2, mirror.y2, ctx);
                    });
                }
            } else if (isPerfect) {
                // Perfect corner: draw perfect square from corner
                const width = Math.abs(endX - startX);
                const height = Math.abs(endY - startY);
                const size = Math.max(width, height);
                const x2 = startX + (endX > startX ? size : -size);
                const y2 = startY + (endY > startY ? size : -size);
                this.drawRectangle(startX, startY, x2, y2, ctx);
                
                // Draw mirrored squares
                if (this.mirrorHorizontal || this.mirrorVertical) {
                    const mirrorPositions = this.calculateMirrorShapePositions(startX, startY, x2, y2);
                    mirrorPositions.forEach(mirror => {
                        this.drawRectangle(mirror.x1, mirror.y1, mirror.x2, mirror.y2, ctx);
                    });
                }
            } else if (isCenter) {
                // Center: draw rectangle from center outward
                const halfWidth = Math.abs(endX - startX);
                const halfHeight = Math.abs(endY - startY);
                const x1 = startX - halfWidth;
                const y1 = startY - halfHeight;
                const x2 = startX + halfWidth;
                const y2 = startY + halfHeight;
                this.drawRectangle(x1, y1, x2, y2, ctx);
                
                // Draw mirrored rectangles
                if (this.mirrorHorizontal || this.mirrorVertical) {
                    const mirrorPositions = this.calculateMirrorShapePositions(x1, y1, x2, y2);
                    mirrorPositions.forEach(mirror => {
                        this.drawRectangle(mirror.x1, mirror.y1, mirror.x2, mirror.y2, ctx);
                    });
                }
            } else {
                // Corner: draw rectangle from corner to corner
                this.drawRectangle(startX, startY, endX, endY, ctx);
                
                // Draw mirrored rectangles
                if (this.mirrorHorizontal || this.mirrorVertical) {
                    const mirrorPositions = this.calculateMirrorShapePositions(startX, startY, endX, endY);
                    mirrorPositions.forEach(mirror => {
                        this.drawRectangle(mirror.x1, mirror.y1, mirror.x2, mirror.y2, ctx);
                    });
                }
            }
        } else if (this.currentShape === 'polygon') {
            // Always use perfect center mode: draw perfect polygon bounded by rectangle from center
            const halfWidth = Math.abs(endX - startX);
            const halfHeight = Math.abs(endY - startY);
            let radius = Math.max(halfWidth, halfHeight); // Use larger dimension for perfect polygon
            
            // Limit radius to prevent issues when mouse goes off-canvas
            const maxRadius = Math.max(this.canvasWidth, this.canvasHeight) * 2;
            radius = Math.min(radius, maxRadius);
            
            // Calculate rotation angle from center to mouse (unless shift is held)
            let rotation = 0;
            if (!this.shiftKey) {
                const deltaX = endX - startX;
                const deltaY = endY - startY;
                rotation = Math.atan2(deltaY, deltaX);
            }
            
            this.drawPolygon(startX, startY, radius, rotation, ctx);
            
            // Draw mirrored polygons
            if (this.mirrorHorizontal || this.mirrorVertical) {
                const mirrorPositions = this.calculateMirrorPositions(startX, startY);
                mirrorPositions.forEach(mirrorPos => {
                    this.drawPolygon(mirrorPos.x, mirrorPos.y, radius, rotation, ctx);
                });
            }
        }
        
        // Push undo snapshot after shape is drawn
        this.pushUndo();
        
        // Clear overlay
        this.overlayCtx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
        this.redrawCanvas();
        
        // Reset shape state
        this.shapeStart = null;
        this.currentShape = null;
    }
    
    drawEllipse(x1, y1, x2, y2, ctx) {
        // Calculate precise center and radii for better circle symmetry
        const width = Math.abs(x2 - x1);
        const height = Math.abs(y2 - y1);
        const centerX = (x1 + x2) / 2;
        const centerY = (y1 + y2) / 2;
        const radiusX = width / 2;
        const radiusY = height / 2;
        
        if (radiusX < 1 || radiusY < 1) return; // Skip tiny ellipses
        
        if (this.shapeFillMode === 'filled') {
            // Draw filled ellipse - use floor/ceil for pixel boundaries
            const minX = Math.floor(centerX - radiusX);
            const maxX = Math.floor(centerX + radiusX);
            const minY = Math.floor(centerY - radiusY);
            const maxY = Math.floor(centerY + radiusY);
            
            for (let x = minX; x <= maxX; x++) {
                for (let y = minY; y <= maxY; y++) {
                    // Use actual pixel center for ellipse equation
                    const dx = x - centerX;
                    const dy = y - centerY;
                    // Ellipse equation: (x/rx)² + (y/ry)² <= 1
                    if ((dx * dx) / (radiusX * radiusX) + (dy * dy) / (radiusY * radiusY) <= 1) {
                        this.setPixelInFrame(x, y, ctx);
                    }
                }
            }
            return;
        }
        
        // Draw ellipse outline with thickness
        const thickness = this.shapeThickness;
        
        if (thickness === 1) {
            // Single pixel outline - use proper edge detection with pixel centers
            const minX = Math.floor(centerX - radiusX - 1);
            const maxX = Math.floor(centerX + radiusX + 1);
            const minY = Math.floor(centerY - radiusY - 1);
            const maxY = Math.floor(centerY + radiusY + 1);
            
            for (let x = minX; x <= maxX; x++) {
                for (let y = minY; y <= maxY; y++) {
                    const dx = x - centerX;
                    const dy = y - centerY;
                    const distance = (dx * dx) / (radiusX * radiusX) + (dy * dy) / (radiusY * radiusY);
                    
                    // Check if this pixel is on the edge by seeing if it's inside but neighbors are outside
                    if (distance <= 1.0) {
                        // This pixel is inside the ellipse, check if it's on the edge
                        const dx1 = (x + 1) - centerX;
                        const dx_1 = (x - 1) - centerX;
                        const dy1 = (y + 1) - centerY;
                        const dy_1 = (y - 1) - centerY;
                        
                        const hasOutsideNeighbor = 
                            (dx1 * dx1) / (radiusX * radiusX) + (dy * dy) / (radiusY * radiusY) > 1.0 ||
                            (dx_1 * dx_1) / (radiusX * radiusX) + (dy * dy) / (radiusY * radiusY) > 1.0 ||
                            (dx * dx) / (radiusX * radiusX) + (dy1 * dy1) / (radiusY * radiusY) > 1.0 ||
                            (dx * dx) / (radiusX * radiusX) + (dy_1 * dy_1) / (radiusY * radiusY) > 1.0;
                        
                        if (hasOutsideNeighbor) {
                            this.setPixelInFrame(x, y, ctx);
                        }
                    }
                }
            }
        } else {
            // Multi-pixel thickness - draw between outer and inner ellipse
            const halfThickness = thickness / 2;
            const outerRadiusX = radiusX + halfThickness;
            const outerRadiusY = radiusY + halfThickness;
            const innerRadiusX = Math.max(0, radiusX - halfThickness);
            const innerRadiusY = Math.max(0, radiusY - halfThickness);
            
            const minX = Math.floor(centerX - outerRadiusX - 1);
            const maxX = Math.floor(centerX + outerRadiusX + 1);
            const minY = Math.floor(centerY - outerRadiusY - 1);
            const maxY = Math.floor(centerY + outerRadiusY + 1);
            
            for (let x = minX; x <= maxX; x++) {
                for (let y = minY; y <= maxY; y++) {
                    const dx = x - centerX;
                    const dy = y - centerY;
                    const outerTest = (dx * dx) / (outerRadiusX * outerRadiusX) + (dy * dy) / (outerRadiusY * outerRadiusY);
                    const innerTest = (dx * dx) / (innerRadiusX * innerRadiusX) + (dy * dy) / (innerRadiusY * innerRadiusY);
                    
                    if (outerTest <= 1 && (innerRadiusX <= 0 || innerRadiusY <= 0 || innerTest > 1)) {
                        this.setPixelInFrame(x, y, ctx);
                    }
                }
            }
        }
    }

    calculateMirrorShapePositions(x1, y1, x2, y2) {
        const mirrorPositions = [];
        
        if (this.mirrorHorizontal && !this.mirrorVertical) {
            // Horizontal mirror only
            const mirrorX1 = this.getMirrorX(x1);
            const mirrorX2 = this.getMirrorX(x2);
            if (mirrorX1 !== null && mirrorX2 !== null) {
                mirrorPositions.push({x1: mirrorX1, y1, x2: mirrorX2, y2});
            }
        } else if (this.mirrorVertical && !this.mirrorHorizontal) {
            // Vertical mirror only
            const mirrorY1 = this.getMirrorY(y1);
            const mirrorY2 = this.getMirrorY(y2);
            if (mirrorY1 !== null && mirrorY2 !== null) {
                mirrorPositions.push({x1, y1: mirrorY1, x2, y2: mirrorY2});
            }
        } else if (this.mirrorHorizontal && this.mirrorVertical) {
            // Both mirrors
            const mirrorX1 = this.getMirrorX(x1);
            const mirrorX2 = this.getMirrorX(x2);
            const mirrorY1 = this.getMirrorY(y1);
            const mirrorY2 = this.getMirrorY(y2);
            
            // Horizontal mirror
            if (mirrorX1 !== null && mirrorX2 !== null) {
                mirrorPositions.push({x1: mirrorX1, y1, x2: mirrorX2, y2});
            }
            
            // Vertical mirror
            if (mirrorY1 !== null && mirrorY2 !== null) {
                mirrorPositions.push({x1, y1: mirrorY1, x2, y2: mirrorY2});
            }
            
            // Diagonal mirror (both axes)
            if (mirrorX1 !== null && mirrorX2 !== null && mirrorY1 !== null && mirrorY2 !== null) {
                mirrorPositions.push({x1: mirrorX1, y1: mirrorY1, x2: mirrorX2, y2: mirrorY2});
            }
        }
        
        return mirrorPositions;
    }

    drawCircle(centerX, centerY, radius, ctx) {
        if (this.shapeFillMode === 'filled') {
            // Draw filled circle using pixel-by-pixel approach for perfect fill
            const minX = Math.floor(centerX - radius);
            const maxX = Math.floor(centerX + radius);
            const minY = Math.floor(centerY - radius);
            const maxY = Math.floor(centerY + radius);
            
            for (let x = minX; x <= maxX; x++) {
                for (let y = minY; y <= maxY; y++) {
                    const dx = x - centerX;
                    const dy = y - centerY;
                    if (dx * dx + dy * dy <= radius * radius) {
                        this.setPixelInFrame(x, y, ctx);
                    }
                }
            }
            return;
        }
        
        // Draw circle outline with thickness
        const thickness = this.shapeThickness;
        
        if (thickness === 1) {
            // Single pixel outline
            this.bresenhamCircle(centerX, centerY, radius, ctx);
        } else {
            // Use filled approach for thick circles to prevent gaps
            const outerRadius = this.shapeStrokePosition === 'outside' ? radius + thickness - 1 : 
                               this.shapeStrokePosition === 'centered' ? radius + Math.floor((thickness - 1) / 2) : radius;
            const innerRadius = this.shapeStrokePosition === 'outside' ? radius : 
                               this.shapeStrokePosition === 'centered' ? radius - Math.floor(thickness / 2) : radius - thickness + 1;
            
            // Draw the thick circle with proper bounds
            const minX = Math.floor(centerX - outerRadius);
            const maxX = Math.floor(centerX + outerRadius);
            const minY = Math.floor(centerY - outerRadius);
            const maxY = Math.floor(centerY + outerRadius);
            
            for (let x = minX; x <= maxX; x++) {
                for (let y = minY; y <= maxY; y++) {
                    const dx = x - centerX;
                    const dy = y - centerY;
                    const distance = Math.sqrt(dx * dx + dy * dy);
                    if (distance <= outerRadius) {
                        // If innerRadius is 0 or negative, fill the entire circle
                        // Otherwise, only fill the ring between inner and outer radius
                        if (innerRadius <= 0 || distance >= innerRadius) {
                            this.setPixelInFrame(x, y, ctx);
                        }
                    }
                }
            }
        }
    }
    
    bresenhamCircle(centerX, centerY, radius, ctx) {
        // Bresenham's circle algorithm for pixel-perfect circles
        // Handle floating point centers by rounding
        const cx = Math.round(centerX);
        const cy = Math.round(centerY);
        const r = Math.floor(radius);
        
        let x = 0;
        let y = r;
        let d = 3 - 2 * r;
        
        while (y >= x) {
            // Draw 8 points of the circle
            this.setPixelInFrame(cx + x, cy + y, ctx);
            this.setPixelInFrame(cx - x, cy + y, ctx);
            this.setPixelInFrame(cx + x, cy - y, ctx);
            this.setPixelInFrame(cx - x, cy - y, ctx);
            this.setPixelInFrame(cx + y, cy + x, ctx);
            this.setPixelInFrame(cx - y, cy + x, ctx);
            this.setPixelInFrame(cx + y, cy - x, ctx);
            this.setPixelInFrame(cx - y, cy - x, ctx);
            
            x++;
            
            if (d > 0) {
                y--;
                d = d + 4 * (x - y) + 10;
            } else {
                d = d + 4 * x + 6;
            }
        }
    }
    
    drawRectangle(x1, y1, x2, y2, ctx) {
        const minX = Math.min(x1, x2);
        const maxX = Math.max(x1, x2);
        const minY = Math.min(y1, y2);
        const maxY = Math.max(y1, y2);
        
        if (this.shapeFillMode === 'filled') {
            // Draw filled rectangle
            for (let x = minX; x <= maxX; x++) {
                for (let y = minY; y <= maxY; y++) {
                    this.setPixelInFrame(x, y, ctx);
                    // Add mirror support for shapes
                    if (this.mirrorHorizontal || this.mirrorVertical || this.mirrorBoth) {
                        this.drawMirroredShapePixels(x, y, ctx);
                    }
                }
            }
            return;
        }
        
        // Draw rectangle outline with thickness
        const thickness = this.shapeThickness;
        
        if (this.shapeStrokePosition === 'outside') {
            // Draw outside rectangle - thickness goes outward
            for (let t = 0; t < thickness; t++) {
                const adjustedMinX = minX - t;
                const adjustedMaxX = maxX + t;
                const adjustedMinY = minY - t;
                const adjustedMaxY = maxY + t;
                
                // Horizontal lines
                for (let x = adjustedMinX; x <= adjustedMaxX; x++) {
                    this.setPixelInFrame(x, adjustedMinY, ctx);
                    this.setPixelInFrame(x, adjustedMaxY, ctx);
                    // Add mirror support for shapes
                    if (this.mirrorHorizontal || this.mirrorVertical || this.mirrorBoth) {
                        this.drawMirroredShapePixels(x, adjustedMinY, ctx);
                        this.drawMirroredShapePixels(x, adjustedMaxY, ctx);
                    }
                }
                
                // Vertical lines
                for (let y = adjustedMinY; y <= adjustedMaxY; y++) {
                    this.setPixelInFrame(adjustedMinX, y, ctx);
                    this.setPixelInFrame(adjustedMaxX, y, ctx);
                    // Add mirror support for shapes
                    if (this.mirrorHorizontal || this.mirrorVertical || this.mirrorBoth) {
                        this.drawMirroredShapePixels(adjustedMinX, y, ctx);
                        this.drawMirroredShapePixels(adjustedMaxX, y, ctx);
                    }
                }
            }
        } else if (this.shapeStrokePosition === 'inside') {
            // Draw inside rectangle - thickness goes inward
            for (let t = 0; t < thickness; t++) {
                const adjustedMinX = minX + t;
                const adjustedMaxX = maxX - t;
                const adjustedMinY = minY + t;
                const adjustedMaxY = maxY - t;
                
                if (adjustedMinX > adjustedMaxX || adjustedMinY > adjustedMaxY) break;
                
                // Horizontal lines
                for (let x = adjustedMinX; x <= adjustedMaxX; x++) {
                    this.setPixelInFrame(x, adjustedMinY, ctx);
                    this.setPixelInFrame(x, adjustedMaxY, ctx);
                    // Add mirror support for shapes
                    if (this.mirrorHorizontal || this.mirrorVertical || this.mirrorBoth) {
                        this.drawMirroredShapePixels(x, adjustedMinY, ctx);
                        this.drawMirroredShapePixels(x, adjustedMaxY, ctx);
                    }
                }
                
                // Vertical lines
                for (let y = adjustedMinY; y <= adjustedMaxY; y++) {
                    this.setPixelInFrame(adjustedMinX, y, ctx);
                    this.setPixelInFrame(adjustedMaxX, y, ctx);
                    // Add mirror support for shapes
                    if (this.mirrorHorizontal || this.mirrorVertical || this.mirrorBoth) {
                        this.drawMirroredShapePixels(adjustedMinX, y, ctx);
                        this.drawMirroredShapePixels(adjustedMaxX, y, ctx);
                    }
                }
            }
        } else { // 'centered'
            // Draw centered rectangle - thickness goes both inward and outward
            const halfThickness = Math.floor(thickness / 2);
            
            for (let t = -halfThickness; t <= halfThickness; t++) {
                const adjustedMinX = minX + t;
                const adjustedMaxX = maxX - t;
                const adjustedMinY = minY + t;
                const adjustedMaxY = maxY - t;
                
                if (adjustedMinX > adjustedMaxX || adjustedMinY > adjustedMaxY) continue;
                
                // Horizontal lines
                for (let x = adjustedMinX; x <= adjustedMaxX; x++) {
                    this.setPixelInFrame(x, adjustedMinY, ctx);
                    this.setPixelInFrame(x, adjustedMaxY, ctx);
                    // Add mirror support for shapes
                    if (this.mirrorHorizontal || this.mirrorVertical || this.mirrorBoth) {
                        this.drawMirroredShapePixels(x, adjustedMinY, ctx);
                        this.drawMirroredShapePixels(x, adjustedMaxY, ctx);
                    }
                }
                
                // Vertical lines
                for (let y = adjustedMinY; y <= adjustedMaxY; y++) {
                    this.setPixelInFrame(adjustedMinX, y, ctx);
                    this.setPixelInFrame(adjustedMaxX, y, ctx);
                    // Add mirror support for shapes
                    if (this.mirrorHorizontal || this.mirrorVertical || this.mirrorBoth) {
                        this.drawMirroredShapePixels(adjustedMinX, y, ctx);
                        this.drawMirroredShapePixels(adjustedMaxX, y, ctx);
                    }
                }
            }
        }
    }
    
    setPixelInFrame(x, y, ctx) {
        if (x >= 0 && x < this.canvasWidth && y >= 0 && y < this.canvasHeight) {
            // Use direct pixel manipulation for 100% opacity
            const imageData = ctx.getImageData(x, y, 1, 1);
            const data = imageData.data;
            
            // Convert color to RGB
            let r, g, b;
            if (this.currentColor === 'black') {
                r = g = b = 0;
            } else if (this.currentColor === 'white') {
                r = g = b = 255;
            } else {
                // Handle hex colors
                const hex = this.currentColor.replace('#', '');
                r = parseInt(hex.substr(0, 2), 16);
                g = parseInt(hex.substr(2, 2), 16);
                b = parseInt(hex.substr(4, 2), 16);
            }
            
            data[0] = r;
            data[1] = g;
            data[2] = b;
            data[3] = 255; // Full opacity
            
            ctx.putImageData(imageData, x, y);
        }
    }

    // Polygon drawing methods
    drawPolygonPreview(centerX, centerY, radius, rotation = 0) {
        const points = this.calculatePolygonPoints(centerX, centerY, radius, rotation);
        
        if (this.polygonFillMode === 'filled') {
            // Fill the polygon
            this.fillPolygonPreview(points);
        } else {
            // Draw outline only
            if (this.polygonThickness === 1) {
                // Single pixel outline
                for (let i = 0; i < points.length; i++) {
                    const start = points[i];
                    const end = points[(i + 1) % points.length];
                    this.drawLinePreview(start.x, start.y, end.x, end.y);
                }
            } else {
                // Thick outline preview
                this.drawThickPolygonOutlinePreview(points);
            }
        }
    }

    drawThickPolygonOutlinePreview(points) {
        const thickness = this.polygonThickness;
        const radius = thickness / 2;
        const halfThickness = Math.floor(thickness / 2);
        
        // First draw all the line segments
        for (let i = 0; i < points.length; i++) {
            const start = points[i];
            const end = points[(i + 1) % points.length];
            this.drawThickLinePreview(start.x, start.y, end.x, end.y, thickness);
        }
        
        // Then draw filled circles at each vertex to ensure smooth connections
        for (let i = 0; i < points.length; i++) {
            const vertex = points[i];
            
            // Draw a filled circle at each vertex
            for (let y = -halfThickness; y <= halfThickness; y++) {
                for (let x = -halfThickness; x <= halfThickness; x++) {
                    if (x * x + y * y <= radius * radius) {
                        this.setPreviewPixel(vertex.x + x, vertex.y + y);
                    }
                }
            }
        }
    }

    drawThickLinePreview(x0, y0, x1, y1, thickness) {
        if (thickness === 1) {
            this.drawLinePreview(x0, y0, x1, y1);
            return;
        }
        
        // For thick lines, use a capsule-based approach for better coverage
        const dx = x1 - x0;
        const dy = y1 - y0;
        const length = Math.sqrt(dx * dx + dy * dy);
        
        if (length === 0) {
            // Single point - draw a filled circle
            const radius = Math.floor(thickness / 2);
            for (let y = -radius; y <= radius; y++) {
                for (let x = -radius; x <= radius; x++) {
                    if (x * x + y * y <= radius * radius) {
                        this.setPreviewPixel(x0 + x, y0 + y);
                    }
                }
            }
            return;
        }
        
        // Draw the thick line using a sweep approach
        const radius = thickness / 2;
        const halfThickness = Math.floor(thickness / 2);
        
        // For each pixel along the line, draw a circle centered on that pixel
        const steps = Math.max(Math.abs(dx), Math.abs(dy));
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const centerX = Math.round(x0 + t * dx);
            const centerY = Math.round(y0 + t * dy);
            
            // Draw a filled circle at this point
            for (let y = -halfThickness; y <= halfThickness; y++) {
                for (let x = -halfThickness; x <= halfThickness; x++) {
                    if (x * x + y * y <= radius * radius) {
                        this.setPreviewPixel(centerX + x, centerY + y);
                    }
                }
            }
        }
    }

    fillPolygonPreview(points) {
        // Use scanline filling algorithm for polygon fill preview
        const minY = Math.min(...points.map(p => p.y));
        const maxY = Math.max(...points.map(p => p.y));
        
        for (let y = Math.max(0, minY); y <= Math.min(this.canvasHeight - 1, maxY); y++) {
            const intersections = [];
            
            // Find intersections of scanline with polygon edges
            for (let i = 0; i < points.length; i++) {
                const p1 = points[i];
                const p2 = points[(i + 1) % points.length];
                
                // Skip horizontal edges
                if (p1.y === p2.y) continue;
                
                if ((p1.y <= y && p2.y > y) || (p2.y <= y && p1.y > y)) {
                    // Edge crosses the scanline
                    const x = p1.x + (p2.x - p1.x) * (y - p1.y) / (p2.y - p1.y);
                    intersections.push(Math.round(x));
                }
            }
            
            // Sort intersections and fill between pairs
            intersections.sort((a, b) => a - b);
            for (let i = 0; i < intersections.length; i += 2) {
                if (i + 1 < intersections.length) {
                    const startX = Math.max(0, intersections[i]);
                    const endX = Math.min(this.canvasWidth - 1, intersections[i + 1]);
                    for (let x = startX; x <= endX; x++) {
                        this.setPreviewPixel(x, y);
                    }
                }
            }
        }
    }

    drawLinePreview(x0, y0, x1, y1) {
        const dx = Math.abs(x1 - x0);
        const dy = Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1;
        const sy = y0 < y1 ? 1 : -1;
        let err = dx - dy;
        
        let x = x0;
        let y = y0;
        
        while (true) {
            this.setPreviewPixel(x, y);
            
            if (x === x1 && y === y1) break;
            
            const e2 = 2 * err;
            if (e2 > -dy) {
                err -= dy;
                x += sx;
            }
            if (e2 < dx) {
                err += dx;
                y += sy;
            }
        }
    }

    drawPolygon(centerX, centerY, radius, rotation = 0, ctx) {
        const points = this.calculatePolygonPoints(centerX, centerY, radius, rotation);
        
        if (this.polygonFillMode === 'filled') {
            this.fillPolygon(points, ctx);
        } else {
            // Draw outline
            if (this.polygonThickness === 1) {
                this.drawPolygonOutline(points, ctx);
            } else {
                this.drawThickPolygonOutline(points, ctx);
            }
        }
    }

    calculatePolygonPoints(centerX, centerY, radius, rotation = 0) {
        const points = [];
        const sides = this.polygonSides;
        const angleStep = (Math.PI * 2) / sides;
        
        // Start angle to point upward (for odd-sided polygons like triangles), then add rotation
        const startAngle = -Math.PI / 2 + rotation;
        
        for (let i = 0; i < sides; i++) {
            const angle = startAngle + (i * angleStep);
            let x = centerX + radius * Math.cos(angle);
            let y = centerY + radius * Math.sin(angle);
            
            // Always round to pixel boundaries for crisp drawing
            x = Math.round(x);
            y = Math.round(y);
            
            points.push({ x, y });
        }
        
        return points;
    }

    drawPolygonOutline(points, ctx) {
        for (let i = 0; i < points.length; i++) {
            const start = points[i];
            const end = points[(i + 1) % points.length];
            this.drawLineBresenham(start.x, start.y, end.x, end.y, ctx);
        }
    }

    drawThickPolygonOutline(points, ctx) {
        const thickness = this.polygonThickness;
        const radius = thickness / 2;
        const halfThickness = Math.floor(thickness / 2);
        
        // First draw all the line segments
        for (let i = 0; i < points.length; i++) {
            const start = points[i];
            const end = points[(i + 1) % points.length];
            this.drawThickLineBresenham(start.x, start.y, end.x, end.y, thickness, ctx);
        }
        
        // Then draw filled circles at each vertex to ensure smooth connections
        for (let i = 0; i < points.length; i++) {
            const vertex = points[i];
            
            // Draw a filled circle at each vertex
            for (let y = -halfThickness; y <= halfThickness; y++) {
                for (let x = -halfThickness; x <= halfThickness; x++) {
                    if (x * x + y * y <= radius * radius) {
                        this.setPixelInFrame(vertex.x + x, vertex.y + y, ctx);
                    }
                }
            }
        }
    }

    fillPolygon(points, ctx) {
        // Use scanline filling algorithm for polygon fill
        const minY = Math.min(...points.map(p => p.y));
        const maxY = Math.max(...points.map(p => p.y));
        
        for (let y = minY; y <= maxY; y++) {
            const intersections = [];
            
            // Find intersections of scanline with polygon edges
            for (let i = 0; i < points.length; i++) {
                const p1 = points[i];
                const p2 = points[(i + 1) % points.length];
                
                if ((p1.y <= y && p2.y > y) || (p2.y <= y && p1.y > y)) {
                    // Edge crosses the scanline
                    const x = p1.x + (p2.x - p1.x) * (y - p1.y) / (p2.y - p1.y);
                    intersections.push(Math.round(x));
                }
            }
            
            // Sort intersections and fill between pairs
            intersections.sort((a, b) => a - b);
            for (let i = 0; i < intersections.length; i += 2) {
                if (i + 1 < intersections.length) {
                    for (let x = intersections[i]; x <= intersections[i + 1]; x++) {
                        this.setPixelInFrame(x, y, ctx);
                    }
                }
            }
        }
    }

    drawLineBresenham(x0, y0, x1, y1, ctx) {
        const dx = Math.abs(x1 - x0);
        const dy = Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1;
        const sy = y0 < y1 ? 1 : -1;
        let err = dx - dy;
        
        let x = x0;
        let y = y0;
        
        while (true) {
            this.setPixelInFrame(x, y, ctx);
            
            if (x === x1 && y === y1) break;
            
            const e2 = 2 * err;
            if (e2 > -dy) {
                err -= dy;
                x += sx;
            }
            if (e2 < dx) {
                err += dx;
                y += sy;
            }
        }
    }

    drawThickLineBresenham(x0, y0, x1, y1, thickness, ctx) {
        if (thickness === 1) {
            this.drawLineBresenham(x0, y0, x1, y1, ctx);
            return;
        }
        
        // For thick lines, use a capsule-based approach for better coverage
        const dx = x1 - x0;
        const dy = y1 - y0;
        const length = Math.sqrt(dx * dx + dy * dy);
        
        if (length === 0) {
            // Single point - draw a filled circle
            const radius = Math.floor(thickness / 2);
            for (let y = -radius; y <= radius; y++) {
                for (let x = -radius; x <= radius; x++) {
                    if (x * x + y * y <= radius * radius) {
                        this.setPixelInFrame(x0 + x, y0 + y, ctx);
                    }
                }
            }
            return;
        }
        
        // Draw the thick line using a sweep approach
        const radius = thickness / 2;
        const halfThickness = Math.floor(thickness / 2);
        
        // For each pixel along the line, draw a circle centered on that pixel
        const steps = Math.max(Math.abs(dx), Math.abs(dy));
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const centerX = Math.round(x0 + t * dx);
            const centerY = Math.round(y0 + t * dy);
            
            // Draw a filled circle at this point
            for (let y = -halfThickness; y <= halfThickness; y++) {
                for (let x = -halfThickness; x <= halfThickness; x++) {
                    if (x * x + y * y <= radius * radius) {
                        this.setPixelInFrame(centerX + x, centerY + y, ctx);
                    }
                }
            }
        }
    }
    
    // Panning methods
    startPanning(pos) {
        // Store screen coordinates for accurate panning
        // pos can be either a mouse event or position object
        if (pos.clientX !== undefined) {
            // It's a mouse event
            this.panStart = {
                x: pos.clientX,
                y: pos.clientY
            };
        } else {
            // It's a position object or use lastMouseEvent
            this.panStart = {
                x: this.lastMouseEvent ? this.lastMouseEvent.clientX : 0,
                y: this.lastMouseEvent ? this.lastMouseEvent.clientY : 0
            };
        }
        this.isPanning = true;
        
        // Get current transform - handle both translate and translate3d formats
        const canvasWrapper = document.querySelector('.canvas-wrapper');
        const currentTransform = canvasWrapper.style.transform || 'translate3d(0px, 0px, 0px)';
        
        // Try to match translate3d first, then fallback to translate
        let matches = currentTransform.match(/translate3d\(([^,]+),\s*([^,]+),\s*([^)]+)\)/);
        if (!matches) {
            matches = currentTransform.match(/translate\(([^,]+),\s*([^)]+)\)/);
        }
        
        this.panOffsetStart = {
            x: matches ? parseFloat(matches[1]) : 0,
            y: matches ? parseFloat(matches[2]) : 0
        };
        
        // Cache the canvas wrapper element to avoid repeated DOM queries
        this.canvasWrapper = canvasWrapper;
        
        // Use will-change CSS property to optimize for transforms
        this.canvasWrapper.style.willChange = 'transform';
        
        document.body.style.cursor = 'grabbing';
        [this.drawingCanvas, this.overlayCanvas].forEach(canvas => {
            canvas.style.cursor = 'grabbing';
        });
    }
    
    updatePanning(e) {
        if (!this.isPanning || !this.panStart || !this.canvasWrapper) return;
        
        // Use the event if provided, otherwise use stored lastMouseEvent
        const mouseEvent = e || this.lastMouseEvent;
        if (!mouseEvent) return;
        
        // Use screen coordinates for smooth panning - no zoom adjustment needed for screen space
        const deltaX = mouseEvent.clientX - this.panStart.x;
        const deltaY = mouseEvent.clientY - this.panStart.y;
        
        const newX = this.panOffsetStart.x + deltaX;
        const newY = this.panOffsetStart.y + deltaY;
        
        // Use transform3d for hardware acceleration and better performance
        // Use requestAnimationFrame to throttle updates and reduce jank
        if (!this.panningFrame) {
            this.panningFrame = requestAnimationFrame(() => {
                if (this.canvasWrapper) {
                    this.canvasWrapper.style.transform = `translate3d(${newX}px, ${newY}px, 0)`;
                }
                this.panningFrame = null;
            });
        }
    }
    
    endPanning() {
        this.isPanning = false;
        this.panStart = null;
        this.panOffsetStart = null;
        
        // Clean up performance optimizations
        if (this.canvasWrapper) {
            this.canvasWrapper.style.willChange = '';
            this.canvasWrapper = null;
        }
        
        // Clean up any pending animation frame
        if (this.panningFrame) {
            cancelAnimationFrame(this.panningFrame);
            this.panningFrame = null;
        }
        
        document.body.style.cursor = '';
        
        // Reset cursor based on current tool
        const cursor = this.currentTool === 'hand' ? 'grab' : 'crosshair';
        [this.drawingCanvas, this.overlayCanvas].forEach(canvas => {
            canvas.style.cursor = cursor;
        });
    }
    
    executeFloodFill(x, y) {
        const ctx = this.getCurrentFrameContext();
        const targetColor = this.getPixelColor(ctx.getImageData(0, 0, this.canvasWidth, this.canvasHeight).data, x, y);
        const fillColor = this.currentColor === 'black' ? [0, 0, 0, 255] : [255, 255, 255, 255];
        
        if (this.colorsEqual(targetColor, fillColor)) return;
        
        // Capture snapshot before flood fill
        this.captureSnapshot();
        
        // Perform flood fill (mirroring disabled for flood fill tool)
        this.performFloodFill(x, y, ctx);
        
        // Composite layers if needed and redraw
        if (this.layersEnabled) {
            this.compositeLayersToFrame(this.currentFrameIndex);
        }
        this.redrawCanvas();
        
        // Push undo snapshot
        this.pushUndo();
        
        // Generate thumbnail and code
        this.generateThumbnail(this.currentFrameIndex);
        this.generateCode();
        
        // Update layer previews if layers are enabled
        if (this.layersEnabled) {
            this.updateLayersUI();
        }
    }
    
    getFilledPixels(beforeImageData, afterImageData) {
        const filledPixels = [];
        const beforeData = beforeImageData.data;
        const afterData = afterImageData.data;
        
        for (let i = 0; i < beforeData.length; i += 4) {
            const pixelIndex = i / 4;
            const x = pixelIndex % this.canvasWidth;
            const y = Math.floor(pixelIndex / this.canvasWidth);
            
            // Check if pixel changed
            const beforeR = beforeData[i];
            const beforeG = beforeData[i + 1];
            const beforeB = beforeData[i + 2];
            const beforeA = beforeData[i + 3];
            
            const afterR = afterData[i];
            const afterG = afterData[i + 1];
            const afterB = afterData[i + 2];
            const afterA = afterData[i + 3];
            
            if (beforeR !== afterR || beforeG !== afterG || beforeB !== afterB || beforeA !== afterA) {
                filledPixels.push({
                    x: x,
                    y: y,
                    newColor: [afterR, afterG, afterB, afterA]
                });
            }
        }
        
        return filledPixels;
    }
    
    performMirroredFill(originalFilledPixels, ctx) {
        if (!originalFilledPixels || originalFilledPixels.length === 0) return;
        
        const imageData = ctx.getImageData(0, 0, this.canvasWidth, this.canvasHeight);
        const data = imageData.data;
        
        // For each filled pixel, mirror it to all applicable quadrants simultaneously
        originalFilledPixels.forEach(pixel => {
            const mirrorPositions = [];
            
            // Calculate all mirror positions for this pixel
            if (this.mirrorHorizontal && !this.mirrorVertical) {
                // Horizontal mirror only
                const mirrorX = this.getMirrorX(pixel.x);
                if (mirrorX !== null) {
                    mirrorPositions.push({x: mirrorX, y: pixel.y});
                }
            } else if (this.mirrorVertical && !this.mirrorHorizontal) {
                // Vertical mirror only
                const mirrorY = this.getMirrorY(pixel.y);
                if (mirrorY !== null) {
                    mirrorPositions.push({x: pixel.x, y: mirrorY});
                }
            } else if (this.mirrorHorizontal && this.mirrorVertical) {
                // Both mirrors - create all 3 mirror positions simultaneously
                const mirrorX = this.getMirrorX(pixel.x);
                const mirrorY = this.getMirrorY(pixel.y);
                
                // Horizontal mirror
                if (mirrorX !== null) {
                    mirrorPositions.push({x: mirrorX, y: pixel.y});
                }
                
                // Vertical mirror
                if (mirrorY !== null) {
                    mirrorPositions.push({x: pixel.x, y: mirrorY});
                }
                
                // Diagonal mirror (both axes)
                if (mirrorX !== null && mirrorY !== null) {
                    mirrorPositions.push({x: mirrorX, y: mirrorY});
                }
            }
            
            // Apply the fill to each mirror position
            mirrorPositions.forEach(mirrorPos => {
                // Check bounds
                if (mirrorPos.x < 0 || mirrorPos.x >= this.canvasWidth || 
                    mirrorPos.y < 0 || mirrorPos.y >= this.canvasHeight) {
                    return;
                }
                
                // For mirrored fill, we want to copy the exact same pattern result
                // So we use the same color that was applied to the original pixel
                let finalColor = pixel.newColor;
                
                // However, for patterns that depend on position, recalculate at mirror position
                if (this.fillPattern.startsWith('gradient-')) {
                    // For gradients, recalculate the color at the mirror position
                    const hexColor = this.getGradientColor(mirrorPos.x, mirrorPos.y, this.fillPattern, this.currentColor);
                    
                    // For dithered gradients, check if this mirror pixel should be filled
                    if (this.fillPattern.includes('-dither') || this.fillPattern.includes('-stipple')) {
                        if ((this.currentColor === 'black' && hexColor === '#ffffff') ||
                            (this.currentColor === 'white' && hexColor === '#000000')) {
                            return; // Don't fill this mirror pixel
                        }
                    }
                    
                    const { r, g, b, a } = this.hexToRgba(hexColor);
                    finalColor = [r, g, b, a];
                } else if (this.fillPattern !== 'solid') {
                    // For stippling patterns, check if mirror pixel should be filled
                    if (!this.shouldFillPixel(mirrorPos.x, mirrorPos.y, this.fillPattern)) {
                        return; // Don't fill this mirror pixel
                    }
                }
                
                this.setPixelColor(data, mirrorPos.x, mirrorPos.y, finalColor);
            });
        });
        
        ctx.putImageData(imageData, 0, 0);
    }
    
    performFloodFill(x, y, ctx) {
        const imageData = ctx.getImageData(0, 0, this.canvasWidth, this.canvasHeight);
        const data = imageData.data;
        
        const targetColor = this.getPixelColor(data, x, y);
        const fillColor = this.currentColor === 'black' ? [0, 0, 0, 255] : [255, 255, 255, 255];
        
        if (this.colorsEqual(targetColor, fillColor)) return;
        
        const stack = [[x, y]];
        const visited = new Set();
        
        while (stack.length > 0) {
            const [cx, cy] = stack.pop();
            const key = `${cx},${cy}`;
            
            if (visited.has(key)) continue;
            if (cx < 0 || cx >= this.canvasWidth || cy < 0 || cy >= this.canvasHeight) continue;
            
            const currentColor = this.getPixelColor(data, cx, cy);
            if (!this.colorsEqual(currentColor, targetColor)) continue;
            
            visited.add(key);
            
            // Check if this pixel should be filled based on pattern
            let finalColor = fillColor;
            if (this.fillPattern.startsWith('gradient-')) {
                // For gradients, calculate the color based on position
                const hexColor = this.getGradientColor(cx, cy, this.fillPattern, this.currentColor);
                
                // For dithered gradients, if the returned color is white and we're filling with black,
                // or if the returned color is black and we're filling with white, skip this pixel
                if (this.fillPattern.includes('-dither') || this.fillPattern.includes('-stipple')) {
                    if ((this.currentColor === 'black' && hexColor === '#ffffff') ||
                        (this.currentColor === 'white' && hexColor === '#000000')) {
                        // Don't fill this pixel, continue to next
                        stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
                        continue;
                    }
                }
                
                const { r, g, b, a } = this.hexToRgba(hexColor);
                finalColor = [r, g, b, a];
            } else if (this.fillPattern !== 'solid') {
                // For stippling patterns, check if pixel should be filled
                if (!this.shouldFillPixel(cx, cy, this.fillPattern)) {
                    // Don't fill this pixel, continue to next
                    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
                    continue;
                }
            }
            
            this.setPixelColor(data, cx, cy, finalColor);
            
            stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
        }
        
        ctx.putImageData(imageData, 0, 0);
    }
    
    floodFill(x, y) {
        const ctx = this.getCurrentFrameContext();
        const imageData = ctx.getImageData(0, 0, this.canvasWidth, this.canvasHeight);
        const data = imageData.data;
        
        const targetColor = this.getPixelColor(data, x, y);
        const fillColor = this.currentColor === 'black' ? [0, 0, 0, 255] : [255, 255, 255, 255];
        
        if (this.colorsEqual(targetColor, fillColor)) return;
        
        const stack = [[x, y]];
        const visited = new Set();
        
        while (stack.length > 0) {
            const [cx, cy] = stack.pop();
            const key = `${cx},${cy}`;
            
            if (visited.has(key)) continue;
            if (cx < 0 || cx >= this.canvasWidth || cy < 0 || cy >= this.canvasHeight) continue;
            
            const currentColor = this.getPixelColor(data, cx, cy);
            if (!this.colorsEqual(currentColor, targetColor)) continue;
            
            visited.add(key);
            this.setPixelColor(data, cx, cy, fillColor);
            
            stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
        }
        
        ctx.putImageData(imageData, 0, 0);
        this.redrawCanvas();
        this.generateThumbnail(this.currentFrameIndex);
        this.generateCode();
    }
    
    getPixelColor(data, x, y) {
        const index = (y * this.canvasWidth + x) * 4;
        return [data[index], data[index + 1], data[index + 2], data[index + 3]];
    }
    
    setPixelColor(data, x, y, color) {
        const index = (y * this.canvasWidth + x) * 4;
        data[index] = color[0];
        data[index + 1] = color[1];
        data[index + 2] = color[2];
        data[index + 3] = color[3];
    }
    
    colorsEqual(color1, color2) {
        return color1[0] === color2[0] && color1[1] === color2[1] && 
               color1[2] === color2[2] && color1[3] === color2[3];
    }
    
    getCurrentFrameContext() {
        // Use active layer if layers are enabled, otherwise use frame canvas
        if (this.layersEnabled) {
            return this.getActiveContext();
        }
        return this.frames[this.currentFrameIndex].getContext('2d', { willReadFrequently: true });
    }
    
    // Text tool methods
    startTextPlacement(pos) {
        this.isPlacingText = true;
        this.textPlacementPos = pos;
        // Capture snapshot before placing text
        this.captureSnapshot();
        this.generateTextCanvas();
        this.clearOverlayAndRedrawBase();
        this.showTextPreview(pos);
    }
    
    updateTextPreviewPosition(pos) {
        if (this.isPlacingText) {
            this.textPlacementPos = pos;
            this.clearOverlayAndRedrawBase();
            this.showTextPreview(pos);
        }
    }
    
    showTextPreview(pos) {
        if (!this.textPreviewData || !this.textInput.trim()) return;
        
        // Create temporary canvas for binarization
        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
        
        // Set temp canvas size
        tempCanvas.width = this.textPreviewData.width + 10; // Add padding
        tempCanvas.height = this.textPreviewData.height + 10;
        
        // Configure temp context for text rendering
        tempCtx.save();
        
        // Set text style
        let fontStyle = '';
        if (this.textBold) fontStyle += 'bold ';
        if (this.textItalic) fontStyle += 'italic ';
        
        tempCtx.font = `${fontStyle}${this.fontSize}px ${this.fontFamily}`;
        tempCtx.fillStyle = 'black';
        tempCtx.textBaseline = 'top';
        tempCtx.imageSmoothingEnabled = false;
        
        // Draw text to temp canvas with pixel-perfect line spacing and letter spacing
        const lines = this.textPreviewData.lines;
        const lineHeight = Math.round(this.fontSize * 1.0); // Use 1.0 for pixel-perfect spacing
        
        lines.forEach((line, index) => {
            const y = 5 + Math.round(index * lineHeight); // Round to pixel boundaries
            this.renderTextWithSpacing(tempCtx, line, 5, y, 1); // 1px minimum letter spacing
        });
        
        tempCtx.restore();
        
        // Get image data and binarize
        const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
        const data = imageData.data;
        
        // Binarize with lower threshold for better text detection
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const alpha = data[i + 3];
            
            // Calculate grayscale and apply threshold
            const gray = (r + g + b) / 3;
            const threshold = 200; // Higher threshold to capture more anti-aliased pixels
            
            if (alpha > 10 && gray < threshold) {
                // Make it black
                data[i] = 0;     // R
                data[i + 1] = 0; // G
                data[i + 2] = 0; // B
                data[i + 3] = 255; // A
            } else {
                // Make it transparent
                data[i] = 0;     // R
                data[i + 1] = 0; // G
                data[i + 2] = 0; // B
                data[i + 3] = 0; // A
            }
        }
        
        // Put binarized data back
        tempCtx.putImageData(imageData, 0, 0);
        
        // Draw to overlay with red tint for preview
        this.overlayCtx.save();
        this.overlayCtx.imageSmoothingEnabled = false;
        this.overlayCtx.globalCompositeOperation = 'source-over';
        
        // Draw binarized text
        this.overlayCtx.drawImage(tempCanvas, pos.x - 5, pos.y - 5);
        
        // Apply red tint for preview
        this.overlayCtx.globalCompositeOperation = 'source-atop';
        this.overlayCtx.fillStyle = 'rgba(255, 0, 0, 0.8)';
        this.overlayCtx.fillRect(pos.x - 5, pos.y - 5, tempCanvas.width, tempCanvas.height);
        
        // Draw mirrored text previews if mirroring is enabled
        if (this.mirrorHorizontal || this.mirrorVertical) {
            // Calculate the center of the original text position (accounting for the 5px padding)
            const originalTopLeftX = pos.x - 5;
            const originalTopLeftY = pos.y - 5;
            const textCenterX = originalTopLeftX + (tempCanvas.width / 2);
            const textCenterY = originalTopLeftY + (tempCanvas.height / 2);
            
            const mirrorPositions = this.calculateMirrorPositions(textCenterX, textCenterY);
            
            mirrorPositions.forEach(mirrorPos => {
                // Calculate the top-left position for the mirrored text
                const mirrorTopLeftX = mirrorPos.x - (tempCanvas.width / 2);
                const mirrorTopLeftY = mirrorPos.y - (tempCanvas.height / 2);
                
                // Draw the text normally at the mirror position (no content flipping)
                this.overlayCtx.globalCompositeOperation = 'source-over';
                this.overlayCtx.drawImage(tempCanvas, mirrorTopLeftX, mirrorTopLeftY);
                
                // Apply red tint for mirror preview
                this.overlayCtx.globalCompositeOperation = 'source-atop';
                this.overlayCtx.fillStyle = 'rgba(255, 0, 0, 0.8)';
                this.overlayCtx.fillRect(mirrorTopLeftX, mirrorTopLeftY, tempCanvas.width, tempCanvas.height);
                this.overlayCtx.globalCompositeOperation = 'source-over';
            });
        }
        
        this.overlayCtx.restore();
    }
    
    finalizeText(pos) {
        if (!this.textInput.trim()) {
            this.isPlacingText = false;
            this.clearOverlayAndRedrawBase();
            return;
        }
        
        const ctx = this.getCurrentFrameContext();
        
        // Capture canvas state before drawing text
        const beforeImageData = ctx.getImageData(0, 0, this.canvasWidth, this.canvasHeight);
        
        // Create temporary canvas for binarization
        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
        
        // Set temp canvas size
        tempCanvas.width = this.textPreviewData.width + 10; // Add padding
        tempCanvas.height = this.textPreviewData.height + 10;
        
        // Configure temp context for text rendering
        tempCtx.save();
        
        // Set text style
        let fontStyle = '';
        if (this.textBold) fontStyle += 'bold ';
        if (this.textItalic) fontStyle += 'italic ';
        
        tempCtx.font = `${fontStyle}${this.fontSize}px ${this.fontFamily}`;
        tempCtx.fillStyle = 'black';
        tempCtx.textBaseline = 'top';
        tempCtx.imageSmoothingEnabled = false;
        
        // Draw text to temp canvas with pixel-perfect line spacing and letter spacing
        const lines = this.textPreviewData.lines;
        const lineHeight = Math.round(this.fontSize * 1.0); // Use 1.0 for pixel-perfect spacing
        
        lines.forEach((line, index) => {
            const y = 5 + Math.round(index * lineHeight); // Round to pixel boundaries
            this.renderTextWithSpacing(tempCtx, line, 5, y, 1); // 1px minimum letter spacing
        });
        
        tempCtx.restore();
        
        // Get image data and binarize
        const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
        const data = imageData.data;
        
        // Binarize with lower threshold for better text detection
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const alpha = data[i + 3];
            
            // Calculate grayscale and apply threshold
            const gray = (r + g + b) / 3;
            const threshold = 200; // Higher threshold to capture more anti-aliased pixels
            
            if (alpha > 10 && gray < threshold) {
                // Make it the selected text color
                if (this.textColor === 'white') {
                    data[i] = 255;     // R
                    data[i + 1] = 255; // G
                    data[i + 2] = 255; // B
                } else {
                    data[i] = 0;     // R
                    data[i + 1] = 0; // G
                    data[i + 2] = 0; // B
                }
                data[i + 3] = 255; // A
            } else {
                // Make it transparent
                data[i] = 0;     // R
                data[i + 1] = 0; // G
                data[i + 2] = 0; // B
                data[i + 3] = 0; // A
            }
        }
        
        // Put binarized data back
        tempCtx.putImageData(imageData, 0, 0);
        
        // Draw binarized text to main canvas
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tempCanvas, pos.x - 5, pos.y - 5);
        ctx.restore();
        
        // Draw mirrored text if mirroring is enabled
        if (this.mirrorHorizontal || this.mirrorVertical) {
            // Calculate the center of the original text position (accounting for the 5px padding)
            const originalTopLeftX = pos.x - 5;
            const originalTopLeftY = pos.y - 5;
            const textCenterX = originalTopLeftX + (tempCanvas.width / 2);
            const textCenterY = originalTopLeftY + (tempCanvas.height / 2);
            
            const mirrorPositions = this.calculateMirrorPositions(textCenterX, textCenterY);
            
            mirrorPositions.forEach(mirrorPos => {
                // Calculate the top-left position for the mirrored text
                const mirrorTopLeftX = mirrorPos.x - (tempCanvas.width / 2);
                const mirrorTopLeftY = mirrorPos.y - (tempCanvas.height / 2);
                
                // Draw the text normally at the mirror position (no content flipping)
                ctx.save();
                ctx.imageSmoothingEnabled = false;
                ctx.drawImage(tempCanvas, mirrorTopLeftX, mirrorTopLeftY);
                ctx.restore();
            });
        }
        
        // Push undo snapshot after text is placed
        this.pushUndo();
        
        this.isPlacingText = false;
        this.clearOverlayAndRedrawBase();
        this.redrawCanvas();
    }
    
    setTool(tool) {
        // Don't treat clear as a tool - it's just an action
        if (tool === 'clear') {
            this.clear();
            return; // Don't change the current tool
        }
        
        // Stop continuous spray when switching tools
        this.stopContinuousSpray();
        
        // Clear any previews when switching tools
        this.clearOverlayAndRedrawBase();
        
        // Clear text placement state when switching away from text tool
        if (this.currentTool === 'text' && tool !== 'text' && this.isPlacingText) {
            this.isPlacingText = false;
            this.clearOverlayAndRedrawBase();
        }
        
        // Disable paste mode when switching away from select tool
        if (this.currentTool === 'select' && tool !== 'select' && this.isPasteModeActive) {
            this.isPasteModeActive = false;
            const pasteModeBtn = document.getElementById('pasteModeBtn');
            const pasteModeOptions = document.getElementById('pasteModeOptions');
            pasteModeBtn.classList.remove('active');
            pasteModeBtn.textContent = 'Paste Mode';
            pasteModeOptions.style.display = 'none';
        }
        
        // Disable grid mode when switching away from pen tool (but preserve checkbox state)
        if (this.currentTool === 'pen' && tool !== 'pen' && this.gridModeEnabled) {
            this.gridModeEnabled = false;
            // Don't uncheck the checkbox - preserve user's grid preference
            // Clear any persistent grid display
            this.overlayCtx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
            this.drawBaseOverlays();
            console.log('Grid mode disabled - switched from pen to', tool);
        }
        
        // Re-enable grid mode when switching back to pen tool if it was previously enabled
        if (this.currentTool !== 'pen' && tool === 'pen') {
            const gridModeSettings = document.getElementById('gridModeSettings');
            
            // Grid mode state is preserved in this.gridModeEnabled
            if (this.gridModeEnabled) {
                // Show grid mode settings
                if (gridModeSettings) {
                    gridModeSettings.style.display = 'block';
                }
                // Update grid display and controls
                this.updateGridDisplay();
                this.updateBrushControlsState();
                this.updatePenModeButton();
                // Redraw grid if enabled
                this.updateGridDisplay();
                console.log('Grid mode re-enabled - switched back to pen tool');
            }
        }
        
        this.currentTool = tool;
        document.querySelectorAll('.tool-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tool === tool);
        });
        
        // Handle overlay coordination when switching tools
        if (tool === 'select') {
            // When switching to select tool, draw selection overlay if there's an active selection
            this.drawSelectionOverlay();
            this.updateSelectionModeButton();
        } else {
            // When switching away from select tool, restore the overlay state without selection
            this.restoreOverlayState();
        }
        
        // Show live preview if switching to bucket tool
        if (tool === 'bucket') {
            setTimeout(() => this.updateGradientLivePreview(), 50);
        }
        
        // Show/hide relevant sections based on tool
        const brushSettings = document.getElementById('brushSettings');
        const editSettings = document.getElementById('editSettings');
        const selectionModeSection = document.getElementById('selectionModeSection');
        const bucketSettings = document.getElementById('bucketSettings');
        const shapeSettings = document.getElementById('shapeSettings');
        const polygonSettings = document.getElementById('polygonSettings');
        const textSettings = document.getElementById('textSettings');
        const shapeThickness = document.getElementById('shapeThickness');
        const polygonThickness = document.getElementById('polygonThickness');
        const gridModeSettings = document.getElementById('gridModeSettings');
        
        brushSettings.style.display = tool === 'pen' ? 'block' : 'none';
        editSettings.style.display = tool === 'select' ? 'block' : 'none';
        selectionModeSection.style.display = tool === 'select' ? 'block' : 'none';
        bucketSettings.style.display = tool === 'bucket' ? 'block' : 'none';
        shapeSettings.style.display = (tool === 'circle' || tool === 'square') ? 'block' : 'none';
        polygonSettings.style.display = tool === 'polygon' ? 'block' : 'none';
        textSettings.style.display = tool === 'text' ? 'block' : 'none';
        
        // Initialize text button states when text tool is selected
        if (tool === 'text') {
            this.initializeTextButtonStates();
        }
        
        // Initialize polygon settings when polygon tool is selected
        if (tool === 'polygon') {
            this.setPolygonFillMode(this.polygonFillMode);
        }
        
        // Show grid mode settings only for pen tool
        if (gridModeSettings) {
            gridModeSettings.style.display = tool === 'pen' ? 'block' : 'none';
        }
        
        // Show thickness controls for both rectangle and circle tools when outline mode
        if (shapeThickness) {
            shapeThickness.style.display = (tool === 'square' || tool === 'circle') && this.shapeFillMode === 'outline' ? 'block' : 'none';
        }
        
        // Show polygon thickness controls when polygon tool is active and outline mode
        if (polygonThickness) {
            polygonThickness.style.display = tool === 'polygon' && this.polygonFillMode === 'outline' ? 'block' : 'none';
        }
        
        // Update cursor based on tool
        let cursor = 'crosshair';
        if (tool === 'hand') {
            cursor = this.isPanning ? 'grabbing' : 'grab';
        } else if (tool === 'select') {
            cursor = 'crosshair';
        } else if (tool === 'rotate') {
            cursor = 'pointer';
        }
        
        this.drawingCanvas.style.cursor = cursor;
        this.overlayCanvas.style.cursor = cursor;
    }
    
    restoreOverlayState() {
        // Clear overlay and restore all overlay elements in proper order
        this.overlayCtx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
        
        // 1. Base overlays (pixel grid, grid lines)
        this.drawBaseOverlays();
        
        // 2. Selection overlay (if active and using select tool) - but NOT in paste mode
        if (this.selection && this.selection.active && this.currentTool === 'select' && !this.isPasteModeActive) {
            this.drawSelectionInOverlay();
        }
    }
    
    drawSelectionInOverlay() {
        this.overlayCtx.save();
        
        // Disable anti-aliasing for crisp, pixel-perfect rendering
        this.overlayCtx.imageSmoothingEnabled = false;
        this.overlayCtx.webkitImageSmoothingEnabled = false;
        this.overlayCtx.mozImageSmoothingEnabled = false;
        this.overlayCtx.msImageSmoothingEnabled = false;
        
        if (this.selection.mode === 'lasso') {
            const lassoPoints = this.selection.lassoPoints;
            if (lassoPoints && lassoPoints.length > 2) {
                // Round all coordinates to nearest pixel for pixel-perfect selection
                const roundedPoints = lassoPoints.map(point => ({
                    x: Math.round(point.x),
                    y: Math.round(point.y)
                }));
                
                // Draw lasso path with pixel-perfect coordinates
                this.overlayCtx.strokeStyle = 'rgba(255, 100, 100, 0.8)';
                this.overlayCtx.lineWidth = 1;
                this.overlayCtx.beginPath();
                this.overlayCtx.moveTo(roundedPoints[0].x + 0.5, roundedPoints[0].y + 0.5);
                
                for (let i = 1; i < roundedPoints.length; i++) {
                    this.overlayCtx.lineTo(roundedPoints[i].x + 0.5, roundedPoints[i].y + 0.5);
                }
                
                // Close the path
                this.overlayCtx.closePath();
                this.overlayCtx.stroke();
                
                // Fill the lasso area
                this.overlayCtx.fillStyle = 'rgba(255, 100, 100, 0.3)';
                this.overlayCtx.fill();
            }
        } else {
            // Rectangle selection
            const { startX, startY, endX, endY } = this.selection;
            const minX = Math.min(startX, endX);
            const minY = Math.min(startY, endY);
            const width = Math.abs(endX - startX);
            const height = Math.abs(endY - startY);
            
            // Only draw if selection has meaningful size
            if (width > 0 && height > 0) {
                if (this.selection.cutContent) {
                    // Draw cut content
                    this.overlayCtx.drawImage(this.selection.cutContent, minX, minY);
                } else {
                    // Draw selection overlay - simplified version for restore
                    this.overlayCtx.fillStyle = 'rgba(255, 100, 100, 0.3)';
                    this.overlayCtx.fillRect(minX, minY, width, height);
                }
            }
        }
        
        this.overlayCtx.restore();
    }
    
    redrawCurrentPreview() {
        // Redraw the current preview based on the active tool
        // This is called after zoom changes to restore previews
        
        if (!this.lastMouseEvent) return;
        
        // Don't redraw previews when in paste mode - paste mode handles its own preview
        if (this.currentTool === 'select' && this.isPasteModeActive) {
            // In paste mode, show the paste preview instead
            const pos = this.getMousePos(this.lastMouseEvent);
            if (this.isWithinCanvas(pos.x, pos.y)) {
                this.showPastePreview(pos.x, pos.y);
            }
            return;
        }
        
        // Get current mouse position
        const pos = this.getMousePos(this.lastMouseEvent);
        
        switch (this.currentTool) {
            case 'pen':
                if (this.isWithinCanvas(pos.x, pos.y)) {
                    if (!this.gridModeEnabled && this.penMode !== 'spray') {
                        this.showPenPreview(pos.x, pos.y);
                    } else if (this.penMode === 'spray') {
                        this.showSprayPreview(pos.x, pos.y);
                    }
                }
                break;
                
            case 'bucket':
                if (this.isWithinCanvas(pos.x, pos.y)) {
                    // Don't interfere if we're editing gradient settings
                    if (!this.isEditingGradientSettings) {
                        this.showFillPreview(pos.x, pos.y);
                    }
                }
                break;
                
            case 'text':
                if (this.textInput.trim() && this.isWithinCanvas(pos.x, pos.y)) {
                    this.generateTextCanvas();
                    this.clearOverlayAndRedrawBase();
                    this.showTextPreview(pos);
                }
                break;
                
            case 'circle':
            case 'square':
            case 'polygon':
                // Shape tools need to redraw their preview if they're being drawn
                if (this.isDrawing && this.startPos && this.isWithinCanvas(pos.x, pos.y)) {
                    this.updateShapePreview(pos);
                }
                break;
                
            case 'select':
                // Selection previews are handled by restoreOverlayState
                // Paste mode is already handled above
                break;
        }
    }
    
    setShapeFillMode(fillMode) {
        this.shapeFillMode = fillMode;
        document.querySelectorAll('.fill-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.fill === fillMode);
        });
        
        // Show/hide thickness controls based on fill mode
        const shapeThickness = document.getElementById('shapeThickness');
        if (shapeThickness) {
            const showThickness = (this.currentTool === 'square' || this.currentTool === 'circle') && fillMode === 'outline';
            shapeThickness.style.display = showThickness ? 'block' : 'none';
        }
    }
    
    updateFillMode() {
        // This is called from keyboard shortcuts to update fill mode from a select element
        const fillModeSelect = document.getElementById('fillMode');
        if (fillModeSelect && (this.currentTool === 'circle' || this.currentTool === 'square')) {
            this.setShapeFillMode(fillModeSelect.value);
        }
    }
    
    setShapeStrokePosition(strokePosition) {
        this.shapeStrokePosition = strokePosition;
        document.querySelectorAll('.style-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.style === strokePosition);
        });
    }

    cycleShapeMode() {
        const modes = ['corner', 'center', 'perfect-corner', 'perfect-center'];
        const currentIndex = modes.indexOf(this.shapeMode);
        const nextIndex = (currentIndex + 1) % modes.length;
        this.shapeMode = modes[nextIndex];
        
        // Update UI
        this.updateShapeModeDisplay();
    }
    
    updateShapeModeDisplay() {
        const iconElement = document.getElementById('shapeModeIcon');
        const textElement = document.getElementById('shapeModeText');
        
        const modeConfig = {
            'corner': { icon: '📐', text: 'Corner' },
            'center': { icon: '🎯', text: 'Center' },
            'perfect-corner': { icon: '⭕', text: 'Perfect Corner' },
            'perfect-center': { icon: '🔥', text: 'Perfect Center' }
        };
        
        const config = modeConfig[this.shapeMode];
        if (iconElement) iconElement.textContent = config.icon;
        if (textElement) textElement.textContent = config.text;
    }

    // Polygon-specific methods
    setPolygonFillMode(fillMode) {
        this.polygonFillMode = fillMode;
        document.querySelectorAll('#polygonSettings .fill-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.fill === fillMode);
        });
        
        // Show/hide thickness controls based on fill mode
        const thicknessSection = document.getElementById('polygonThickness');
        if (thicknessSection) {
            thicknessSection.style.display = fillMode === 'outline' ? 'block' : 'none';
        }
    }

    updatePenModeButton() {
        const penModeBtn = document.getElementById('penModeBtn');
        const penModeIcon = document.getElementById('penModeIcon');
        const penModeText = document.getElementById('penModeText');
        
        if (penModeBtn && penModeIcon && penModeText) {
            if (this.penMode === 'grid') {
                penModeIcon.textContent = '📐';
                penModeText.textContent = 'Grid';
                penModeBtn.setAttribute('data-mode', 'grid');
            } else if (this.penMode === 'line') {
                penModeIcon.textContent = '↔️';
                penModeText.textContent = 'Line';
                penModeBtn.setAttribute('data-mode', 'line');
            } else if (this.penMode === 'spray') {
                penModeIcon.textContent = '💨';
                penModeText.textContent = 'Spray';
                penModeBtn.setAttribute('data-mode', 'spray');
            } else {
                penModeIcon.textContent = '✏️';
                penModeText.textContent = 'Freehand';
                penModeBtn.setAttribute('data-mode', 'freehand');
            }
        }
    }
    
    updateSelectionModeButton() {
        const selectionModeBtn = document.getElementById('selectionModeBtn');
        const selectionModeIcon = document.getElementById('selectionModeIcon');
        const selectionModeText = document.getElementById('selectionModeText');
        
        if (selectionModeBtn && selectionModeIcon && selectionModeText) {
            if (this.selectionMode === 'lasso') {
                selectionModeIcon.textContent = '🪢';
                selectionModeText.textContent = 'Lasso';
                selectionModeBtn.setAttribute('data-mode', 'lasso');
            } else {
                selectionModeIcon.textContent = '▭';
                selectionModeText.textContent = 'Rectangle';
                selectionModeBtn.setAttribute('data-mode', 'rectangle');
            }
        }
    }
    
    toggleTransparencyMode() {
        const modes = ['white', 'black', 'none'];
        const currentIndex = modes.indexOf(this.pasteTransparencyMode);
        const nextIndex = (currentIndex + 1) % modes.length;
        this.pasteTransparencyMode = modes[nextIndex];
        this.updateTransparencyButton();
    }
    
    updateTransparencyButton() {
        const toggleBtn = document.getElementById('transparencyToggle');
        if (!toggleBtn) return;
        
        switch (this.pasteTransparencyMode) {
            case 'white':
                toggleBtn.textContent = '🔍 Transparent White';
                break;
            case 'black':
                toggleBtn.textContent = '⚫ Transparent Black';
                break;
            case 'none':
                toggleBtn.textContent = '🎨 No Transparency';
                break;
        }
    }
    
    updateRotationWarning(angle) {
        const warningElement = document.getElementById('rotationWarning');
        if (!warningElement) return;
        
        const normalizedAngle = ((angle % 360) + 360) % 360;
        const isNon90Degree = normalizedAngle % 90 !== 0;
        
        if (isNon90Degree && angle !== 0) {
            warningElement.style.display = 'block';
        } else {
            warningElement.style.display = 'none';
        }
    }

    setColor(color) {
        this.currentColor = color;
        document.querySelectorAll('.color-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.color === color);
        });
    }
    
    setFillPattern(pattern) {
        this.fillPattern = pattern;
        // Update pattern button states
        document.querySelectorAll('.pattern-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.pattern === pattern);
        });
        
        // Handle gradient selection
        if (pattern === 'gradient-linear' || pattern === 'gradient-radial') {
            this.gradientType = pattern.replace('gradient-', '');
            this.showGradientVariants();
            
            // Automatically apply the current variant to create the complete pattern
            if (this.gradientVariant) {
                this.fillPattern = `gradient-${this.gradientType}-${this.gradientVariant}`;
            } else {
                // If no variant is set, default to stipple
                this.setGradientVariant('stipple');
                return; // setGradientVariant will handle the preview update
            }
            
            // Update preview for the complete gradient pattern
            if (this.currentTool === 'bucket') {
                this.isEditingGradientSettings = true;
                this.ensureGradientEditingPreview();
                setTimeout(() => this.updateGradientLivePreview(), 50);
            }
        } else {
            this.hideGradientControls();
            
            // For non-gradient patterns, also trigger editing state if bucket tool is active
            if (this.currentTool === 'bucket' && pattern !== 'solid') {
                this.isEditingGradientSettings = true; // Reuse the same flag for consistency
                this.ensureGradientEditingPreview();
                // Use the same updateGradientLivePreview function since it now handles all patterns
                setTimeout(() => this.updateGradientLivePreview(), 50);
            }
        }
        
        // Show/hide line pattern controls for lines pattern
        const lineControls = document.getElementById('linePatternControls');
        if (lineControls) {
            lineControls.style.display = pattern === 'lines' ? 'block' : 'none';
        }
        
        // Show/hide percentage pattern controls for percentage pattern
        const percentageControls = document.getElementById('percentagePatternControls');
        if (percentageControls) {
            percentageControls.style.display = pattern === 'percentage' ? 'block' : 'none';
            
            // Update the button text when pattern is selected
            if (pattern === 'percentage') {
                const percentageBtn = document.getElementById('percentageFill');
                if (percentageBtn) {
                    percentageBtn.innerHTML = `▦ ${this.currentPercentage}%`;
                    percentageBtn.setAttribute('title', `${this.currentPercentage}% Fill`);
                }
            }
        }
        
        // Show/hide checkerboard pattern controls
        const checkerboardControls = document.getElementById('checkerboardPatternControls');
        if (checkerboardControls) {
            checkerboardControls.style.display = pattern === 'checkerboard' ? 'block' : 'none';
        }
        
        // Show/hide clipboard pattern controls  
        const clipboardControls = document.getElementById('clipboardPatternControls');
        if (clipboardControls) {
            clipboardControls.style.display = pattern === 'clipboard' ? 'block' : 'none';
        }
        
        // Show/hide dots pattern controls
        const dotsControls = document.getElementById('dotsPatternControls');
        if (dotsControls) {
            dotsControls.style.display = pattern === 'dots' ? 'block' : 'none';
        }
        
        // Update live preview if bucket tool is active
        if (this.currentTool === 'bucket') {
            // Small delay to ensure the UI has updated
            setTimeout(() => this.updateGradientLivePreview(), 50);
        }
    }

    showGradientVariants() {
        const variantControls = document.getElementById('gradientVariantControls');
        if (variantControls) {
            variantControls.style.display = 'block';
            // Set default to stipple if none selected
            if (!this.gradientVariant || this.gradientVariant === 'smooth') {
                this.setGradientVariant('stipple');
            } else {
                this.updateVariantButtons();
            }
        }
    }

    hideGradientControls() {
        const variantControls = document.getElementById('gradientVariantControls');
        const gradientControls = document.getElementById('gradientControls');
        if (variantControls) variantControls.style.display = 'none';
        if (gradientControls) gradientControls.style.display = 'none';
        this.gradientType = null;
        this.gradientVariant = null;
    }

    setGradientVariant(variant) {
        this.gradientVariant = variant;
        this.updateVariantButtons();
        this.showGradientControls();
        
        // Update the actual fillPattern to match the selection
        this.fillPattern = `gradient-${this.gradientType}-${variant}`;
        
        // Update live preview
        if (this.currentTool === 'bucket') {
            this.isEditingGradientSettings = true;
            this.ensureGradientEditingPreview();
            setTimeout(() => this.updateGradientLivePreview(), 50);
        }
    }

    updateVariantButtons() {
        document.querySelectorAll('.variant-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.variant === this.gradientVariant);
        });
    }

    showGradientControls() {
        const gradientControls = document.getElementById('gradientControls');
        const linearControls = document.getElementById('linearControls');
        const radialControls = document.getElementById('radialControls');
        const stippleDitherControls = document.getElementById('stippleDitherControls');
        
        if (gradientControls && linearControls && radialControls && stippleDitherControls) {
            gradientControls.style.display = 'block';
            
            const isLinear = this.gradientType === 'linear';
            const isRadial = this.gradientType === 'radial';
            const isStippleDither = this.gradientVariant === 'stipple' || this.gradientVariant === 'dither';
            
            linearControls.style.display = isLinear ? 'block' : 'none';
            radialControls.style.display = isRadial ? 'block' : 'none';
            stippleDitherControls.style.display = isStippleDither ? 'block' : 'none';
        }
    }

    toggleFillPatternsSettings() {
        const fillPatternsDiv = document.getElementById('fillPatternsSettings');
        const isExpanded = fillPatternsDiv.style.display !== 'none';
        fillPatternsDiv.style.display = isExpanded ? 'none' : 'block';
    }

    setBrushShape(shape) {
        this.brushShape = shape;
        document.querySelectorAll('.brush-shape-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.shape === shape);
        });
    }

    setSelectionMode(mode) {
        // Exit paste mode when changing selection mode
        if (this.isPasteModeActive) {
            this.isPasteModeActive = false;
            this.selection = null;
            this.drawSelectionOverlay();
        }
        
        this.selectionMode = mode;
        document.querySelectorAll('.mode-btn[data-mode]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });
    }
    
    setRectangleStyle(style) {
        this.rectangleStyle = style;
        document.querySelectorAll('.style-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.style === style);
        });
    }
    
    setZoom(newZoom) {
        // Max zoom of 10,000% = 100x, min zoom of 0.5x = 50%
        this.zoom = Math.max(0.5, Math.min(newZoom, 100));
        this.setCanvasSize(this.canvasWidth, this.canvasHeight);
        document.getElementById('zoomLevel').textContent = Math.round(this.zoom * 100) + '%';
        
        // Update mobile zoom display
        this.updateMobileZoomDisplay();
        
        // Update grid display when zoom changes
        if (this.gridModeEnabled) {
            this.updateGridDisplay();
            this.updateBrushControlsState(); // Update brush display to reflect grid visibility
        }
    }
    
    zoomToActualSize() {
        // Zoom to physical screen size (1.5" diagonal KYWY display)
        // This matches the actual physical dimensions of the KYWY screen
        this.setZoom(this.physicalSizeZoom);
        this.centerCanvas();
    }
    
    fitToScreen() {
        const container = document.querySelector('.canvas-container');
        const maxWidth = container.clientWidth - 40;
        const maxHeight = container.clientHeight - 40;
        
        const scaleX = maxWidth / this.canvasWidth;
        const scaleY = maxHeight / this.canvasHeight;
        const scale = Math.min(scaleX, scaleY);
        
        this.setZoom(scale);
        
        // Center the canvas after fitting using the same method as the center button
        this.centerCanvas();
    }
    
    fitToWindow() {
        this.fitToScreen();
    }
    
    centerView() {
        const container = document.querySelector('.canvas-container');
        if (container) {
            container.scrollLeft = (container.scrollWidth - container.clientWidth) / 2;
            container.scrollTop = (container.scrollHeight - container.clientHeight) / 2;
        }
    }
    
    toggleGrid() {
        this.showGrid = !this.showGrid;
        
        // Redraw canvas and restore overlay with grid
        this.redrawCanvas();
        this.restoreOverlayState();
        
        // Update grid button if it exists
        const gridBtn = document.getElementById('mobileGridBtn');
        if (gridBtn) {
            gridBtn.style.background = this.showGrid ? 'var(--primary-color)' : 'var(--button-bg)';
            gridBtn.style.color = this.showGrid ? 'white' : 'var(--text-color)';
        }
    }
    
    setBrushSize(size) {
        this.brushSize = Math.max(1, Math.min(size, 50));
        
        // Update brush controls display (handles both normal and grid mode)
        this.updateBrushControlsState();
    }
    
    togglePixelGrid() {
        this.showPixelGrid = !this.showPixelGrid;
        // Update the desktop checkbox to match
        const pixelGridCheckbox = document.getElementById('pixelGrid');
        if (pixelGridCheckbox) {
            pixelGridCheckbox.checked = this.showPixelGrid;
        }
        this.drawPixelGrid();
    }
    
    drawPixelGrid() {
        // This function handles pixel grid overlay
        if (!this.showPixelGrid || this.zoom < 2) {
            // Clear overlay if pixel grid is disabled or zoom too low
            this.overlayCtx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
            this.drawBaseOverlays(); // Redraw any other overlays (like grid mode lines)
            return;
        }
        
        // Clear overlay and redraw all base overlays (including pixel grid)
        this.overlayCtx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
        this.drawBaseOverlays();
    }

    drawGridLines() {
        // Draw grid lines based on the current grid size
        // Only called when grid mode is enabled and grid size * zoom >= 3
        
        this.overlayCtx.save();
        this.overlayCtx.strokeStyle = 'rgba(0, 120, 255, 0.6)'; // Blue grid lines
        this.overlayCtx.lineWidth = 1;
        this.overlayCtx.globalCompositeOperation = 'source-over';
        
        // Use the actual grid size setting
        const gridSpacing = this.gridSize;
        
        // Ensure pixel-perfect lines
        this.overlayCtx.translate(0.5, 0.5);
        
        // Draw vertical lines at grid intervals
        for (let x = 0; x < this.canvasWidth; x += gridSpacing) {
            this.overlayCtx.beginPath();
            this.overlayCtx.moveTo(x, 0);
            this.overlayCtx.lineTo(x, this.canvasHeight);
            this.overlayCtx.stroke();
        }
        
        // Draw horizontal lines at grid intervals
        for (let y = 0; y < this.canvasHeight; y += gridSpacing) {
            this.overlayCtx.beginPath();
            this.overlayCtx.moveTo(0, y);
            this.overlayCtx.lineTo(this.canvasWidth, y);
            this.overlayCtx.stroke();
        }
        
        this.overlayCtx.restore();
    }

    drawPixelGridOnly() {
        // Helper function to draw just the pixel grid without clearing
        if (!this.showPixelGrid || this.zoom < 2) {
            return;
        }
        
        // Save context state and ensure proper compositing
        this.overlayCtx.save();
        this.overlayCtx.globalCompositeOperation = 'source-over';
        this.overlayCtx.globalAlpha = 1.0;
        
        // Use a more visible blue for the grid 
        this.overlayCtx.fillStyle = 'rgba(135, 206, 235, 0.25)'; // Light blue with 25% opacity for better visibility
        
        // Draw light blue checkerboard pattern
        for (let x = 0; x < this.canvasWidth; x++) {
            for (let y = 0; y < this.canvasHeight; y++) {
                // Create checkerboard pattern
                if ((x + y) % 2 === 0) {
                    this.overlayCtx.fillRect(x, y, 1, 1);
                }
            }
        }        
        // Restore context state
        this.overlayCtx.restore();
    }
    
    // Helper method to clear overlay and redraw base layers (grid, selection)
    clearOverlayAndRedrawBase() {
        // Clear the entire overlay
        this.overlayCtx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
        
        // Redraw base layers using the coordinated approach
        this.drawBaseOverlays();
    }
    
    redrawCanvas() {
        // Safety check - ensure we have proper context
        if (!this.drawingCtx) return;
        
        // Composite layers if layers are enabled
        if (this.layersEnabled) {
            this.compositeLayersToFrame(this.currentFrameIndex);
        }
        
        // Clear the drawing canvas - leave it transparent for onion skin to show through
        this.drawingCtx.globalCompositeOperation = 'source-over';
        this.drawingCtx.globalAlpha = 1.0;
        this.drawingCtx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
        
        // Check if onion skin is active (it's a toggle button with 'active' class)
        const onionSkinToggle = document.getElementById('onionSkinToggle');
        const isOnionSkinActive = onionSkinToggle && onionSkinToggle.classList.contains('active');
        
        // If onion skin is OFF, we need to draw the current frame on the drawing canvas
        if (!isOnionSkinActive) {
            // Draw current frame on drawing canvas when onion skin is disabled
            if (this.frames && Array.isArray(this.frames) && this.frames[this.currentFrameIndex]) {
                this.drawingCtx.drawImage(this.frames[this.currentFrameIndex], 0, 0);
            }
        }
        
        // Only call updateOnionSkin if frames are properly initialized
        if (this.frames && Array.isArray(this.frames)) {
            this.updateOnionSkin();
        }
        
        // Restore overlay state to ensure all overlays are properly displayed
        this.restoreOverlayState();
        
        // After restoring overlay state, redraw any active previews if needed
        if (this.lastMouseEvent) {
            this.redrawCurrentPreview();
        }
    }
    
    updateOnionSkin() {
        // Clear onion canvas completely
        this.onionCtx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
        
        const onionSkinToggle = document.getElementById('onionSkinToggle');
        const opacityContainer = document.getElementById('onionOpacityContainer');
        if (!onionSkinToggle || !onionSkinToggle.classList.contains('active') || !opacityContainer || opacityContainer.style.display === 'none') {
            return;
        }
        
        // If there's only one frame, still draw it so the user can see what they're drawing
        if (!this.frames || this.frames.length < 1) {
            return;
        }
        
        if (this.frames.length === 1) {
            // With only one frame, just draw the current frame at full opacity
            this.onionCtx.save();
            this.onionCtx.globalAlpha = 1.0;
            this.onionCtx.globalCompositeOperation = 'source-over';
            this.onionCtx.drawImage(this.frames[this.currentFrameIndex], 0, 0);
            this.onionCtx.restore();
            return;
        }
        
        const opacity = parseInt(document.getElementById('onionOpacity').value) / 100;
        
        // Get the drawing mode (Black on White or White on Black)
        const isBlackOnWhite = document.getElementById('onionModeBlackOnWhite').classList.contains('active');
        
        // Save the current state
        this.onionCtx.save();
        
        // 1. Draw the current frame at full opacity first
        this.onionCtx.globalAlpha = 1.0;
        this.onionCtx.globalCompositeOperation = 'source-over';
        this.onionCtx.drawImage(this.frames[this.currentFrameIndex], 0, 0);
        
        // 2. Draw previous frame with color mapping
        if (this.currentFrameIndex > 0) {
            this.drawOnionFrame(this.frames[this.currentFrameIndex - 1], 'red', opacity * 0.8, isBlackOnWhite);
        }
        
        // 3. Draw next frame with color mapping  
        if (this.currentFrameIndex < this.frames.length - 1) {
            this.drawOnionFrame(this.frames[this.currentFrameIndex + 1], 'blue', opacity * 0.6, isBlackOnWhite);
        }
        
        this.onionCtx.restore();
    }

    drawOnionFrame(frame, color, opacity, isBlackOnWhite) {
        // Create a temporary canvas to process the frame
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = this.canvasWidth;
        tempCanvas.height = this.canvasHeight;
        const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
        
        // Draw the frame to temp canvas
        tempCtx.drawImage(frame, 0, 0);
        
        // Get image data to process pixels
        const imageData = tempCtx.getImageData(0, 0, this.canvasWidth, this.canvasHeight);
        const data = imageData.data;
        
        // Define target colors based on the drawing mode
        const targetColor = isBlackOnWhite ? [0, 0, 0, 255] : [255, 255, 255, 255]; // Black or White
        const redColor = [255, 80, 80, Math.floor(opacity * 255)];   // Red tint
        const blueColor = [80, 80, 255, Math.floor(opacity * 255)];  // Blue tint
        
        const tintColor = color === 'red' ? redColor : blueColor;
        
        // Process each pixel
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1]; 
            const b = data[i + 2];
            const a = data[i + 3];
            
            // Skip transparent pixels
            if (a === 0) continue;
            
            // Check if this pixel matches our target color (with some tolerance)
            const isTargetColor = Math.abs(r - targetColor[0]) < 50 && 
                                 Math.abs(g - targetColor[1]) < 50 && 
                                 Math.abs(b - targetColor[2]) < 50;
            
            if (isTargetColor) {
                // Replace target color with tinted color
                data[i] = tintColor[0];     // R
                data[i + 1] = tintColor[1]; // G
                data[i + 2] = tintColor[2]; // B
                data[i + 3] = tintColor[3]; // A (opacity)
            } else {
                // Make non-target colors more transparent
                data[i + 3] = Math.floor(a * opacity * 0.3);
            }
        }
        
        // Put the processed image data back
        tempCtx.putImageData(imageData, 0, 0);
        
        // Draw the processed frame to the onion canvas
        this.onionCtx.globalAlpha = 1.0; // Alpha is already handled in the pixel data
        this.onionCtx.globalCompositeOperation = 'source-over';
        this.onionCtx.drawImage(tempCanvas, 0, 0);
    }
    
    updateMousePosition(pos) {
        document.getElementById('mousePos').textContent = `${pos.x}, ${pos.y}`;
        
        // Also update mobile mouse position if it exists
        const mobileMousePos = document.getElementById('mobileMousePos');
        if (mobileMousePos) {
            mobileMousePos.textContent = `${pos.x}, ${pos.y}`;
        }
    }
    
    updateCanvasInfo() {
        document.getElementById('canvasInfo').textContent = `${this.canvasWidth}×${this.canvasHeight}`;
    }
    
    updateUI() {
        document.getElementById('currentFrame').textContent = this.currentFrameIndex + 1;
        document.getElementById('totalFrames').textContent = this.frames.length;
        
        document.getElementById('prevFrame').disabled = this.currentFrameIndex === 0;
        document.getElementById('nextFrame').disabled = this.currentFrameIndex === this.frames.length - 1;
        document.getElementById('moveFrameLeft').disabled = this.currentFrameIndex === 0;
        document.getElementById('moveFrameRight').disabled = this.currentFrameIndex === this.frames.length - 1;
        document.getElementById('deleteFrame').disabled = this.frames.length === 1;
        
        // Update frame thumbnails
        this.updateFrameList();
        
        // Update animation panel if it's open
        if (this.animationEnabled) {
            this.updateAnimationUI();
        }
        
        // Update edit button states
        this.updateEditButtonStates();
    }
    
    updateEditButtonStates() {
        // Update paste-related button states based on clipboard content
        const hasClipboard = this.clipboard !== null;
        
        document.getElementById('pasteModeBtn').disabled = !hasClipboard;
        
        // If clipboard is empty and paste mode is active, exit paste mode
        if (!hasClipboard && this.isPasteModeActive) {
            this.isPasteModeActive = false;
            const pasteModeBtn = document.getElementById('pasteModeBtn');
            pasteModeBtn.classList.remove('active');
            pasteModeBtn.textContent = 'Paste Mode';
            this.clearPastePreview();
        }
    }
    
    toggleAnimationSettings() {
        const animationSettings = document.getElementById('animationSettings');
        const toggleBtn = document.getElementById('animationToggle');
        
        if (animationSettings && toggleBtn) {
            const isVisible = animationSettings.style.display !== 'none';
            animationSettings.style.display = isVisible ? 'none' : 'block';
            
            // Toggle button active state
            if (isVisible) {
                toggleBtn.classList.remove('active');
            } else {
                toggleBtn.classList.add('active');
            }
        }
        
        // Auto-update code output when animation mode changes
        this.generateCode();
    }
    
    toggleMirrorTransformSettings() {
        const mirrorTransformSettings = document.getElementById('mirrorTransformSettings');
        const toggleBtn = document.getElementById('mirrorTransformToggle');
        
        if (mirrorTransformSettings && toggleBtn) {
            const isVisible = mirrorTransformSettings.style.display !== 'none';
            mirrorTransformSettings.style.display = isVisible ? 'none' : 'block';
            
            // Toggle button active state
            if (isVisible) {
                toggleBtn.classList.remove('active');
            } else {
                toggleBtn.classList.add('active');
            }
        }
    }

    toggleMirrorHorizontal() {
        this.mirrorHorizontal = !this.mirrorHorizontal;
        this.mirrorBoth = this.mirrorHorizontal && this.mirrorVertical;
        
        const btn = document.getElementById('mirrorHorizontal');
        if (this.mirrorHorizontal) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    }

    toggleMirrorVertical() {
        this.mirrorVertical = !this.mirrorVertical;
        this.mirrorBoth = this.mirrorHorizontal && this.mirrorVertical;
        
        const btn = document.getElementById('mirrorVertical');
        if (this.mirrorVertical) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    }

    toggleOnionSkin() {
        const opacityContainer = document.getElementById('onionOpacityContainer');
        const animOpacityContainer = document.getElementById('animOnionOpacityContainer');
        const toggleBtn = document.getElementById('onionSkinToggle');
        const animToggleBtn = document.getElementById('animOnionSkinToggle');
        
        if (toggleBtn) {
            // Toggle onion skin functionality
            toggleBtn.classList.toggle('active');
            if (animToggleBtn) {
                animToggleBtn.classList.toggle('active');
            }
            
            this.onionSkinEnabled = toggleBtn.classList.contains('active');
            
            // Show/hide opacity controls
            const newDisplay = this.onionSkinEnabled ? 'flex' : 'none';
            if (opacityContainer) {
                opacityContainer.style.display = newDisplay;
            }
            if (animOpacityContainer) {
                animOpacityContainer.style.display = newDisplay;
            }
            
            this.redrawCanvas();
        }
    }

    setOnionMode(mode) {
        // Store the mode
        this.onionSkinMode = mode;
        
        // Update active button states
        const blackOnWhiteBtn = document.getElementById('onionModeBlackOnWhite');
        const whiteOnBlackBtn = document.getElementById('onionModeWhiteOnBlack');
        
        if (blackOnWhiteBtn && whiteOnBlackBtn) {
            blackOnWhiteBtn.classList.remove('active');
            whiteOnBlackBtn.classList.remove('active');
            
            if (mode === 'blackOnWhite') {
                blackOnWhiteBtn.classList.add('active');
            } else {
                whiteOnBlackBtn.classList.add('active');
            }
        }
        
        this.updateOnionSkin();
        this.redrawCanvas(); // Ensure canvas is redrawn with new onion skin
    }
    
    
    clearCurrentFrame() {
        // Capture snapshot before clearing
        this.captureSnapshot();
        
        // If layers are enabled, clear the current layer
        if (this.layersEnabled) {
            const frameData = this.frameLayers && this.frameLayers[this.currentFrameIndex];
            if (frameData) {
                const currentLayer = frameData.layers[frameData.currentLayerIndex];
                const ctx = currentLayer.canvas.getContext('2d', { willReadFrequently: true });
                
                // All layers should be cleared to white
                ctx.fillStyle = 'white';
                ctx.fillRect(0, 0, this.canvasWidth, this.canvasHeight);
                
                // Composite and redraw
                this.compositeLayersToFrame(this.currentFrameIndex);
                this.redrawCanvas();
                
                // Push undo
                this.pushUndo();
                return;
            }
        }
        
        // Normal frame clearing (no layers)
        const frame = this.frames[this.currentFrameIndex];
        const ctx = frame.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, this.canvasWidth, this.canvasHeight);
        
        this.redrawCanvas();
        
        // Push undo
        this.pushUndo();
    }

    // Frame management methods will be added in the next part
    addFrame() {
        const newFrame = this.createEmptyFrame();
        const insertIndex = this.currentFrameIndex + 1;
        
        // Get layer data if layers are enabled
        let layerData = null;
        if (this.layersEnabled) {
            // Initialize will be done in command execute
            layerData = {
                layers: [{
                    name: 'Layer 0',
                    canvas: document.createElement('canvas'),
                    visible: true,
                    transparencyMode: 'white'
                }],
                currentLayerIndex: 0
            };
            layerData.layers[0].canvas.width = this.canvasWidth;
            layerData.layers[0].canvas.height = this.canvasHeight;
            const ctx = layerData.layers[0].canvas.getContext('2d', { willReadFrequently: true });
            ctx.fillStyle = 'white';
            ctx.fillRect(0, 0, this.canvasWidth, this.canvasHeight);
        }
        
        // Use command pattern for undo support
        const command = new AddFrameCommand(this, insertIndex, newFrame, layerData);
        this.executeCommand(command);
        
        // If this is the first frame added (now we have 2 frames), switch to animation format
        if (this.frames.length === 2) {
            const exportFormatSelect = document.getElementById('exportFormat');
            if (exportFormatSelect) {
                exportFormatSelect.value = 'animation';
                this.updateAssetNameDefault('animation');
            }
        }
    }
    
    copyFrame() {
        // Get the current frame's canvas data
        const currentCanvas = this.frames[this.currentFrameIndex];
        const currentCtx = currentCanvas.getContext('2d', { willReadFrequently: true });
        
        // Create a new frame with the same dimensions
        const newFrame = this.createEmptyFrame();
        const newCtx = newFrame.getContext('2d', { willReadFrequently: true });
        
        // Copy the current frame's content to the new frame
        newCtx.drawImage(currentCanvas, 0, 0);
        
        const insertIndex = this.currentFrameIndex + 1;
        
        // Copy layer data if layers are enabled
        let layerData = null;
        if (this.layersEnabled && this.frameLayers && this.frameLayers[this.currentFrameIndex]) {
            const originalLayerData = this.frameLayers[this.currentFrameIndex];
            layerData = {
                layers: [],
                currentLayerIndex: originalLayerData.currentLayerIndex
            };
            
            for (const layer of originalLayerData.layers) {
                const copiedLayer = {
                    name: layer.name,
                    canvas: document.createElement('canvas'),
                    visible: layer.visible
                };
                copiedLayer.canvas.width = layer.canvas.width;
                copiedLayer.canvas.height = layer.canvas.height;
                const layerCtx = copiedLayer.canvas.getContext('2d', { willReadFrequently: true });
                layerCtx.drawImage(layer.canvas, 0, 0);
                layerData.layers.push(copiedLayer);
            }
        }
        
        // Use command pattern for undo support
        const command = new AddFrameCommand(this, insertIndex, newFrame, layerData);
        this.executeCommand(command);
        
        // If this is the first frame added (now we have 2 frames), switch to animation format
        if (this.frames.length === 2) {
            const exportFormatSelect = document.getElementById('exportFormat');
            if (exportFormatSelect) {
                exportFormatSelect.value = 'animation';
                this.updateAssetNameDefault('animation');
            }
        }
    }
    
    deleteFrame() {
        if (this.frames.length === 1) return;
        
        // Clone the frame canvas for undo
        const frameToDelete = this.frames[this.currentFrameIndex];
        const clonedFrame = document.createElement('canvas');
        clonedFrame.width = frameToDelete.width;
        clonedFrame.height = frameToDelete.height;
        const ctx = clonedFrame.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(frameToDelete, 0, 0);
        
        // Clone layer data if layers are enabled
        let clonedLayerData = null;
        if (this.layersEnabled && this.frameLayers && this.frameLayers[this.currentFrameIndex]) {
            const originalLayerData = this.frameLayers[this.currentFrameIndex];
            clonedLayerData = {
                layers: [],
                currentLayerIndex: originalLayerData.currentLayerIndex
            };
            
            for (const layer of originalLayerData.layers) {
                const clonedLayer = {
                    name: layer.name,
                    canvas: document.createElement('canvas'),
                    visible: layer.visible
                };
                clonedLayer.canvas.width = layer.canvas.width;
                clonedLayer.canvas.height = layer.canvas.height;
                const layerCtx = clonedLayer.canvas.getContext('2d', { willReadFrequently: true });
                layerCtx.drawImage(layer.canvas, 0, 0);
                clonedLayerData.layers.push(clonedLayer);
            }
        }
        
        // Use command pattern for undo support
        const command = new DeleteFrameCommand(this, this.currentFrameIndex, clonedFrame, clonedLayerData);
        this.executeCommand(command);
    }
    
    moveFrameLeft() {
        if (this.frames.length <= 1) return;
        
        const currentIndex = this.currentFrameIndex;
        
        // Can't move left if already at the leftmost position
        if (currentIndex <= 0) return;
        
        this.swapFrames(currentIndex, currentIndex - 1);
    }
    
    moveFrameRight() {
        if (this.frames.length <= 1) return;
        
        const currentIndex = this.currentFrameIndex;
        
        // Can't move right if already at the rightmost position
        if (currentIndex >= this.frames.length - 1) return;
        
        this.swapFrames(currentIndex, currentIndex + 1);
    }
    
    swapFrames(indexA, indexB) {
        if (indexA === indexB) return;
        
        // Save current state for undo
        this.captureSnapshot();
        
        // Swap the frame canvases
        const temp = this.frames[indexA];
        this.frames[indexA] = this.frames[indexB];
        this.frames[indexB] = temp;
        
        // Swap layer data if layers are enabled
        if (this.layersEnabled && this.frameLayers) {
            const tempLayers = this.frameLayers[indexA];
            this.frameLayers[indexA] = this.frameLayers[indexB];
            this.frameLayers[indexB] = tempLayers;
        }
        
        // Update current frame index to follow the moved frame
        if (this.currentFrameIndex === indexA) {
            this.currentFrameIndex = indexB;
        } else if (this.currentFrameIndex === indexB) {
            this.currentFrameIndex = indexA;
        }
        
        // Update UI and redraw
        this.updateFrameList();
        this.updateUI();
        this.redrawCanvas();
        this.regenerateAllThumbnails();
        this.markAsUnsaved();
        
        // Push to undo stack
        this.pushUndo();
    }
    
    previousFrame() {
        if (this.currentFrameIndex > 0) {
            this.soloLayerIndex = null; // Exit solo mode when switching frames
            this.setCurrentFrame(this.currentFrameIndex - 1);
            
            // Initialize layers for this frame if layers are enabled and not already initialized
            if (this.layersEnabled && (!this.frameLayers[this.currentFrameIndex] || !this.frameLayers[this.currentFrameIndex].layers)) {
                this.initializeLayersForFrame(this.currentFrameIndex);
            }
        }
    }
    
    nextFrame() {
        if (this.currentFrameIndex < this.frames.length - 1) {
            this.soloLayerIndex = null; // Exit solo mode when switching frames
            this.setCurrentFrame(this.currentFrameIndex + 1);
            
            // Initialize layers for this frame if layers are enabled and not already initialized
            if (this.layersEnabled && (!this.frameLayers[this.currentFrameIndex] || !this.frameLayers[this.currentFrameIndex].layers)) {
                this.initializeLayersForFrame(this.currentFrameIndex);
            }
        }
    }
    
    toggleAnimation() {
        if (this.isPlaying) {
            this.stopAnimation();
        } else {
            this.startAnimation();
        }
    }
    
    advanceFrame() {
        if (this.animationMode === 'cycle') {
            // Simple cycle through frames
            this.currentFrameIndex = (this.currentFrameIndex + 1) % this.frames.length;
        } else if (this.animationMode === 'boomerang') {
            // Bounce back and forth
            this.currentFrameIndex += this.animationDirection;
            
            // Check bounds and reverse direction
            if (this.currentFrameIndex >= this.frames.length - 1) {
                this.currentFrameIndex = this.frames.length - 1;
                this.animationDirection = -1;
            } else if (this.currentFrameIndex <= 0) {
                this.currentFrameIndex = 0;
                this.animationDirection = 1;
            }
        }
    }
    
    updatePlayButtonStates(isPlaying) {
        const playBtn = document.getElementById('playBtn');
        const animPlayBtn = document.getElementById('animPlayBtn');
        
        if (isPlaying) {
            playBtn.textContent = '⏸️ Pause';
            animPlayBtn.textContent = '⏸️ Pause';
        } else {
            playBtn.textContent = '▶️ Play';
            animPlayBtn.textContent = '▶️ Play';
        }
    }
    
    stopAnimation() {
        if (this.isPlaying) {
            clearInterval(this.animationInterval);
            this.isPlaying = false;
            this.updatePlayButtonStates(false);
        }
    }
    
    startAnimation() {
        if (!this.isPlaying) {
            // Try to get frame rate from either control panel
            let frameRateElement = document.getElementById('frameRate');
            if (!frameRateElement || frameRateElement.style.display === 'none') {
                frameRateElement = document.getElementById('animFrameRate');
            }
            const fps = parseFloat(frameRateElement.value);
            
            this.animationInterval = setInterval(() => {
                this.advanceFrame();
                this.updateUI();
                this.redrawCanvas();
            }, 1000 / fps);
            this.isPlaying = true;
            this.updatePlayButtonStates(true);
        }
    }

    setAnimationMode(mode) {
        this.animationMode = mode;
        this.animationDirection = 1; // Reset direction
        
        // Update button states - only for animation mode buttons
        const cycleBtn = document.getElementById('cycleMode');
        const boomerangBtn = document.getElementById('boomerangMode');
        
        if (cycleBtn && boomerangBtn) {
            cycleBtn.classList.toggle('active', mode === 'cycle');
            boomerangBtn.classList.toggle('active', mode === 'boomerang');
        }
    }
    
    generateThumbnail(frameIndex) {
        // Update main frame thumbnails (64x64)
        const frameList = document.getElementById('frameList');
        if (frameList) {
            const thumbCanvas = frameList.querySelectorAll('.thumb-canvas')[frameIndex];
            if (thumbCanvas) {
                const ctx = thumbCanvas.getContext('2d', { willReadFrequently: true });
                ctx.imageSmoothingEnabled = false;
                ctx.clearRect(0, 0, 64, 64);
                ctx.drawImage(this.frames[frameIndex], 0, 0, 64, 64);
            }
        }
        
        // Update animation panel thumbnails (80x80) if animation panel is open
        if (this.animationEnabled) {
            const framesList = document.getElementById('framesList');
            if (framesList) {
                const animThumbCanvas = framesList.querySelectorAll('.thumb-canvas')[frameIndex];
                if (animThumbCanvas) {
                    const ctx = animThumbCanvas.getContext('2d', { willReadFrequently: true });
                    ctx.imageSmoothingEnabled = false;
                    ctx.clearRect(0, 0, 80, 80);
                    ctx.drawImage(this.frames[frameIndex], 0, 0, 80, 80);
                }
            }
        }
    }
    
    regenerateAllThumbnails() {
        // Regenerate thumbnails for all frames
        // Only regenerate if frames and thumbnails exist
        if (!this.frames || this.frames.length === 0) {
            return; // Frames haven't been initialized yet
        }

        const thumbCanvases = document.querySelectorAll('.thumb-canvas');
        if (thumbCanvases.length === 0) {
            return; // Thumbnails haven't been created yet
        }

        for (let i = 0; i < this.frames.length; i++) {
            this.generateThumbnail(i);
        }
        
        // Also update animation panel if it's open
        if (this.animationEnabled) {
            this.updateAnimationUI();
        }
    }    updateFrameList() {
        const frameList = document.getElementById('frameList');
        frameList.innerHTML = '';
        
        this.frames.forEach((frame, index) => {
            const thumbDiv = document.createElement('div');
            thumbDiv.className = `frame-thumb ${index === this.currentFrameIndex ? 'active' : ''}`;
            thumbDiv.dataset.frame = index;
            
            const canvas = document.createElement('canvas');
            canvas.className = 'thumb-canvas';
            canvas.width = 64;
            canvas.height = 64;
            
            const label = document.createElement('span');
            label.className = 'frame-label';
            label.textContent = `Frame ${index}`;
            
            thumbDiv.appendChild(canvas);
            thumbDiv.appendChild(label);
            frameList.appendChild(thumbDiv);
            
            // Generate thumbnail
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(frame, 0, 0, 64, 64);
            
            // Click handler
            thumbDiv.addEventListener('click', () => {
                this.setCurrentFrame(index);
                this.soloLayerIndex = null; // Exit solo mode when switching frames
                
                // Initialize layers for this frame if layers are enabled and not already initialized
                if (this.layersEnabled && (!this.frameLayers[index] || !this.frameLayers[index].layers)) {
                    this.initializeLayersForFrame(index);
                }
                
                if (this.layersEnabled) {
                    this.updateLayersUI();
                }
            });
        });
    }

    updateAssetNameDefault(format) {
        const assetNameInput = document.getElementById('assetName');
        // Only update if the current value is still a default value
        if (assetNameInput.value === 'my_image' || assetNameInput.value === 'my_animation') {
            assetNameInput.value = format === 'animation' ? 'my_animation' : 'my_image';
        }
    }

    validateAssetName(input) {
        const warning = document.getElementById('nameWarning');
        const value = input.value;
        
        // Check for any characters that are not letters, numbers, or underscores
        // Also check if it starts with a number (invalid in C++)
        const hasInvalidChars = /[^a-zA-Z0-9_]/.test(value);
        const startsWithNumber = /^[0-9]/.test(value);
        
        if (hasInvalidChars || startsWithNumber) {
            warning.style.display = 'block';
        } else {
            warning.style.display = 'none';
        }
    }

    cleanAssetName(name) {
        // Replace any non-alphanumeric characters (except underscores) with underscores
        let cleaned = name.replace(/[^a-zA-Z0-9_]/g, '_');
        
        // If the name starts with a number, prefix with an underscore
        if (/^[0-9]/.test(cleaned)) {
            cleaned = '_' + cleaned;
        }
        
        // If the name is empty or only underscores, use a default
        if (!cleaned || /^_*$/.test(cleaned)) {
            cleaned = 'my_asset';
        }
        
        return cleaned;
    }

    // Helper function to clamp coordinates to canvas bounds and find intersection point
    clampLineToCanvas(x1, y1, x2, y2) {
        // If both points are within bounds, no clamping needed
        if (x1 >= 0 && x1 < this.canvasWidth && y1 >= 0 && y1 < this.canvasHeight &&
            x2 >= 0 && x2 < this.canvasWidth && y2 >= 0 && y2 < this.canvasHeight) {
            return { x1, y1, x2, y2 };
        }

        // Cohen-Sutherland line clipping algorithm
        const minX = 0;
        const maxX = this.canvasWidth - 1;
        const minY = 0;
        const maxY = this.canvasHeight - 1;

        // Compute region codes for both endpoints
        const computeCode = (x, y) => {
            let code = 0;
            if (x < minX) code |= 1; // left
            else if (x > maxX) code |= 2; // right
            if (y < minY) code |= 4; // top
            else if (y > maxY) code |= 8; // bottom
            return code;
        };

        let code1 = computeCode(x1, y1);
        let code2 = computeCode(x2, y2);
        
        let clampedX1 = x1, clampedY1 = y1;
        let clampedX2 = x2, clampedY2 = y2;
        
        while (true) {
            // Both points inside - accept
            if ((code1 | code2) === 0) {
                break;
            }
            
            // Both points share an outside region - line is completely outside canvas
            if ((code1 & code2) !== 0) {
                // Return null to indicate no visible line
                return null;
            }
            
            // At least one point is outside - clip it
            const codeOut = code1 !== 0 ? code1 : code2;
            let x, y;
            
            const dx = clampedX2 - clampedX1;
            const dy = clampedY2 - clampedY1;
            
            // Find intersection point with boundary
            if (codeOut & 8) { // bottom
                x = clampedX1 + dx * (maxY - clampedY1) / dy;
                y = maxY;
            } else if (codeOut & 4) { // top
                x = clampedX1 + dx * (minY - clampedY1) / dy;
                y = minY;
            } else if (codeOut & 2) { // right
                y = clampedY1 + dy * (maxX - clampedX1) / dx;
                x = maxX;
            } else { // left (codeOut & 1)
                y = clampedY1 + dy * (minX - clampedX1) / dx;
                x = minX;
            }
            
            // Update the point that was outside
            if (codeOut === code1) {
                clampedX1 = x;
                clampedY1 = y;
                code1 = computeCode(clampedX1, clampedY1);
            } else {
                clampedX2 = x;
                clampedY2 = y;
                code2 = computeCode(clampedX2, clampedY2);
            }
        }

        // Floor and ensure within bounds (consistent with pixel coordinate system)
        clampedX1 = Math.max(minX, Math.min(maxX, Math.floor(clampedX1)));
        clampedY1 = Math.max(minY, Math.min(maxY, Math.floor(clampedY1)));
        clampedX2 = Math.max(minX, Math.min(maxX, Math.floor(clampedX2)));
        clampedY2 = Math.max(minY, Math.min(maxY, Math.floor(clampedY2)));

        return { 
            x1: clampedX1, 
            y1: clampedY1, 
            x2: clampedX2, 
            y2: clampedY2 
        };
    }

    // Clamp coordinates to canvas bounds for previews
    clampToCanvas(x, y) {
        return {
            x: Math.max(0, Math.min(this.canvasWidth - 1, Math.floor(x))),
            y: Math.max(0, Math.min(this.canvasHeight - 1, Math.floor(y)))
        };
    }

    // Check if coordinates are within canvas bounds
    isWithinCanvas(x, y) {
        return x >= 0 && x < this.canvasWidth && y >= 0 && y < this.canvasHeight;
    }

    generateCode() {
        // Auto-detect format based on animation settings
        const animationEnabled = document.getElementById('animationEnabled')?.checked;
        const hasMultipleFrames = this.frames && this.frames.length > 1;
        
        let format;
        // Get the selected format
        format = document.getElementById('exportFormat').value;
        
        // If animation format is selected but only single frame exists, use single frame
        if (format === 'animation' && !hasMultipleFrames) {
            format = 'hpp';
            document.getElementById('exportFormat').value = 'hpp';
        }
        
        let code = '';
        
        if (format === 'hpp') {
            code = this.generateSingleFrameHPP();
        } else if (format === 'animation') {
            code = this.generateAnimationHPP();
        } else if (format === 'layers') {
            code = this.generateLayersHPP();
        }
        
        document.getElementById('codeOutput').value = code;
    }
    
    generateSingleFrameHPP() {
        const frame = this.frames[this.currentFrameIndex];
        const ctx = frame.getContext('2d', { willReadFrequently: true });
        const imageData = ctx.getImageData(0, 0, this.canvasWidth, this.canvasHeight);
        const data = imageData.data;
        
        // Get the asset name from the input and clean it
        const rawAssetName = document.getElementById('assetName').value || 'my_image';
        const assetName = this.cleanAssetName(rawAssetName);
        
        let code = `// KYWY_FORMAT: SINGLE_FRAME\n`;
        code += `// Generated bitmap data for ${this.canvasWidth}x${this.canvasHeight} image\n`;
        code += `// Created with Kywy Drawing Editor\n\n`;
        code += `uint8_t ${assetName}_data[${Math.ceil((this.canvasWidth * this.canvasHeight) / 8)}] = {\n`;
        
        const bytes = [];
        for (let byte = 0; byte < Math.ceil((this.canvasWidth * this.canvasHeight) / 8); byte++) {
            let byteValue = 0;
            for (let bit = 0; bit < 8; bit++) {
                const pixelIndex = byte * 8 + bit;
                if (pixelIndex < this.canvasWidth * this.canvasHeight) {
                    const dataIndex = pixelIndex * 4;
                    const isWhite = data[dataIndex] >= 128; // R value >= 128 = white
                    if (isWhite) {
                        byteValue |= (1 << (7 - bit));
                    }
                }
            }
            bytes.push(`0x${byteValue.toString(16).padStart(2, '0').toUpperCase()}`);
        }
        
        // Format bytes with proper line breaks
        for (let i = 0; i < bytes.length; i += 12) {
            code += '    ' + bytes.slice(i, i + 12).join(', ');
            if (i + 12 < bytes.length) code += ',';
            code += '\n';
        }
        
        code += `};\n\n`;
        code += `// Bitmap Constants\n`;
        code += `#define ${assetName.toUpperCase()}_WIDTH ${this.canvasWidth}\n`;
        code += `#define ${assetName.toUpperCase()}_HEIGHT ${this.canvasHeight}\n`;
        
        return code;
    }
    
    generateAnimationHPP() {
        if (this.frames.length === 1) {
            return this.generateSingleFrameHPP();
        }
        
        // Get the asset name from the input and clean it
        const rawAssetName = document.getElementById('assetName').value || 'my_animation';
        const assetName = this.cleanAssetName(rawAssetName);
        
        let code = `// KYWY_FORMAT: ANIMATION\n`;
        code += `// Generated animation data for ${this.canvasWidth}x${this.canvasHeight} animation\n`;
        code += `// ${this.frames.length} frames - Created with Kywy Drawing Editor\n\n`;
        
        // Generate frame data
        const frameDataArrays = [];
        this.frames.forEach((frame, index) => {
            const ctx = frame.getContext('2d', { willReadFrequently: true });
            const imageData = ctx.getImageData(0, 0, this.canvasWidth, this.canvasHeight);
            const data = imageData.data;
            
            const bytes = [];
            for (let byte = 0; byte < Math.ceil((this.canvasWidth * this.canvasHeight) / 8); byte++) {
                let byteValue = 0;
                for (let bit = 0; bit < 8; bit++) {
                    const pixelIndex = byte * 8 + bit;
                    if (pixelIndex < this.canvasWidth * this.canvasHeight) {
                        const dataIndex = pixelIndex * 4;
                        const isWhite = data[dataIndex] >= 128;
                        if (isWhite) {
                            byteValue |= (1 << (7 - bit));
                        }
                    }
                }
                bytes.push(`0x${byteValue.toString(16).padStart(2, '0').toUpperCase()}`);
            }
            
            frameDataArrays.push(bytes);
        });
        
        // Output individual frame arrays
        frameDataArrays.forEach((bytes, index) => {
            code += `// Animation Frame ${index}\n`;
            code += `uint8_t ${assetName}_anim_frame_${index}[${bytes.length}] = {\n`;
            for (let i = 0; i < bytes.length; i += 12) {
                code += '    ' + bytes.slice(i, i + 12).join(', ');
                if (i + 12 < bytes.length) code += ',';
                code += '\n';
            }
            code += `};\n\n`;
        });
        
        // Output frame pointer array
        code += `// Animation Frame Index Table\n`;
        code += `const uint8_t* ${assetName}_anim_frames[${this.frames.length}] = {\n`;
        for (let i = 0; i < this.frames.length; i++) {
            code += `    ${assetName}_anim_frame_${i}`;
            if (i < this.frames.length - 1) code += ',';
            code += `  // [${i}]\n`;
        }
        code += `};\n\n`;
        
        // Output sprite setup
        code += `// Animation Constants\n`;
        code += `#define ${assetName.toUpperCase()}_FRAME_COUNT ${this.frames.length}\n`;
        code += `#define ${assetName.toUpperCase()}_WIDTH ${this.canvasWidth}\n`;
        code += `#define ${assetName.toUpperCase()}_HEIGHT ${this.canvasHeight}\n`;
        
        // Calculate animation speed from frame rate slider
        const frameRate = parseFloat(document.getElementById('frameRate').value);
        const animationSpeed = Math.round(1000 / frameRate); // Convert FPS to milliseconds per frame
        code += `#define ${assetName.toUpperCase()}_SPEED ${animationSpeed}  // milliseconds per frame\n`;
        
        return code;
    }
    
    generateLayersHPP() {
        if (!this.layersEnabled) {
            // Fallback to single frame or animation export if layers not enabled
            if (this.frames.length > 1) {
                return this.generateAnimationHPP();
            }
            return this.generateSingleFrameHPP();
        }
        
        // Check if we have multiple frames with layers - export all frames
        const framesWithLayers = [];
        for (let frameIndex = 0; frameIndex < this.frames.length; frameIndex++) {
            if (this.frameLayers[frameIndex] && this.frameLayers[frameIndex].layers.length > 0) {
                framesWithLayers.push({
                    frameIndex: frameIndex,
                    layers: this.frameLayers[frameIndex].layers
                });
            }
        }
        
        if (framesWithLayers.length === 0) {
            return '// No layers to export\n';
        }
        
        // Get the asset name from the input and clean it
        const rawAssetName = document.getElementById('assetName').value || 'my_layers';
        const assetName = this.cleanAssetName(rawAssetName);
        
        // Determine if this is multi-frame or single frame
        const isMultiFrame = framesWithLayers.length > 1;
        
        let code = `// KYWY_FORMAT: ${isMultiFrame ? 'FRAMES_WITH_LAYERS' : 'LAYERS'}\n`;
        code += `// Generated layer data for ${this.canvasWidth}x${this.canvasHeight} image\n`;
        
        if (isMultiFrame) {
            code += `// ${framesWithLayers.length} frames with layers\n`;
        } else {
            const layers = framesWithLayers[0].layers;
            code += `// ${layers.length} total layers (${layers.filter(l => l.visible).length} visible, ${layers.filter(l => !l.visible).length} hidden)\n`;
        }
        
        code += `// Created with Kywy Drawing Editor\n\n`;
        
        // Export all frames with their layers
        framesWithLayers.forEach((frameData, frameIndex) => {
            const layers = frameData.layers;
            
            if (isMultiFrame) {
                code += `// ===== Frame ${frameIndex} =====\n`;
                code += `// ${layers.length} layers (${layers.filter(l => l.visible).length} visible)\n\n`;
            }
            
            // Generate data for each visible layer in this frame
            layers.forEach((layer, layerIndex) => {
                // Skip hidden layers
                if (!layer.visible) return;
                
                const ctx = layer.canvas.getContext('2d', { willReadFrequently: true });
                const imageData = ctx.getImageData(0, 0, this.canvasWidth, this.canvasHeight);
                const data = imageData.data;
                
                const bytes = [];
                let whitePixelCount = 0;
                let blackPixelCount = 0;
                
                for (let byte = 0; byte < Math.ceil((this.canvasWidth * this.canvasHeight) / 8); byte++) {
                    let byteValue = 0;
                    for (let bit = 0; bit < 8; bit++) {
                        const pixelIndex = byte * 8 + bit;
                        if (pixelIndex < this.canvasWidth * this.canvasHeight) {
                            const dataIndex = pixelIndex * 4;
                            const r = data[dataIndex];
                            const g = data[dataIndex + 1];
                            const b = data[dataIndex + 2];
                            
                            // White pixels (light colors) = bit 1, Black pixels (dark colors) = bit 0
                            const isWhite = (r >= 128 || g >= 128 || b >= 128);
                            
                            if (isWhite) {
                                byteValue |= (1 << (7 - bit));
                                whitePixelCount++;
                            } else {
                                blackPixelCount++;
                            }
                        }
                    }
                    bytes.push(`0x${byteValue.toString(16).padStart(2, '0').toUpperCase()}`);
                }
                
                console.log(`Frame ${frameIndex} Layer ${layerIndex} (${layer.name}): ${whitePixelCount} white, ${blackPixelCount} black`);
                
                // Output layer array
                const arrayName = isMultiFrame 
                    ? `${assetName}_frame${frameIndex}_layer${layerIndex}`
                    : `${assetName}_layer${layerIndex}`;
                
                code += `// Layer ${layerIndex}: ${layer.name}\n`;
                code += `uint8_t ${arrayName}[${bytes.length}] = {\n`;
                for (let i = 0; i < bytes.length; i += 12) {
                    code += '    ' + bytes.slice(i, i + 12).join(', ');
                    if (i + 12 < bytes.length) {
                        code += ',\n';
                    } else {
                        code += '\n';
                    }
                }
                code += `};\n\n`;
            });
        });
        
        // Output constants
        code += `// Image Constants\n`;
        code += `#define ${assetName.toUpperCase()}_WIDTH ${this.canvasWidth}\n`;
        code += `#define ${assetName.toUpperCase()}_HEIGHT ${this.canvasHeight}\n`;
        
        if (isMultiFrame) {
            code += `#define ${assetName.toUpperCase()}_FRAME_COUNT ${framesWithLayers.length}\n`;
            // Add layer counts for each frame
            framesWithLayers.forEach((frameData, frameIndex) => {
                const visibleLayerCount = frameData.layers.filter(l => l.visible).length;
                code += `#define ${assetName.toUpperCase()}_FRAME${frameIndex}_LAYER_COUNT ${visibleLayerCount}\n`;
            });
        } else {
            const visibleLayerCount = framesWithLayers[0].layers.filter(l => l.visible).length;
            code += `#define ${assetName.toUpperCase()}_LAYER_COUNT ${visibleLayerCount}\n`;
        }
        
        return code;
    }
    
    // File operations with selection support
    copy() {
        // If already in paste mode, just exit it and return
        if (this.isPasteModeActive) {
            this.isPasteModeActive = false;
            const pasteModeBtn = document.getElementById('pasteModeBtn');
            const pasteModeOptions = document.getElementById('pasteModeOptions');
            pasteModeBtn.classList.remove('active');
            pasteModeBtn.textContent = 'Paste Mode';
            pasteModeOptions.style.display = 'none';
            this.clearPastePreview();
            this.pasteDragActive = false;
            return; // Exit without performing copy
        }
        
        if (this.selection && this.selection.active) {
            this.copySelection();
        } else {
            // Copy the entire current frame
            const frameCanvas = this.frames[this.currentFrameIndex].cloneNode();
            this.clipboard = {
                data: frameCanvas,
                isSelection: false,
                width: this.canvasWidth,
                height: this.canvasHeight
            };
            this.updateEditButtonStates();
        }
        
        // Automatically enter paste mode
        this.setTool('select');
        this.isPasteModeActive = true;
        
        // Update paste mode button and show options
        const pasteModeBtn = document.getElementById('pasteModeBtn');
        const pasteModeOptions = document.getElementById('pasteModeOptions');
        
        pasteModeBtn.classList.add('active');
        pasteModeBtn.textContent = 'Exit Paste Mode';
        pasteModeOptions.style.display = 'block';
        pasteModeBtn.disabled = false;
    }
    
    copySelection() {
        if (!this.selection || !this.selection.active) return;
        
        if (this.selection.mode === 'lasso') {
            this.copyLassoSelection();
            return;
        }
        
        // Rectangle selection logic
        const { startX, startY, endX, endY } = this.selection;
        const minX = Math.min(startX, endX);
        const minY = Math.min(startY, endY);
        const width = Math.abs(endX - startX);
        const height = Math.abs(endY - startY);
        
        // Don't copy zero-sized selections
        if (width <= 0 || height <= 0) {
            return;
        }
        
        // Clamp selection bounds to canvas dimensions to prevent out-of-bounds access
        const clampedMinX = Math.max(0, Math.min(minX, this.canvasWidth));
        const clampedMinY = Math.max(0, Math.min(minY, this.canvasHeight));
        const clampedMaxX = Math.max(0, Math.min(minX + width, this.canvasWidth));
        const clampedMaxY = Math.max(0, Math.min(minY + height, this.canvasHeight));
        const clampedWidth = clampedMaxX - clampedMinX;
        const clampedHeight = clampedMaxY - clampedMinY;
        
        // Don't copy if clamped area is empty
        if (clampedWidth <= 0 || clampedHeight <= 0) {
            return;
        }
        
        // Create a canvas for the selection
        const selectionCanvas = document.createElement('canvas');
        selectionCanvas.width = clampedWidth;
        selectionCanvas.height = clampedHeight;
        const selectionCtx = selectionCanvas.getContext('2d', { willReadFrequently: true });
        
        // Copy the selected area from the current frame (only the clamped bounds)
        const currentFrame = this.frames[this.currentFrameIndex];
        selectionCtx.drawImage(currentFrame, clampedMinX, clampedMinY, clampedWidth, clampedHeight, 0, 0, clampedWidth, clampedHeight);
        
        this.clipboard = {
            data: selectionCanvas,
            isSelection: true,
            width: clampedWidth,
            height: clampedHeight
        };
    }
    
    copyLassoSelection() {
        const lassoPoints = this.selection.lassoPoints;
        if (!lassoPoints || lassoPoints.length < 3) return;
        
        // Calculate bounding rectangle of lasso
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const point of lassoPoints) {
            minX = Math.min(minX, point.x);
            minY = Math.min(minY, point.y);
            maxX = Math.max(maxX, point.x);
            maxY = Math.max(maxY, point.y);
        }
        
        const width = Math.ceil(maxX - minX);
        const height = Math.ceil(maxY - minY);
        
        if (width <= 0 || height <= 0) return;
        
        // Clamp to canvas bounds
        const clampedMinX = Math.max(0, Math.floor(minX));
        const clampedMinY = Math.max(0, Math.floor(minY));
        const clampedMaxX = Math.min(this.canvasWidth, Math.ceil(maxX));
        const clampedMaxY = Math.min(this.canvasHeight, Math.ceil(maxY));
        const clampedWidth = clampedMaxX - clampedMinX;
        const clampedHeight = clampedMaxY - clampedMinY;
        
        if (clampedWidth <= 0 || clampedHeight <= 0) return;
        
        // Create canvas for the selection
        const selectionCanvas = document.createElement('canvas');
        selectionCanvas.width = clampedWidth;
        selectionCanvas.height = clampedHeight;
        const selectionCtx = selectionCanvas.getContext('2d', { willReadFrequently: true });
        
        // Copy the bounding area
        const currentFrame = this.frames[this.currentFrameIndex];
        selectionCtx.drawImage(currentFrame, clampedMinX, clampedMinY, clampedWidth, clampedHeight, 0, 0, clampedWidth, clampedHeight);
        
        // Create mask for lasso area
        const maskCanvas = document.createElement('canvas');
        maskCanvas.width = clampedWidth;
        maskCanvas.height = clampedHeight;
        const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
        
        // Draw lasso path on mask (translated to local coordinates)
        maskCtx.beginPath();
        maskCtx.moveTo(lassoPoints[0].x - clampedMinX, lassoPoints[0].y - clampedMinY);
        for (let i = 1; i < lassoPoints.length; i++) {
            maskCtx.lineTo(lassoPoints[i].x - clampedMinX, lassoPoints[i].y - clampedMinY);
        }
        maskCtx.closePath();
        maskCtx.fillStyle = 'white';
        maskCtx.fill();
        
        // Apply mask to selection
        const selectionImageData = selectionCtx.getImageData(0, 0, clampedWidth, clampedHeight);
        const maskImageData = maskCtx.getImageData(0, 0, clampedWidth, clampedHeight);
        
        const selectionData = selectionImageData.data;
        const maskData = maskImageData.data;
        
        // Make pixels outside lasso transparent
        for (let i = 0; i < selectionData.length; i += 4) {
            if (maskData[i] === 0) { // Outside lasso
                selectionData[i + 3] = 0; // Set alpha to 0
            }
        }
        
        selectionCtx.putImageData(selectionImageData, 0, 0);
        
        this.clipboard = {
            data: selectionCanvas,
            isSelection: true,
            width: clampedWidth,
            height: clampedHeight
        };
    }
    
    cutLassoSelection() {
        const lassoPoints = this.selection.lassoPoints;
        if (!lassoPoints || lassoPoints.length < 3) return;
        
        // Calculate bounding rectangle of lasso
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const point of lassoPoints) {
            minX = Math.min(minX, point.x);
            minY = Math.min(minY, point.y);
            maxX = Math.max(maxX, point.x);
            maxY = Math.max(maxY, point.y);
        }
        
        const width = Math.ceil(maxX - minX);
        const height = Math.ceil(maxY - minY);
        
        if (width <= 0 || height <= 0) return;
        
        // Clamp to canvas bounds
        const clampedMinX = Math.max(0, Math.floor(minX));
        const clampedMinY = Math.max(0, Math.floor(minY));
        const clampedMaxX = Math.min(this.canvasWidth, Math.ceil(maxX));
        const clampedMaxY = Math.min(this.canvasHeight, Math.ceil(maxY));
        const clampedWidth = clampedMaxX - clampedMinX;
        const clampedHeight = clampedMaxY - clampedMinY;
        
        if (clampedWidth <= 0 || clampedHeight <= 0) return;
        
        // Create canvas for the selection
        const selectionCanvas = document.createElement('canvas');
        selectionCanvas.width = clampedWidth;
        selectionCanvas.height = clampedHeight;
        const selectionCtx = selectionCanvas.getContext('2d', { willReadFrequently: true });
        
        // Copy the bounding area
        const currentFrame = this.frames[this.currentFrameIndex];
        selectionCtx.drawImage(currentFrame, clampedMinX, clampedMinY, clampedWidth, clampedHeight, 0, 0, clampedWidth, clampedHeight);
        
        // Create mask for lasso area
        const maskCanvas = document.createElement('canvas');
        maskCanvas.width = clampedWidth;
        maskCanvas.height = clampedHeight;
        const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
        
        // Draw lasso path on mask (translated to local coordinates)
        maskCtx.beginPath();
        maskCtx.moveTo(lassoPoints[0].x - clampedMinX, lassoPoints[0].y - clampedMinY);
        for (let i = 1; i < lassoPoints.length; i++) {
            maskCtx.lineTo(lassoPoints[i].x - clampedMinX, lassoPoints[i].y - clampedMinY);
        }
        maskCtx.closePath();
        maskCtx.fillStyle = 'white';
        maskCtx.fill();
        
        // Apply mask to selection
        const selectionImageData = selectionCtx.getImageData(0, 0, clampedWidth, clampedHeight);
        const maskImageData = maskCtx.getImageData(0, 0, clampedWidth, clampedHeight);
        
        const selectionData = selectionImageData.data;
        const maskData = maskImageData.data;
        
        // Make pixels outside lasso transparent
        for (let i = 0; i < selectionData.length; i += 4) {
            if (maskData[i] === 0) { // Outside lasso
                selectionData[i + 3] = 0; // Set alpha to 0
            }
        }
        
        selectionCtx.putImageData(selectionImageData, 0, 0);
        
        // Set up clipboard for paste mode
        this.clipboard = {
            data: selectionCanvas,
            isSelection: true,
            width: clampedWidth,
            height: clampedHeight
        };
        
        // Clear the lasso area from the original canvas
        const ctx = this.getCurrentFrameContext();
        const originalImageData = ctx.getImageData(clampedMinX, clampedMinY, clampedWidth, clampedHeight);
        const originalData = originalImageData.data;
        
        // Clear pixels inside lasso area
        for (let i = 0; i < originalData.length; i += 4) {
            if (maskData[i] !== 0) { // Inside lasso
                originalData[i] = 0;     // R
                originalData[i + 1] = 0; // G
                originalData[i + 2] = 0; // B
                originalData[i + 3] = 0; // A
            }
        }
        
        ctx.putImageData(originalImageData, clampedMinX, clampedMinY);
        
        // Automatically enter paste mode
        this.setTool('select');
        this.isPasteModeActive = true;
        
        // Update paste mode button and show options
        const pasteModeBtn = document.getElementById('pasteModeBtn');
        const pasteModeOptions = document.getElementById('pasteModeOptions');
        
        pasteModeBtn.classList.add('active');
        pasteModeBtn.textContent = 'Exit Paste Mode';
        pasteModeOptions.style.display = 'block';
        pasteModeBtn.disabled = false;
        
        // Update edit button states
        this.updateEditButtonStates();
        
        // Clear selection since content was cut
        this.selection = null;
        this.drawSelectionOverlay();
        
        // Provide user feedback
        console.log('Lasso content cut and ready to paste. Click to place the cut content.');
    }
    
    setSelectionMode(mode) {
        this.selectionMode = mode;
        
        // Exit paste mode when changing selection mode
        if (this.isPasteModeActive) {
            this.isPasteModeActive = false;
            this.selection = null;
            this.drawSelectionOverlay();
        }
        
        // Update button states
        document.querySelectorAll('.mode-btn[data-mode]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });
        
        // Clear any existing selection when switching modes
        this.selection = null;
        this.drawSelectionOverlay();
        
        console.log(`Selection mode changed to: ${mode}`);
    }
    
    // Helper function to calculate mirror coordinates for pasting
    calculateMirrorCoordinates(x, y) {
        const mirrorCoords = [];
        console.log(`calculateMirrorCoordinates called for (${x}, ${y}) - H:${this.mirrorHorizontal}, V:${this.mirrorVertical}`);
        
        if (this.mirrorHorizontal && !this.mirrorVertical) {
            // Horizontal mirror only
            let mirrorX;
            if (this.canvasWidth % 2 === 0) {
                const centerLine = (this.canvasWidth / 2) - 0.5;
                mirrorX = Math.floor(2 * centerLine - x);
            } else {
                const centerPixel = Math.floor(this.canvasWidth / 2);
                mirrorX = 2 * centerPixel - x;
            }
            
            console.log(`Horizontal mirror: ${x} -> ${mirrorX} (canvas width: ${this.canvasWidth})`);
            
            if (mirrorX >= 0 && mirrorX < this.canvasWidth && mirrorX !== x) {
                mirrorCoords.push({ x: mirrorX, y: y });
            }
        }
        
        if (this.mirrorVertical && !this.mirrorHorizontal) {
            // Vertical mirror only
            let mirrorY;
            if (this.canvasHeight % 2 === 0) {
                const centerLine = (this.canvasHeight / 2) - 0.5;
                mirrorY = Math.floor(2 * centerLine - y);
            } else {
                const centerPixel = Math.floor(this.canvasHeight / 2);
                mirrorY = 2 * centerPixel - y;
            }
            
            if (mirrorY >= 0 && mirrorY < this.canvasHeight && mirrorY !== y) {
                mirrorCoords.push({ x: x, y: mirrorY });
            }
        }
        
        if (this.mirrorHorizontal && this.mirrorVertical) {
            // Both mirrors - calculate all three mirror positions
            let mirrorX, mirrorY;
            
            if (this.canvasWidth % 2 === 0) {
                const centerLine = (this.canvasWidth / 2) - 0.5;
                mirrorX = Math.floor(2 * centerLine - x);
            } else {
                const centerPixel = Math.floor(this.canvasWidth / 2);
                mirrorX = 2 * centerPixel - x;
            }
            
            if (this.canvasHeight % 2 === 0) {
                const centerLine = (this.canvasHeight / 2) - 0.5;
                mirrorY = Math.floor(2 * centerLine - y);
            } else {
                const centerPixel = Math.floor(this.canvasHeight / 2);
                mirrorY = 2 * centerPixel - y;
            }
            
            // Horizontal mirror
            if (mirrorX >= 0 && mirrorX < this.canvasWidth && mirrorX !== x) {
                mirrorCoords.push({ x: mirrorX, y: y });
            }
            
            // Vertical mirror
            if (mirrorY >= 0 && mirrorY < this.canvasHeight && mirrorY !== y) {
                mirrorCoords.push({ x: x, y: mirrorY });
            }
            
            // Diagonal mirror (both horizontal and vertical)
            if (mirrorX >= 0 && mirrorX < this.canvasWidth && mirrorY >= 0 && mirrorY < this.canvasHeight && 
                mirrorX !== x && mirrorY !== y) {
                mirrorCoords.push({ x: mirrorX, y: mirrorY });
            }
        }
        
        return mirrorCoords;
    }
    
    paste() {
        if (!this.clipboard) return;
        
        const ctx = this.getCurrentFrameContext();
        const pasteData = []; // Array to store pixel changes for undo
        
        if (this.clipboard.isSelection) {
            // Paste at selection location or center if no selection
            let pasteX = 0;
            let pasteY = 0;
            
            if (this.selection && this.selection.active) {
                const { startX, startY } = this.selection;
                pasteX = Math.min(startX, this.selection.endX);
                pasteY = Math.min(startY, this.selection.endY);
            }
            
            // Get the clipboard image data
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = this.clipboard.width;
            tempCanvas.height = this.clipboard.height;
            const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
            tempCtx.drawImage(this.clipboard.data, 0, 0);
            const clipboardImageData = tempCtx.getImageData(0, 0, this.clipboard.width, this.clipboard.height);
            const clipboardData = clipboardImageData.data;
            
            // Calculate actual paste area bounds (clamp to canvas)
            const startX = Math.max(0, pasteX);
            const startY = Math.max(0, pasteY);
            const endX = Math.min(this.canvasWidth, pasteX + this.clipboard.width);
            const endY = Math.min(this.canvasHeight, pasteY + this.clipboard.height);
            const actualWidth = endX - startX;
            const actualHeight = endY - startY;
            
            if (actualWidth > 0 && actualHeight > 0) {
                // Get current canvas data for the paste area to record old colors
                const currentImageData = ctx.getImageData(startX, startY, actualWidth, actualHeight);
                const currentData = currentImageData.data;
                
                // Process each pixel and record changes
                for (let py = 0; py < actualHeight; py++) {
                    for (let px = 0; px < actualWidth; px++) {
                        // Source pixel coordinates in clipboard
                        const srcX = px + (startX - pasteX);
                        const srcY = py + (startY - pasteY);
                        const srcIndex = (srcY * this.clipboard.width + srcX) * 4;
                        
                        // Destination pixel coordinates in current image
                        const dstIndex = (py * actualWidth + px) * 4;
                        
                        const r = clipboardData[srcIndex];
                        const g = clipboardData[srcIndex + 1];
                        const b = clipboardData[srcIndex + 2];
                        const a = clipboardData[srcIndex + 3];
                        
                        // Only paste non-transparent pixels
                        if (a > 0) {
                            const canvasX = startX + px;
                            const canvasY = startY + py;
                            
                            // Get old color for undo
                            const oldR = currentData[dstIndex];
                            const oldG = currentData[dstIndex + 1];
                            const oldB = currentData[dstIndex + 2];
                            const oldA = currentData[dstIndex + 3];
                            const oldColor = `rgba(${oldR}, ${oldG}, ${oldB}, ${oldA/255})`;
                            
                            // New color
                            const newColor = `rgba(${r}, ${g}, ${b}, ${a/255})`;
                            
                            // Record the change
                            pasteData.push({
                                x: canvasX,
                                y: canvasY,
                                oldColor: oldColor,
                                newColor: newColor
                            });
                            
                            // Handle mirroring for pasted pixels
                            if (this.mirrorHorizontal || this.mirrorVertical) {
                                console.log(`Mirroring paste at (${canvasX}, ${canvasY}) - H:${this.mirrorHorizontal}, V:${this.mirrorVertical}`);
                                const mirrorCoords = this.calculateMirrorCoordinates(canvasX, canvasY);
                                console.log(`Mirror coordinates:`, mirrorCoords);
                                
                                for (const mirrorCoord of mirrorCoords) {
                                    // Make sure mirror coordinates are within canvas bounds
                                    if (mirrorCoord.x >= 0 && mirrorCoord.x < this.canvasWidth && 
                                        mirrorCoord.y >= 0 && mirrorCoord.y < this.canvasHeight) {
                                        
                                        console.log(`Applying mirror at (${mirrorCoord.x}, ${mirrorCoord.y})`);
                                        
                                        // Get current pixel data at mirror location
                                        const mirrorImageData = ctx.getImageData(mirrorCoord.x, mirrorCoord.y, 1, 1);
                                        const mirrorData = mirrorImageData.data;
                                        const mirrorOldColor = `rgba(${mirrorData[0]}, ${mirrorData[1]}, ${mirrorData[2]}, ${mirrorData[3]/255})`;
                                        
                                        // Record the mirror change
                                        pasteData.push({
                                            x: mirrorCoord.x,
                                            y: mirrorCoord.y,
                                            oldColor: mirrorOldColor,
                                            newColor: newColor
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } else {
            // Paste entire frame - get all pixels
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = this.clipboard.width;
            tempCanvas.height = this.clipboard.height;
            const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
            tempCtx.drawImage(this.clipboard.data, 0, 0);
            const clipboardImageData = tempCtx.getImageData(0, 0, this.clipboard.width, this.clipboard.height);
            const clipboardData = clipboardImageData.data;
            
            // Get current canvas data
            const currentImageData = ctx.getImageData(0, 0, this.canvasWidth, this.canvasHeight);
            const currentData = currentImageData.data;
            
            // Process each pixel
            const width = Math.min(this.canvasWidth, this.clipboard.width);
            const height = Math.min(this.canvasHeight, this.clipboard.height);
            
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const index = (y * width + x) * 4;
                    
                    const r = clipboardData[index];
                    const g = clipboardData[index + 1];
                    const b = clipboardData[index + 2];
                    const a = clipboardData[index + 3];
                    
                    // Only paste non-transparent pixels
                    if (a > 0) {
                        // Get old color for undo
                        const oldR = currentData[index];
                        const oldG = currentData[index + 1];
                        const oldB = currentData[index + 2];
                        const oldA = currentData[index + 3];
                        const oldColor = `rgba(${oldR}, ${oldG}, ${oldB}, ${oldA/255})`;
                        
                        // New color
                        const newColor = `rgba(${r}, ${g}, ${b}, ${a/255})`;
                        
                        // Record the change
                        pasteData.push({
                            x: x,
                            y: y,
                            oldColor: oldColor,
                            newColor: newColor
                        });
                        
                        // Handle mirroring for pasted pixels
                        if (this.mirrorHorizontal || this.mirrorVertical) {
                            const mirrorCoords = this.calculateMirrorCoordinates(x, y);
                            
                            for (const mirrorCoord of mirrorCoords) {
                                // Make sure mirror coordinates are within canvas bounds
                                if (mirrorCoord.x >= 0 && mirrorCoord.x < this.canvasWidth && 
                                    mirrorCoord.y >= 0 && mirrorCoord.y < this.canvasHeight) {
                                    
                                    // Get current pixel data at mirror location
                                    const mirrorImageData = ctx.getImageData(mirrorCoord.x, mirrorCoord.y, 1, 1);
                                    const mirrorData = mirrorImageData.data;
                                    const mirrorOldColor = `rgba(${mirrorData[0]}, ${mirrorData[1]}, ${mirrorData[2]}, ${mirrorData[3]/255})`;
                                    
                                    // Record the mirror change
                                    pasteData.push({
                                        x: mirrorCoord.x,
                                        y: mirrorCoord.y,
                                        oldColor: mirrorOldColor,
                                        newColor: newColor
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
        
        // Only create command if there are actual changes
        if (pasteData.length > 0) {
            const command = new PasteCommand(this, pasteData, this.currentFrameIndex);
            this.executeCommand(command);
        }
    }
    
    cut() {
        // If already in paste mode, just exit it and return
        if (this.isPasteModeActive) {
            this.isPasteModeActive = false;
            const pasteModeBtn = document.getElementById('pasteModeBtn');
            const pasteModeOptions = document.getElementById('pasteModeOptions');
            pasteModeBtn.classList.remove('active');
            pasteModeBtn.textContent = 'Paste Mode';
            pasteModeOptions.style.display = 'none';
            this.clearPastePreview();
            this.pasteDragActive = false;
            return; // Exit without performing cut
        }
        
        if (!this.selection || !this.selection.active) return;
        
        if (this.selection.mode === 'lasso') {
            this.cutLassoSelection();
            return;
        }
        
        // Rectangle selection logic
        const { startX, startY, endX, endY } = this.selection;
        const minX = Math.min(startX, endX);
        const minY = Math.min(startY, endY);
        const width = Math.abs(endX - startX);
        const height = Math.abs(endY - startY);
        
        const ctx = this.getCurrentFrameContext();
        const imageData = ctx.getImageData(minX, minY, width, height);
        
        // Create a canvas to hold the cut content
        const cutCanvas = document.createElement('canvas');
        cutCanvas.width = width;
        cutCanvas.height = height;
        const cutCtx = cutCanvas.getContext('2d', { willReadFrequently: true });
        cutCtx.putImageData(imageData, 0, 0);
        
        // Set up clipboard for paste mode
        this.clipboard = {
            data: cutCanvas,
            isSelection: true,
            width: width,
            height: height
        };
        
        // Clear the original area immediately
        this.clearSelection();
        
        // Automatically enter paste mode
        this.setTool('select');
        this.isPasteModeActive = true;
        
        // Update paste mode button and show options
        const pasteModeBtn = document.getElementById('pasteModeBtn');
        const pasteModeOptions = document.getElementById('pasteModeOptions');
        
        pasteModeBtn.classList.add('active');
        pasteModeBtn.textContent = 'Exit Paste Mode';
        pasteModeOptions.style.display = 'block';
        pasteModeBtn.disabled = false;
        
        // Update edit button states
        this.updateEditButtonStates();
        
        // Clear selection since content was cut
        this.selection = null;
        this.drawSelectionOverlay();
        
        // Provide user feedback
        console.log('Content cut and ready to paste. Click to place the cut content.');
    }
    
    clear() {
        if (this.selection && this.selection.active) {
            this.clearSelection();
        } else {
            // Clear entire canvas with pixel tracking
            const ctx = this.getCurrentFrameContext();
            
            // Capture canvas state before clearing
            const beforeImageData = ctx.getImageData(0, 0, this.canvasWidth, this.canvasHeight);
            
            // Clear the canvas
            ctx.fillStyle = 'white';
            ctx.fillRect(0, 0, this.canvasWidth, this.canvasHeight);
            
            // Capture canvas state after clearing
            const afterImageData = ctx.getImageData(0, 0, this.canvasWidth, this.canvasHeight);
            
            // Find exactly which pixels changed
            const pixelData = this.compareImageData(beforeImageData, afterImageData);
            
            // Create and add clear command to undo system if pixels changed
            if (pixelData.length > 0) {
                const command = new ClearCanvasCommand(this, beforeImageData, this.currentFrameIndex);
                this.undoStack.push(command);
                this.redoStack = [];
                
                // Limit undo stack size
                if (this.undoStack.length > this.maxUndoStackSize) {
                    this.undoStack.shift();
                }
                
                // Mark as unsaved
                this.markAsUnsaved();
                this.updateUndoRedoUI();
            }
            
            this.redrawCanvas();
            this.generateThumbnail(this.currentFrameIndex);
            this.generateCode();
        }
        // No tool switching - just clear and stay on current tool
    }
    
    clearSelection() {
        if (!this.selection || !this.selection.active) return;
        
        const { startX, startY, endX, endY } = this.selection;
        const minX = Math.min(startX, endX);
        const minY = Math.min(startY, endY);
        const width = Math.abs(endX - startX);
        const height = Math.abs(endY - startY);
        
        const ctx = this.getCurrentFrameContext();
        ctx.fillStyle = 'white';
        ctx.fillRect(minX, minY, width, height);
        
        this.redrawCanvas();
        this.drawSelectionOverlay(); // Update selection overlay
        this.generateThumbnail(this.currentFrameIndex);
        this.generateCode();
    }

    togglePasteMode() {
        if (!this.clipboard) {
            alert('No content to paste. Copy or cut something first.');
            return;
        }
        
        // Switch to select tool if not already
        if (this.currentTool !== 'select') {
            this.setTool('select');
        }
        
        // Toggle paste mode
        this.isPasteModeActive = !this.isPasteModeActive;
        
        // Update button appearance and options visibility
        const pasteModeBtn = document.getElementById('pasteModeBtn');
        const pasteModeOptions = document.getElementById('pasteModeOptions');
        
        if (this.isPasteModeActive) {
            pasteModeBtn.classList.add('active');
            pasteModeBtn.textContent = 'Exit Paste Mode';
            pasteModeOptions.style.display = 'block';
        } else {
            pasteModeBtn.classList.remove('active');
            pasteModeBtn.textContent = 'Paste Mode';
            pasteModeOptions.style.display = 'none';
            this.clearPastePreview();
            // Reset drag state when exiting paste mode
            this.pasteDragActive = false;
        }
        
        // Clear any existing selection when entering paste mode
        if (this.isPasteModeActive && this.selection) {
            this.selection.active = false;
            this.redrawCanvas();
        }
    }
    
    clearPastePreview() {
        // Clear any paste preview from overlay
        this.overlayCtx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
        this.drawBaseOverlays();
    }
    
    togglePerfectShapeMode() {
        this.perfectShapeMode = !this.perfectShapeMode;
        
        const toggleBtn = document.getElementById('perfectShapeToggle');
        const statusSpan = document.getElementById('perfectShapeStatus');
        const iconSpan = document.getElementById('perfectShapeIcon');
        
        if (this.perfectShapeMode) {
            toggleBtn.classList.add('active');
            statusSpan.textContent = 'ON';
            iconSpan.textContent = '⭕';
        } else {
            toggleBtn.classList.remove('active');
            statusSpan.textContent = 'OFF';
            iconSpan.textContent = '🔲';
        }
    }
    
    pasteAtPosition(x, y) {
        if (!this.clipboard) return;
        
        // Capture state before pasting
        this.captureSnapshot();
        
        // Calculate paste position (center the clipboard content at click position)
        const pasteX = Math.floor(x - this.clipboard.width / 2);
        const pasteY = Math.floor(y - this.clipboard.height / 2);
        
        const ctx = this.getCurrentFrameContext();
        
        // Calculate actual paste area bounds (clamp to canvas)
        const startX = Math.max(0, pasteX);
        const startY = Math.max(0, pasteY);
        const endX = Math.min(this.canvasWidth, pasteX + this.clipboard.width);
        const endY = Math.min(this.canvasHeight, pasteY + this.clipboard.height);
        const actualWidth = endX - startX;
        const actualHeight = endY - startY;
        
        if (actualWidth <= 0 || actualHeight <= 0) return; // Nothing to paste
        
        // Get clipboard image data
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = this.clipboard.width;
        tempCanvas.height = this.clipboard.height;
        const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
        tempCtx.drawImage(this.clipboard.data, 0, 0);
        const clipboardImageData = tempCtx.getImageData(0, 0, this.clipboard.width, this.clipboard.height);
        const clipboardData = clipboardImageData.data;
        
        // Get current canvas data for the paste area
        const currentImageData = ctx.getImageData(startX, startY, actualWidth, actualHeight);
        const currentData = currentImageData.data;
        
        // Track if any pixels were actually pasted
        let pixelsPasted = false;
        
        // Collect all pixels to paste (including mirrors) before making any changes
        const allPixelsToPaste = []; // Array of {x, y, r, g, b, a}
        
        // Process each pixel
        for (let py = 0; py < actualHeight; py++) {
            for (let px = 0; px < actualWidth; px++) {
                // Source pixel coordinates in clipboard
                const srcX = px + (startX - pasteX);
                const srcY = py + (startY - pasteY);
                const srcIndex = (srcY * this.clipboard.width + srcX) * 4;
                
                const r = clipboardData[srcIndex];
                const g = clipboardData[srcIndex + 1];
                const b = clipboardData[srcIndex + 2];
                const a = clipboardData[srcIndex + 3];
                
                // Check if pixel is white or black
                const isWhite = r >= 240 && g >= 240 && b >= 240;
                const isBlack = r <= 15 && g <= 15 && b <= 15;
                
                // Determine if we should paste this pixel
                let pastePixel = true;
                
                if (this.pasteTransparencyMode === 'white' && isWhite) {
                    pastePixel = false;
                }
                if (this.pasteTransparencyMode === 'black' && isBlack) {
                    pastePixel = false;
                }
                
                // Only paste non-transparent pixels that aren't being ignored
                if (a > 0 && pastePixel) {
                    const canvasX = startX + px;
                    const canvasY = startY + py;
                    
                    // Add original pixel
                    allPixelsToPaste.push({
                        x: canvasX,
                        y: canvasY,
                        r: r,
                        g: g,
                        b: b,
                        a: a
                    });
                    
                    // Handle mirroring for pasted pixels
                    if (this.mirrorHorizontal || this.mirrorVertical) {
                        const mirrorCoords = this.calculateMirrorCoordinates(canvasX, canvasY);
                        
                        for (const mirrorCoord of mirrorCoords) {
                            // Make sure mirror coordinates are within canvas bounds
                            if (mirrorCoord.x >= 0 && mirrorCoord.x < this.canvasWidth && 
                                mirrorCoord.y >= 0 && mirrorCoord.y < this.canvasHeight) {
                                
                                // Add mirror pixel
                                allPixelsToPaste.push({
                                    x: mirrorCoord.x,
                                    y: mirrorCoord.y,
                                    r: r,
                                    g: g,
                                    b: b,
                                    a: a
                                });
                            }
                        }
                    }
                }
            }
        }
        
        // Now paste all pixels at once
        if (allPixelsToPaste.length > 0) {
            for (const pixel of allPixelsToPaste) {
                ctx.fillStyle = `rgba(${pixel.r}, ${pixel.g}, ${pixel.b}, ${pixel.a/255})`;
                ctx.fillRect(pixel.x, pixel.y, 1, 1);
            }
            pixelsPasted = true;
        }
        
        // Only update canvas and push undo if pixels were actually pasted
        if (pixelsPasted) {
            // Push undo state
            this.pushUndo();
            
            // Update display
            this.redrawCanvas();
            this.generateThumbnail(this.currentFrameIndex);
            this.generateCode();
        }
        
        // Keep paste mode active - don't exit automatically
        // User needs to click "Exit Paste Mode" to turn it off
        this.clearPastePreview();
    }
    
    newDrawing() {
        if (confirm('Create a new drawing? This will clear your current work.')) {
            // Reset to single frame
            this.frames = [this.createEmptyFrame()];
            this.currentFrameIndex = 0;
            
            // Reset layers to single layer if layers are enabled
            if (this.layersEnabled) {
                this.frameLayers = {};
                this.initializeLayersForFrame(0);
                this.updateLayersUI();
            }
            
            // Clear undo/redo stacks for fresh start
            this.undoStack = [];
            this.redoStack = [];
            this.updateUndoRedoUI();
            
            this.updateUI();
            this.redrawCanvas();
            this.generateCode();
        }
    }
    
    save() {
        const data = {
            width: this.canvasWidth,
            height: this.canvasHeight,
            frames: this.frames.map(frame => frame.toDataURL()),
            layersEnabled: this.layersEnabled
        };
        
        // Save layer data if layers are being used
        if (this.frameLayers && Object.keys(this.frameLayers).length > 0) {
            data.layers = {};
            Object.keys(this.frameLayers).forEach(frameIndex => {
                const frameData = this.frameLayers[frameIndex];
                data.layers[frameIndex] = {
                    currentLayerIndex: frameData.currentLayerIndex,
                    layers: frameData.layers.map(layer => ({
                        canvas: layer.canvas.toDataURL(),
                        visible: layer.visible,
                        name: layer.name
                    }))
                };
            });
        }
        
        const assetName = document.getElementById('assetName').value || 'my_image';
        const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${assetName}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        // Mark as saved after successful save
        this.markAsSaved();
        
        // Reset save reminder timer and hide banner
        this.resetSaveReminderTimer();
    }
    
    load() {
        document.getElementById('fileInput').click();
        document.getElementById('fileInput').onchange = (e) => {
            const file = e.target.files[0];
            if (file) {
                const fileName = file.name.toLowerCase();
                const reader = new FileReader();
                
                if (fileName.endsWith('.json')) {
                    // Handle JSON files
                    reader.onload = (event) => {
                        try {
                            const data = JSON.parse(event.target.result);
                            this.loadFromData(data);
                            // Reset file input so same file can be loaded again
                            e.target.value = '';
                        } catch (err) {
                            alert('Error loading JSON file: ' + err.message);
                            e.target.value = '';
                        }
                    };
                    reader.readAsText(file);
                } else if (fileName.endsWith('.hpp')) {
                    // Handle HPP files
                    reader.onload = (event) => {
                        try {
                            const hppContent = event.target.result;
                            this.loadFromHPP(hppContent);
                            // Reset file input so same file can be loaded again
                            e.target.value = '';
                        } catch (err) {
                            alert('Error loading HPP file: ' + err.message);
                            e.target.value = '';
                        }
                    };
                    reader.readAsText(file);
                } else {
                    alert('Unsupported file type. Please select a .json or .hpp file.');
                    e.target.value = '';
                }
            }
        };
    }
    
    loadFromData(data) {
        this.setCanvasSize(data.width, data.height);
        this.frames = [];
        this.currentFrameIndex = 0;
        
        const loadPromises = data.frames.map(dataUrl => {
            return new Promise(resolve => {
                const img = new Image();
                img.onload = () => {
                    const canvas = this.createEmptyFrame();
                    const ctx = canvas.getContext('2d', { willReadFrequently: true });
                    ctx.drawImage(img, 0, 0);
                    resolve(canvas);
                };
                img.src = dataUrl;
            });
        });
        
        Promise.all(loadPromises).then(frames => {
            this.frames = frames;
            
            // Restore layer data if it exists
            if (data.layers) {
                this.frameLayers = {};
                
                const layerLoadPromises = [];
                
                Object.keys(data.layers).forEach(frameIndex => {
                    const savedFrameData = data.layers[frameIndex];
                    
                    // Create frame layer structure
                    this.frameLayers[frameIndex] = {
                        currentLayerIndex: savedFrameData.currentLayerIndex,
                        layers: []
                    };
                    
                    // Load each layer
                    savedFrameData.layers.forEach((layerData, layerIndex) => {
                        const promise = new Promise(resolve => {
                            const img = new Image();
                            img.onload = () => {
                                const layerCanvas = document.createElement('canvas');
                                layerCanvas.width = this.canvasWidth;
                                layerCanvas.height = this.canvasHeight;
                                const layerCtx = layerCanvas.getContext('2d', { willReadFrequently: true });
                                layerCtx.drawImage(img, 0, 0);
                                
                                this.frameLayers[frameIndex].layers[layerIndex] = {
                                    canvas: layerCanvas,
                                    visible: layerData.visible !== undefined ? layerData.visible : true,
                                    name: layerData.name || `${layerIndex + 1}`
                                };
                                resolve();
                            };
                            img.src = layerData.canvas;
                        });
                        layerLoadPromises.push(promise);
                    });
                });
                
                // Wait for all layers to load, then update UI
                Promise.all(layerLoadPromises).then(() => {
                    // Auto-enable layers if layer data exists
                    // Use saved state if available, otherwise default to true since layers exist
                    const shouldEnableLayers = data.layersEnabled !== undefined ? data.layersEnabled : true;
                    
                    this.layersEnabled = shouldEnableLayers;
                    document.getElementById('layersEnabled').checked = shouldEnableLayers;
                    
                    if (shouldEnableLayers) {
                        const layersPanel = document.getElementById('layersPanel');
                        layersPanel.style.display = 'flex';
                        
                        const canvasArea = document.querySelector('.canvas-area');
                        const mobileToolbar = document.querySelector('.mobile-bottom-toolbar');
                        const toolsPanel = document.querySelector('.tools-panel');
                        const exportPanel = document.querySelector('.export-panel');
                        
                        if (canvasArea) canvasArea.classList.add('with-layers');
                        if (mobileToolbar) mobileToolbar.classList.add('with-layers');
                        if (toolsPanel) toolsPanel.classList.add('with-layers');
                        if (exportPanel) exportPanel.classList.add('with-layers');
                        
                        this.updateLayersUI();
                    }
                    
                    this.updateUI();
                    this.redrawCanvas();
                    this.generateCode();
                });
            } else {
                // No layer data, just update normally
                this.updateUI();
                this.redrawCanvas();
                this.generateCode();
            }
        });
    }
    
    loadFromHPP(hppContent) {
        try {
            // Parse HPP file to extract 1-bit packed pixel data
            const lines = hppContent.split('\n');
            let width = 0;
            let height = 0;
            let frameCount = 0;
            let layerCount = 0;
            let allFrameData = []; // Array of arrays, one for each frame
            let allLayerData = []; // Array of objects for layers {name, data}
            let currentPixelData = [];
            let inDataArray = false;
            let dataArrayName = '';
            let currentLayerName = '';
            let isLayerFile = false;
            let isAnimationFile = false;
            let isFramesWithLayers = false;
            let detectedFormat = null; // Will be 'SINGLE_FRAME', 'ANIMATION', 'LAYERS', or 'FRAMES_WITH_LAYERS'
            let frameLayersData = {}; // For FRAMES_WITH_LAYERS format: {frameIndex: [{name, data}, ...]}
            let currentFrameIndex = 0; // Track current frame being parsed
            let currentLayerIndex = 0; // Track current layer being parsed
            
            console.log('HPP Content preview:', hppContent.substring(0, 500));
            
            // First pass: detect format from KYWY_FORMAT comment
            for (const line of lines) {
                const formatMatch = line.match(/\/\/\s*KYWY_FORMAT:\s*(\w+)/);
                if (formatMatch) {
                    detectedFormat = formatMatch[1];
                    console.log('Detected format from header:', detectedFormat);
                    if (detectedFormat === 'LAYERS') {
                        isLayerFile = true;
                    } else if (detectedFormat === 'ANIMATION') {
                        isAnimationFile = true;
                    } else if (detectedFormat === 'FRAMES_WITH_LAYERS') {
                        isFramesWithLayers = true;
                        isLayerFile = true; // Still a layer file, but with multiple frames
                    }
                    break; // Format found, no need to continue
                }
            }
            
            // Find width, height, frame count, and layer count
            for (const line of lines) {
                // Try to find dimensions in comments first
                const commentMatch = line.match(/\/\/.*?(\d+)x(\d+)/);
                if (commentMatch && !width && !height) {
                    width = parseInt(commentMatch[1]);
                    height = parseInt(commentMatch[2]);
                    console.log('Found dimensions in comment:', width, 'x', height);
                }
                
                // Check for #define statements
                const widthMatch = line.match(/#define\s+\w+WIDTH\s+(\d+)/);
                if (widthMatch) {
                    width = parseInt(widthMatch[1]);
                    console.log('Found width:', width);
                }
                
                const heightMatch = line.match(/#define\s+\w+HEIGHT\s+(\d+)/);
                if (heightMatch) {
                    height = parseInt(heightMatch[1]);
                    console.log('Found height:', height);
                }
                
                const frameCountMatch = line.match(/#define\s+\w+FRAME_COUNT\s+(\d+)/);
                if (frameCountMatch) {
                    frameCount = parseInt(frameCountMatch[1]);
                    console.log('Found frame count:', frameCount);
                }
                
                const layerCountMatch = line.match(/#define\s+\w+LAYER_COUNT\s+(\d+)/);
                if (layerCountMatch) {
                    layerCount = parseInt(layerCountMatch[1]);
                    isLayerFile = true;
                    console.log('Found layer count:', layerCount);
                }
                
                // Look for layer name comments (must come before array declaration)
                const layerCommentMatch = line.match(/\/\/\s*Layer\s+(\d+):\s*(.+)/);
                if (layerCommentMatch) {
                    currentLayerName = layerCommentMatch[2].trim();
                    console.log('Found layer name:', currentLayerName);
                }
                
                // Look for data array start (uint8_t array)
                const arrayMatch = line.match(/uint8_t\s+(\w+)\[\d*\]\s*=\s*{/);
                if (arrayMatch) {
                    dataArrayName = arrayMatch[1];
                    console.log('Found data array:', dataArrayName);
                    
                    // Determine if this is a layer array or animation frame array
                    // Use format header if available, otherwise fall back to name detection
                    let isLayerArray = false;
                    let isAnimFrame = false;
                    
                    if (detectedFormat === 'FRAMES_WITH_LAYERS') {
                        // Parse frame and layer indices from name like: asset_frame0_layer1
                        const frameLayerMatch = dataArrayName.match(/_frame(\d+)_layer(\d+)/);
                        if (frameLayerMatch) {
                            isLayerArray = true;
                            currentFrameIndex = parseInt(frameLayerMatch[1]);
                            currentLayerIndex = parseInt(frameLayerMatch[2]);
                        }
                    } else if (detectedFormat === 'LAYERS') {
                        isLayerArray = true;
                    } else if (detectedFormat === 'ANIMATION') {
                        isAnimFrame = true;
                    } else {
                        // Fallback: detect from array name
                        // Match both _layer_ and _layer0, _layer1, etc., or _frame0_layer0
                        const frameLayerMatch = dataArrayName.match(/_frame(\d+)_layer(\d+)/);
                        if (frameLayerMatch) {
                            isLayerArray = true;
                            isFramesWithLayers = true;
                            isLayerFile = true;
                            currentFrameIndex = parseInt(frameLayerMatch[1]);
                            currentLayerIndex = parseInt(frameLayerMatch[2]);
                        } else {
                            isLayerArray = dataArrayName.includes('_layer_') || /_layer\d+/.test(dataArrayName);
                            isAnimFrame = dataArrayName.includes('_anim_frame_') || dataArrayName.includes('_frame_');
                        }
                    }
                    
                    // Save previous data if exists
                    if (inDataArray && currentPixelData.length > 0) {
                        if (isFramesWithLayers) {
                            // Store in frameLayersData structure
                            if (!frameLayersData[currentFrameIndex]) {
                                frameLayersData[currentFrameIndex] = [];
                            }
                            frameLayersData[currentFrameIndex].push({
                                name: currentLayerName || `${currentLayerIndex}`,
                                data: [...currentPixelData],
                                layerIndex: currentLayerIndex
                            });
                        } else if (isLayerFile) {
                            allLayerData.push({
                                name: currentLayerName || `${allLayerData.length}`,
                                data: [...currentPixelData]
                            });
                        } else {
                            allFrameData.push([...currentPixelData]);
                        }
                        currentPixelData = [];
                    }
                    
                    inDataArray = true;
                    // Check if data is on the same line
                    const dataOnSameLine = line.substring(line.indexOf('{') + 1);
                    if (dataOnSameLine.trim()) {
                        currentPixelData.push(...this.parseHPPDataLine(dataOnSameLine));
                    }
                    continue;
                }
                
                // Parse data lines
                if (inDataArray) {
                    if (line.includes('}')) {
                        // End of array
                        const lastData = line.substring(0, line.indexOf('}'));
                        if (lastData.trim()) {
                            currentPixelData.push(...this.parseHPPDataLine(lastData));
                        }
                        console.log('Finished parsing data array, total bytes:', currentPixelData.length);
                        
                        // Route to correct storage based on detected format or array name
                        if (isFramesWithLayers) {
                            // Store in frameLayersData structure
                            if (!frameLayersData[currentFrameIndex]) {
                                frameLayersData[currentFrameIndex] = [];
                            }
                            frameLayersData[currentFrameIndex].push({
                                name: currentLayerName || `${currentLayerIndex}`,
                                data: [...currentPixelData],
                                layerIndex: currentLayerIndex
                            });
                        } else if (detectedFormat === 'LAYERS' || (detectedFormat === null && (dataArrayName.includes('_layer_') || /_layer\d+/.test(dataArrayName)))) {
                            allLayerData.push({
                                name: currentLayerName || `${allLayerData.length}`,
                                data: [...currentPixelData]
                            });
                        } else {
                            // Animation frames or single frame
                            allFrameData.push([...currentPixelData]);
                        }
                        
                        currentPixelData = [];
                        currentLayerName = '';
                        inDataArray = false;
                    } else {
                        const lineData = this.parseHPPDataLine(line);
                        if (lineData.length > 0) {
                            currentPixelData.push(...lineData);
                        }
                    }
                }
            }
            
            console.log('Parse results - Width:', width, 'Height:', height, 'Frames:', allFrameData.length, 'Layers:', allLayerData.length, 'Frames with layers:', Object.keys(frameLayersData).length);
            
            if (width && height && (allFrameData.length > 0 || allLayerData.length > 0 || Object.keys(frameLayersData).length > 0)) {
                // Convert 1-bit packed data to canvas frames
                this.setCanvasSize(width, height);
                this.frames = [];
                this.currentFrameIndex = 0;
                
                if (isFramesWithLayers && Object.keys(frameLayersData).length > 0) {
                    // Load multiple frames, each with layers
                    console.log('Loading as multi-frame layered file with', Object.keys(frameLayersData).length, 'frames');
                    
                    this.frameLayers = {};
                    
                    // Sort frame indices
                    const frameIndices = Object.keys(frameLayersData).map(Number).sort((a, b) => a - b);
                    
                    frameIndices.forEach((frameIdx, arrayIdx) => {
                        const frameCanvas = this.createEmptyFrame();
                        this.frames.push(frameCanvas);
                        
                        // Initialize layers for this frame
                        this.frameLayers[arrayIdx] = {
                            currentLayerIndex: 0,
                            layers: []
                        };
                        
                        // Sort layers by layerIndex
                        const frameLayers = frameLayersData[frameIdx].sort((a, b) => a.layerIndex - b.layerIndex);
                        
                        // Convert each layer data to canvas
                        frameLayers.forEach((layerInfo) => {
                            const layerCanvas = document.createElement('canvas');
                            layerCanvas.width = width;
                            layerCanvas.height = height;
                            const ctx = layerCanvas.getContext('2d', { willReadFrequently: true });
                            const imageData = ctx.createImageData(width, height);
                            const data = imageData.data;
                            
                            // Convert packed bits to RGBA pixels
                            const totalPixels = width * height;
                            for (let pixelIndex = 0; pixelIndex < totalPixels; pixelIndex++) {
                                const byteIndex = Math.floor(pixelIndex / 8);
                                const bitIndex = 7 - (pixelIndex % 8); // MSB first
                                
                                if (byteIndex < layerInfo.data.length) {
                                    const byte = layerInfo.data[byteIndex];
                                    const bitValue = (byte >> bitIndex) & 1;
                                    // Bit = 1 means WHITE, bit = 0 means BLACK
                                    const isWhite = bitValue === 1;
                                    
                                    const dataIndex = pixelIndex * 4;
                                    
                                    if (isWhite) {
                                        data[dataIndex] = 255;     // R
                                        data[dataIndex + 1] = 255; // G
                                        data[dataIndex + 2] = 255; // B
                                        data[dataIndex + 3] = 255; // A
                                    } else {
                                        data[dataIndex] = 0;       // R
                                        data[dataIndex + 1] = 0;   // G
                                        data[dataIndex + 2] = 0;   // B
                                        data[dataIndex + 3] = 255; // A
                                    }
                                }
                            }
                            
                            ctx.putImageData(imageData, 0, 0);
                            
                            // Add layer to frame
                            this.frameLayers[arrayIdx].layers.push({
                                canvas: layerCanvas,
                                visible: true,
                                name: layerInfo.name
                            });
                        });
                        
                        // Composite this frame's layers
                        this.compositeLayersToFrame(arrayIdx);
                    });
                    
                    // Enable layers mode
                    this.layersEnabled = true;
                    document.getElementById('layersEnabled').checked = true;
                    
                    const layersPanel = document.getElementById('layersPanel');
                    layersPanel.style.display = 'flex';
                    
                    const canvasArea = document.querySelector('.canvas-area');
                    const mobileToolbar = document.querySelector('.mobile-bottom-toolbar');
                    const toolsPanel = document.querySelector('.tools-panel');
                    const exportPanel = document.querySelector('.export-panel');
                    
                    if (canvasArea) canvasArea.classList.add('with-layers');
                    if (mobileToolbar) mobileToolbar.classList.add('with-layers');
                    if (toolsPanel) toolsPanel.classList.add('with-layers');
                    if (exportPanel) exportPanel.classList.add('with-layers');
                    
                    this.updateLayersUI();
                    
                    console.log('Loaded', frameIndices.length, 'frames with layers');
                    
                } else if (isLayerFile && allLayerData.length > 0) {
                    // Load as layers
                    console.log('Loading as layered file with', allLayerData.length, 'layers');
                    
                    // Create a single frame
                    const frameCanvas = this.createEmptyFrame();
                    this.frames.push(frameCanvas);
                    
                    // Initialize layers for this frame
                    this.frameLayers = {};
                    this.frameLayers[0] = {
                        currentLayerIndex: 0,
                        layers: []
                    };
                    
                    // Convert each layer data to canvas
                    allLayerData.forEach((layerInfo, layerIndex) => {
                        const layerCanvas = document.createElement('canvas');
                        layerCanvas.width = width;
                        layerCanvas.height = height;
                        const ctx = layerCanvas.getContext('2d', { willReadFrequently: true });
                        const imageData = ctx.createImageData(width, height);
                        const data = imageData.data;
                        
                        // Convert packed bits to RGBA pixels
                        const totalPixels = width * height;
                        for (let pixelIndex = 0; pixelIndex < totalPixels; pixelIndex++) {
                            const byteIndex = Math.floor(pixelIndex / 8);
                            const bitIndex = 7 - (pixelIndex % 8); // MSB first
                            
                            if (byteIndex < layerInfo.data.length) {
                                const byte = layerInfo.data[byteIndex];
                                const bitValue = (byte >> bitIndex) & 1;
                                // Bit = 1 means WHITE, bit = 0 means BLACK
                                const isWhite = bitValue === 1;
                                
                                const dataIndex = pixelIndex * 4;
                                
                                if (isWhite) {
                                    // White pixel
                                    data[dataIndex] = 255;     // R
                                    data[dataIndex + 1] = 255; // G
                                    data[dataIndex + 2] = 255; // B
                                    data[dataIndex + 3] = 255; // A (fully opaque)
                                } else {
                                    // Black pixel - fully opaque
                                    data[dataIndex] = 0;       // R
                                    data[dataIndex + 1] = 0;   // G
                                    data[dataIndex + 2] = 0;   // B
                                    data[dataIndex + 3] = 255; // A (fully opaque)
                                }
                            }
                        }
                        
                        ctx.putImageData(imageData, 0, 0);
                        
                        // Add layer to frame
                        this.frameLayers[0].layers.push({
                            canvas: layerCanvas,
                            visible: true,
                            name: layerInfo.name
                        });
                    });
                    
                    // Enable layers mode
                    this.layersEnabled = true;
                    document.getElementById('layersEnabled').checked = true;
                    
                    const layersPanel = document.getElementById('layersPanel');
                    layersPanel.style.display = 'flex';
                    
                    const canvasArea = document.querySelector('.canvas-area');
                    const mobileToolbar = document.querySelector('.mobile-bottom-toolbar');
                    const toolsPanel = document.querySelector('.tools-panel');
                    const exportPanel = document.querySelector('.export-panel');
                    
                    if (canvasArea) canvasArea.classList.add('with-layers');
                    if (mobileToolbar) mobileToolbar.classList.add('with-layers');
                    if (toolsPanel) toolsPanel.classList.add('with-layers');
                    if (exportPanel) exportPanel.classList.add('with-layers');
                    
                    this.updateLayersUI();
                    
                    // Composite layers to frame
                    this.compositeLayersToFrame(0);
                    
                    console.log('Loaded', allLayerData.length, 'layers');
                } else {
                    // Load as frames (existing behavior)
                    allFrameData.forEach((pixelData, frameIndex) => {
                        const frameCanvas = this.createEmptyFrame();
                        const ctx = frameCanvas.getContext('2d', { willReadFrequently: true });
                        const imageData = ctx.createImageData(width, height);
                        const data = imageData.data;
                        
                        // Convert packed bits to RGBA pixels
                        const totalPixels = width * height;
                        for (let pixelIndex = 0; pixelIndex < totalPixels; pixelIndex++) {
                            const byteIndex = Math.floor(pixelIndex / 8);
                            const bitIndex = 7 - (pixelIndex % 8); // MSB first
                            
                            if (byteIndex < pixelData.length) {
                                const byte = pixelData[byteIndex];
                                const bitValue = (byte >> bitIndex) & 1;
                                // Bit = 1 means WHITE, bit = 0 means BLACK
                                const isWhite = bitValue === 1;
                                
                                const dataIndex = pixelIndex * 4;
                                const colorValue = isWhite ? 255 : 0; // White or black
                                
                                data[dataIndex] = colorValue;     // R
                                data[dataIndex + 1] = colorValue; // G
                                data[dataIndex + 2] = colorValue; // B
                                data[dataIndex + 3] = 255;        // A (fully opaque)
                            }
                        }
                        
                        ctx.putImageData(imageData, 0, 0);
                        this.frames.push(frameCanvas);
                    });
                    
                    console.log('Loaded', this.frames.length, 'frames');
                    
                    // If multiple frames were loaded, set export format to animation
                    if (this.frames.length > 1) {
                        const exportFormatSelect = document.getElementById('exportFormat');
                        if (exportFormatSelect) {
                            exportFormatSelect.value = 'animation';
                        }
                    }
                }
                
                this.updateUI();
                this.redrawCanvas();
                this.generateCode();
                
                // Update frame thumbnails
                this.frames.forEach((frame, index) => {
                    this.generateThumbnail(index);
                });
            } else {
                throw new Error('Invalid HPP file format or missing data');
            }
        } catch (err) {
            alert('Error parsing HPP file: ' + err.message);
            console.error('HPP parsing error:', err);
        }
    }
    
    parseHPPDataLine(line) {
        // Parse a line of 8-bit hex values for packed bitmap data
        const cleanLine = line.replace(/\/\*.*?\*\//g, '') // Remove /* */ comments
                              .replace(/\/\/.*$/, '')      // Remove // comments
                              .trim();
        
        const hexPattern = /0x([0-9a-fA-F]+)/g;
        const values = [];
        let match;
        
        while ((match = hexPattern.exec(cleanLine)) !== null) {
            const hexValue = parseInt(match[1], 16);
            // Ensure it's a valid 8-bit value
            if (hexValue >= 0 && hexValue <= 255) {
                values.push(hexValue);
            }
        }
        
        return values;
    }
    
    export() {
        const format = document.getElementById('exportFormat').value;
        
        switch (format) {
            case 'hpp':
            case 'animation':
            case 'layers':
                this.downloadCode();
                break;
            case 'png':
                this.exportPNG();
                break;
        }
    }
    
    downloadCode() {
        const code = document.getElementById('codeOutput').value;
        const assetName = document.getElementById('assetName').value || 'my_image';
        const blob = new Blob([code], {type: 'text/plain'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${assetName}.hpp`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
    
    exportPNG() {
        const canvas = this.frames[this.currentFrameIndex];
        const assetName = document.getElementById('assetName').value || 'my_image';
        const url = canvas.toDataURL('image/png');
        const a = document.createElement('a');
        a.href = url;
        a.download = `${assetName}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }
    
    exportGIF() {
        if (this.frames.length === 1) {
            alert('Only one frame detected. Use PNG export for single frame images.');
            return;
        }
        
        // Check if GIF library is loaded
        if (typeof GIF === 'undefined') {
            alert('GIF library not loaded. Please check your internet connection and reload the page.');
            return;
        }
        
        // Show progress message
        const originalText = document.getElementById('exportBtn').textContent;
        document.getElementById('exportBtn').textContent = '⏳ Creating GIF...';
        document.getElementById('exportBtn').disabled = true;
        
        // Create a temporary canvas for rendering frames
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = this.canvasWidth;
        tempCanvas.height = this.canvasHeight;
        const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
        tempCtx.imageSmoothingEnabled = false;
        
        // Get frame rate and calculate delay
        const frameRate = parseInt(document.getElementById('frameRate').value);
        const delay = Math.round(1000 / frameRate); // Convert FPS to milliseconds
        
        // Initialize GIF encoder with local worker script
        const gif = new GIF({
            workers: 2,
            quality: 10,
            width: this.canvasWidth,
            height: this.canvasHeight,
            workerScript: 'gif.worker.js'
        });
        
        // Add each frame to the GIF
        for (let i = 0; i < this.frames.length; i++) {
            // Clear and set white background
            tempCtx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
            tempCtx.fillStyle = 'white';
            tempCtx.fillRect(0, 0, this.canvasWidth, this.canvasHeight);
            
            // If layers are enabled, composite them for this frame
            if (this.layersEnabled && this.frameLayers[i]) {
                const frameData = this.frameLayers[i];
                frameData.layers.forEach(layer => {
                    if (layer.visible) {
                        tempCtx.drawImage(layer.canvas, 0, 0);
                    }
                });
            } else {
                // Draw the frame canvas directly
                tempCtx.drawImage(this.frames[i], 0, 0);
            }
            
            // Add frame to GIF with delay
            gif.addFrame(tempCanvas, { copy: true, delay: delay });
        }
        
        // Handle GIF completion
        gif.on('finished', (blob) => {
            // Download the GIF
            const assetName = document.getElementById('assetName').value || 'my_animation';
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${assetName}.gif`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            // Reset button
            document.getElementById('exportBtn').textContent = originalText;
            document.getElementById('exportBtn').disabled = false;
            
            alert(`GIF exported successfully! (${this.frames.length} frames at ${frameRate} FPS)`);
        });
        
        // Handle errors
        gif.on('error', (error) => {
            console.error('GIF encoding error:', error);
            alert('Error creating GIF. Please try again.');
            document.getElementById('exportBtn').textContent = originalText;
            document.getElementById('exportBtn').disabled = false;
        });
        
        // Start rendering
        gif.render();
    }
    
    createAnimatedPNGSequence(frames) {
        // Create a zip-like download of PNG frames
        const frameRate = parseInt(document.getElementById('frameRate').value);
        
        // Create individual frame downloads
        for (let i = 0; i < this.frames.length; i++) {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = this.canvasWidth;
            tempCanvas.height = this.canvasHeight;
            const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
            tempCtx.imageSmoothingEnabled = false;
            
            // Draw frame - composite layers if enabled
            tempCtx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
            tempCtx.fillStyle = 'white';
            tempCtx.fillRect(0, 0, this.canvasWidth, this.canvasHeight);
            
            // If layers are enabled, composite them for this frame
            if (this.layersEnabled && this.frameLayers[i]) {
                const frameData = this.frameLayers[i];
                frameData.layers.forEach(layer => {
                    if (layer.visible) {
                        tempCtx.drawImage(layer.canvas, 0, 0);
                    }
                });
            } else {
                // Draw the frame canvas directly
                tempCtx.drawImage(this.frames[i], 0, 0);
            }
            
            // Download frame
            setTimeout(() => {
                const assetName = document.getElementById('assetName').value || 'my_image';
                tempCanvas.toBlob(blob => {
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `${assetName}_frame_${String(i + 1).padStart(3, '0')}.png`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                });
            }, i * 200); // Stagger downloads
        }
        
        // Also create an info file with animation details
        setTimeout(() => {
            const assetName = document.getElementById('assetName').value || 'my_image';
            const info = `Animation Info:
Frames: ${this.frames.length}
Frame Rate: ${frameRate} FPS
Dimensions: ${this.canvasWidth}x${this.canvasHeight}
Duration: ${(this.frames.length / frameRate).toFixed(2)} seconds

Instructions:
1. These PNG frames can be imported into animation software
2. Set frame rate to ${frameRate} FPS
3. Or use the generated HPP animation code for Kywy displays`;
            
            const blob = new Blob([info], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${assetName}_info.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, this.frames.length * 200 + 500);
        
        alert(`Downloading ${this.frames.length} PNG frames. Check your downloads folder.`);
    }
    
    // Selection tool methods
    startSelection(x, y) {
        // Check if clicking on selection handles for dragging
        if (this.selection && this.selection.active && this.selection.cutContent) {
            const handle = this.getClickedHandle(x, y);
            if (handle) {
                this.startDraggingSelection(x, y, handle);
                return;
            }
        }
        
        if (this.selectionMode === 'lasso') {
            this.selection = {
                mode: 'lasso',
                lassoPoints: [{x: Math.round(x), y: Math.round(y)}],
                active: true,
                cutContent: null,
                isDragging: false,
                dragHandle: null
            };
        } else {
            this.selection = {
                mode: 'rectangle',
                startX: x,
                startY: y,
                endX: x,
                endY: y,
                active: true,
                cutContent: null,
                isDragging: false,
                dragHandle: null
            };
        }
        this.drawSelectionOverlay();
    }
    
    getClickedHandle(x, y) {
        if (!this.selection || !this.selection.active) return null;
        
        if (this.selection.mode === 'lasso') {
            // For lasso selections, check if click is near the lasso path or inside the lasso area
            const lassoPoints = this.selection.lassoPoints;
            if (!lassoPoints || lassoPoints.length < 3) return null;
            
            // Check if point is inside the lasso polygon
            if (this.isPointInLassoPolygon(x, y, lassoPoints)) {
                return 'move';
            }
            
            // Check if point is near the lasso path (for dragging)
            for (let i = 0; i < lassoPoints.length; i++) {
                const point = lassoPoints[i];
                if (Math.abs(x - point.x) <= 6 && Math.abs(y - point.y) <= 6) {
                    return 'move';
                }
            }
            
            return null;
        } else {
            // Rectangle selection logic
            const { startX, startY, endX, endY } = this.selection;
            const minX = Math.min(startX, endX);
            const minY = Math.min(startY, endY);
            const width = Math.abs(endX - startX);
            const height = Math.abs(endY - startY);
            const handleSize = 6; // Keep larger clickable area for usability
            
            // Check corner handles
            if (this.isPointInHandle(x, y, minX, minY, handleSize)) return 'move';
            if (this.isPointInHandle(x, y, minX + width, minY, handleSize)) return 'move';
            if (this.isPointInHandle(x, y, minX, minY + height, handleSize)) return 'move';
            if (this.isPointInHandle(x, y, minX + width, minY + height, handleSize)) return 'move';
            
            // Check if inside selection area for moving
            if (x >= minX && x <= minX + width && y >= minY && y <= minY + height) {
                return 'move';
            }
            
            return null;
        }
    }
    
    isPointInHandle(x, y, handleX, handleY, size) {
        return Math.abs(x - handleX) <= size/2 && Math.abs(y - handleY) <= size/2;
    }
    
    isPointInLassoPolygon(x, y, points) {
        // Ray casting algorithm to determine if point is inside polygon
        let inside = false;
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
            const xi = points[i].x, yi = points[i].y;
            const xj = points[j].x, yj = points[j].y;
            
            if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }
    
    startDraggingSelection(x, y, handle) {
        this.selection.isDragging = true;
        this.selection.dragHandle = handle;
        this.selection.dragStartX = x;
        this.selection.dragStartY = y;
        
        if (this.selection.mode === 'lasso') {
            // Store original lasso points for dragging
            this.selection.originalLassoPoints = this.selection.lassoPoints.map(point => ({x: point.x, y: point.y}));
        } else {
            // Store original rectangle coordinates for dragging
            this.selection.originalStartX = this.selection.startX;
            this.selection.originalStartY = this.selection.startY;
            this.selection.originalEndX = this.selection.endX;
            this.selection.originalEndY = this.selection.endY;
        }
    }
    
    updateSelection(x, y) {
        if (!this.selection || !this.selection.active) return;
        
        if (this.selection.isDragging) {
            const deltaX = x - this.selection.dragStartX;
            const deltaY = y - this.selection.dragStartY;
            
            if (this.selection.mode === 'lasso') {
                // Move all lasso points
                this.selection.lassoPoints = this.selection.lassoPoints.map(point => ({
                    x: point.x + deltaX,
                    y: point.y + deltaY
                }));
            } else {
                // Move the entire rectangle selection
                this.selection.startX = this.selection.originalStartX + deltaX;
                this.selection.startY = this.selection.originalStartY + deltaY;
                this.selection.endX = this.selection.originalEndX + deltaX;
                this.selection.endY = this.selection.originalEndY + deltaY;
            }
        } else {
            if (this.selection.mode === 'lasso') {
                // Add point to lasso path
                const lastPoint = this.selection.lassoPoints[this.selection.lassoPoints.length - 1];
                const distance = Math.sqrt((x - lastPoint.x) ** 2 + (y - lastPoint.y) ** 2);
                
                // Only add point if it's far enough from the last point (prevents too many points)
                if (distance > 2) {
                    this.selection.lassoPoints.push({x: Math.round(x), y: Math.round(y)});
                }
            } else {
                // Normal rectangle selection resizing
                this.selection.endX = x;
                this.selection.endY = y;
            }
        }
        
        this.drawSelectionOverlay();
    }
    
    drawSelectionOverlay() {
        // Only clear and redraw everything if we have an active selection for the select tool
        if (this.selection && this.selection.active && this.currentTool === 'select') {
            // Clear overlay and redraw ALL base layers first (including grid mode lines)
            this.overlayCtx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
            this.drawBaseOverlays();
            
            // Draw the selection overlay
            this.drawSelectionInOverlay();
            
            if (this.selection.mode === 'lasso') {
                const lassoPoints = this.selection.lassoPoints;
                if (lassoPoints && lassoPoints.length > 2) {
                    // Round all coordinates to nearest pixel for pixel-perfect selection
                    const roundedPoints = lassoPoints.map(point => ({
                        x: Math.round(point.x),
                        y: Math.round(point.y)
                    }));
                    
                    // Draw lasso path with pixel-perfect coordinates
                    this.overlayCtx.strokeStyle = 'rgba(255, 100, 100, 0.8)';
                    this.overlayCtx.lineWidth = 1;
                    this.overlayCtx.beginPath();
                    this.overlayCtx.moveTo(roundedPoints[0].x + 0.5, roundedPoints[0].y + 0.5);
                    
                    for (let i = 1; i < roundedPoints.length; i++) {
                        this.overlayCtx.lineTo(roundedPoints[i].x + 0.5, roundedPoints[i].y + 0.5);
                    }
                    
                    // Close the path
                    this.overlayCtx.closePath();
                    this.overlayCtx.stroke();
                    
                    // Fill the lasso area
                    this.overlayCtx.fillStyle = 'rgba(255, 100, 100, 0.3)';
                    this.overlayCtx.fill();
                    
                    // If we have cut content, draw it (would need to be implemented for lasso)
                    if (this.selection.cutContent) {
                        // For lasso selections, we'd need to determine bounds and position
                        // This is more complex and would require additional implementation
                    }
                }
            } else {
                // Rectangle selection
                const { startX, startY, endX, endY } = this.selection;
                const minX = Math.min(startX, endX);
                const minY = Math.min(startY, endY);
                const width = Math.abs(endX - startX);
                const height = Math.abs(endY - startY);
                
                // Don't process zero-sized selections
                if (width <= 0 || height <= 0) {
                    this.overlayCtx.restore();
                    return;
                }
                
                // If we have cut content, draw it at the selection position
                if (this.selection.cutContent) {
                    this.overlayCtx.drawImage(this.selection.cutContent, minX, minY);
                }
                
                // Draw simple light red semi-transparent overlay
                this.overlayCtx.fillStyle = 'rgba(255, 100, 100, 0.3)';
                this.overlayCtx.fillRect(minX, minY, width, height);
            }
            
            this.overlayCtx.restore();
        }
        // Note: When there's no active selection, we don't clear the overlay
        // to preserve other overlay elements like grids
    }
    
    drawHandle(x, y, size) {
        // Draw filled blue square with white border
        this.overlayCtx.fillRect(x - size/2, y - size/2, size, size);
        this.overlayCtx.strokeRect(x - size/2, y - size/2, size, size);
    }
    
    copyCode() {
        const codeOutput = document.getElementById('codeOutput');
        codeOutput.select();
        document.execCommand('copy');
        
        const btn = document.getElementById('copyCodeBtn');
        const originalText = btn.textContent;
        btn.textContent = '✓ Copied!';
        setTimeout(() => {
            btn.textContent = originalText;
        }, 2000);
    }
    
    showHelp() {
        document.getElementById('helpModal').style.display = 'block';
    }
    
    hideHelp() {
        document.getElementById('helpModal').style.display = 'none';
    }
    
    rotateSelectionByAngle(degrees) {
        if (!this.selection || !this.selection.active) return;
        
        const { startX, startY, endX, endY } = this.selection;
        const minX = Math.min(startX, endX);
        const minY = Math.min(startY, endY);
        const width = Math.abs(endX - startX);
        const height = Math.abs(endY - startY);
        
        if (width === 0 || height === 0) return;
        
        // Prevent rotation if selection is too large (causes performance issues)
        const maxDimension = Math.max(width, height);
        if (maxDimension > 200) {
            alert('Selection too large for rotation. Please select a smaller area.');
            return;
        }
        
        // Capture canvas state before rotation for undo
        const currentCtx = this.frames[this.currentFrameIndex].getContext('2d', { willReadFrequently: true });
        const canvasSnapshot = currentCtx.getImageData(0, 0, this.canvasWidth, this.canvasHeight);
        const selectionBounds = { startX, startY, endX, endY };
        
        // Get the selected area
        const imageData = currentCtx.getImageData(minX, minY, width, height);
        
        // Perform pixel-perfect rotation
        const rotatedPixels = this.rotatePixelsPerfect(imageData, degrees);
        
        if (!rotatedPixels) {
            alert('Rotation failed. Invalid angle or selection.');
            return;
        }
        
        // Clear the original selection area
        currentCtx.fillStyle = '#ffffff';
        currentCtx.fillRect(minX, minY, width, height);
        
        // Calculate original center coordinates for proper centering
        const originalCenterX = minX + width / 2;
        const originalCenterY = minY + height / 2;
        
        // Find the best position to place the rotated content
        const placementResult = this.findBestPlacement(rotatedPixels, originalCenterX, originalCenterY);
        
        if (placementResult) {
            // Place the rotated pixels
            this.placeRotatedPixels(currentCtx, rotatedPixels, placementResult.x, placementResult.y);
            
            // Update selection bounds to tight bounding box
            this.selection.startX = placementResult.bounds.minX;
            this.selection.startY = placementResult.bounds.minY;
            this.selection.endX = placementResult.bounds.maxX;
            this.selection.endY = placementResult.bounds.maxY;
        } else {
            alert('Rotated selection does not fit on canvas.');
            // Restore original content
            currentCtx.putImageData(canvasSnapshot, 0, 0);
            return;
        }
        
        this.redrawCanvas();
        this.drawSelectionOverlay();
        this.generateThumbnail(this.currentFrameIndex);
        this.generateCode();
        
        // Add undo command
        const command = new RotateSelectionCommand(this, canvasSnapshot, selectionBounds, this.currentFrameIndex);
        this.undoStack.push(command);
        this.redoStack = []; // Clear redo stack
    }
    
    // Pixel-perfect rotation using nearest neighbor approach
    rotatePixelsPerfect(imageData, degrees) {
        const width = imageData.width;
        const height = imageData.height;
        const data = imageData.data;
        
        // Only support specific angles for pixel-perfect rotation
        const normalizedAngle = ((degrees % 360) + 360) % 360;
        
        // Create array of non-white pixels with their absolute positions
        const pixels = [];
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                const r = data[idx];
                const g = data[idx + 1];
                const b = data[idx + 2];
                const a = data[idx + 3];
                
                // Only include non-white pixels (allowing for slight variations)
                if (a > 0 && (r < 240 || g < 240 || b < 240)) {
                    // Convert to black or white only
                    const isBlack = (r + g + b) < 384; // Average < 128
                    pixels.push({
                        x: x, // Keep absolute coordinates
                        y: y, // Keep absolute coordinates
                        color: isBlack ? 'black' : 'white'
                    });
                }
            }
        }
        
        if (pixels.length === 0) return null;
        
        // Calculate center of selection for rotation
        const centerX = width / 2;
        const centerY = height / 2;
        
        // Rotate each pixel around the selection center
        const angleRad = normalizedAngle * Math.PI / 180;
        const cos = Math.cos(angleRad);
        const sin = Math.sin(angleRad);
        
        const rotatedPixels = pixels.map(pixel => {
            // Translate to origin
            const relX = pixel.x - centerX;
            const relY = pixel.y - centerY;
            
            // Rotate
            const newRelX = relX * cos - relY * sin;
            const newRelY = relX * sin + relY * cos;
            
            // Translate back and round to nearest pixel
            return {
                x: Math.round(newRelX + centerX),
                y: Math.round(newRelY + centerY),
                color: pixel.color
            };
        });
        
        return rotatedPixels;
    }
    
    // Find the best placement for rotated pixels
    findBestPlacement(rotatedPixels, originalCenterX, originalCenterY) {
        if (rotatedPixels.length === 0) return null;
        
        // Calculate bounding box of rotated pixels (in selection-relative coordinates)
        let minX = rotatedPixels[0].x;
        let maxX = rotatedPixels[0].x;
        let minY = rotatedPixels[0].y;
        let maxY = rotatedPixels[0].y;
        
        rotatedPixels.forEach(pixel => {
            minX = Math.min(minX, pixel.x);
            maxX = Math.max(maxX, pixel.x);
            minY = Math.min(minY, pixel.y);
            maxY = Math.max(maxY, pixel.y);
        });
        
        // Calculate the center of the rotated content
        const rotatedCenterX = (minX + maxX) / 2;
        const rotatedCenterY = (minY + maxY) / 2;
        
        // Calculate offset to keep the content centered on the original position
        const offsetX = originalCenterX - rotatedCenterX;
        const offsetY = originalCenterY - rotatedCenterY;
        
        // Calculate final bounds after offset
        const finalMinX = minX + offsetX;
        const finalMaxX = maxX + offsetX;
        const finalMinY = minY + offsetY;
        const finalMaxY = maxY + offsetY;
        
        // Check if it fits on canvas
        if (finalMinX < 0 || finalMaxX >= this.canvasWidth || 
            finalMinY < 0 || finalMaxY >= this.canvasHeight) {
            return null; // Doesn't fit
        }
        
        return {
            x: offsetX,
            y: offsetY,
            bounds: {
                minX: Math.floor(finalMinX),
                maxX: Math.ceil(finalMaxX) + 1, // +1 for selection box
                minY: Math.floor(finalMinY),
                maxY: Math.ceil(finalMaxY) + 1  // +1 for selection box
            }
        };
    }
    
    // Place rotated pixels on canvas
    placeRotatedPixels(ctx, rotatedPixels, offsetX, offsetY) {
        rotatedPixels.forEach(pixel => {
            const canvasX = pixel.x + offsetX;
            const canvasY = pixel.y + offsetY;
            
            if (canvasX >= 0 && canvasX < this.canvasWidth && 
                canvasY >= 0 && canvasY < this.canvasHeight) {
                
                ctx.fillStyle = pixel.color;
                ctx.fillRect(Math.round(canvasX), Math.round(canvasY), 1, 1);
            }
        });
    }

    // Helper method to update color button states
    updateColorButtons() {
        document.querySelectorAll('.color-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        document.getElementById(this.currentColor + 'Color').classList.add('active');
    }

    // Image Import Functionality
    showImageImportModal() {
        document.getElementById('imageImportModal').style.display = 'block';
    }

    setupImageImporter() {
        this.importedImageData = null;
        
        // Event listeners for import controls
        const importImageInput = document.getElementById('importImageInput');
        const importResizeSelect = document.getElementById('importResize');
        const importContrastRange = document.getElementById('importContrast');
        const importBrightnessRange = document.getElementById('importBrightness');
        const importThresholdRange = document.getElementById('importThreshold');
        const importToCanvasBtn = document.getElementById('importToCanvas');
        const importToPasteBtn = document.getElementById('importToPaste');

        importImageInput.addEventListener('change', (e) => this.handleImportImageUpload(e));
        importToCanvasBtn.addEventListener('click', () => this.importToCanvas());
        importToPasteBtn.addEventListener('click', () => this.importToPasteMode());
        
        // Settings change handlers
        importResizeSelect.addEventListener('change', (e) => {
            const customDiv = document.getElementById('importCustomSize');
            customDiv.style.display = e.target.value === 'custom' ? 'block' : 'none';
            this.updateImportPreview();
        });

        document.getElementById('importCustomWidth').addEventListener('input', () => this.updateImportPreview());
        document.getElementById('importCustomHeight').addEventListener('input', () => this.updateImportPreview());
        
        // Real-time value updates and preview
        importContrastRange.addEventListener('input', (e) => {
            document.getElementById('importContrastValue').textContent = e.target.value;
            this.updateImportPreview();
        });
        
        importBrightnessRange.addEventListener('input', (e) => {
            document.getElementById('importBrightnessValue').textContent = e.target.value;
            this.updateImportPreview();
        });
        
        importThresholdRange.addEventListener('input', (e) => {
            document.getElementById('importThresholdValue').textContent = e.target.value;
            this.updateImportPreview();
        });

        // Other setting change handlers
        document.getElementById('importInvert').addEventListener('change', () => this.updateImportPreview());
        document.getElementById('importEdgeDetection').addEventListener('change', () => this.updateImportPreview());
        document.getElementById('importDithering').addEventListener('change', () => this.updateImportPreview());
    }

    handleImportImageUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                this.originalImportImage = img;
                this.displayImportOriginalImage(img);
                
                // Set default resize option based on image size
                const resizeSelect = document.getElementById('importResize');
                const kywyWidth = 144;
                const kywyHeight = 168;
                
                // If image is smaller than KYWY screen size, keep original size
                // Otherwise, default to KYWY screen size (144x168)
                if (img.width <= kywyWidth && img.height <= kywyHeight) {
                    resizeSelect.value = '';  // Keep original size
                } else {
                    resizeSelect.value = '144x168';  // Default to KYWY screen size
                }
                
                this.updateImportPreview();
                document.getElementById('importToCanvas').disabled = false;
                document.getElementById('importToPaste').disabled = false;
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    }

    displayImportOriginalImage(img) {
        const container = document.getElementById('importOriginalImage');
        container.innerHTML = '';
        
        // Create a canvas to show the original image
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        
        // Scale down for display if too large
        const maxDisplaySize = 200;
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
        info.textContent = `Original: ${img.width} x ${img.height}`;
        info.style.color = 'var(--text-color)';
        info.style.fontSize = '12px';
        info.style.marginTop = '5px';
        container.appendChild(info);
    }

    getImportTargetDimensions() {
        const resizeValue = document.getElementById('importResize').value;
        
        if (!resizeValue) {
            return { width: this.originalImportImage.width, height: this.originalImportImage.height };
        }
        
        if (resizeValue === 'custom') {
            const customWidth = parseInt(document.getElementById('importCustomWidth').value);
            const customHeight = parseInt(document.getElementById('importCustomHeight').value);
            return { 
                width: customWidth || this.originalImportImage.width, 
                height: customHeight || this.originalImportImage.height 
            };
        }
        
        const [width, height] = resizeValue.split('x').map(Number);
        return { width, height };
    }

    updateImportPreview() {
        if (!this.originalImportImage) return;
        
        const brightness = parseInt(document.getElementById('importBrightness').value);
        const contrast = parseInt(document.getElementById('importContrast').value);
        const threshold = parseInt(document.getElementById('importThreshold').value);
        const invert = document.getElementById('importInvert').checked;
        const edgeDetection = document.getElementById('importEdgeDetection').checked;
        const dithering = document.getElementById('importDithering').value;

        // Get target dimensions
        const { width, height } = this.getImportTargetDimensions();

        // Create canvas for processing
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        canvas.width = width;
        canvas.height = height;

        // Draw and resize the image
        ctx.drawImage(this.originalImportImage, 0, 0, width, height);
        
        // Get image data
        let imageData = ctx.getImageData(0, 0, width, height);
        
        // Apply image processing
        imageData = this.adjustBrightnessContrast(imageData, brightness, contrast);
        imageData = this.convertToGrayscale(imageData);
        
        // If BOTH edge detection and dithering are selected, apply them separately and combine
        let binaryData;
        if (edgeDetection && dithering !== 'none') {
            // Apply edge detection to a copy
            const edgeImageData = this.applyEdgeDetection(imageData);
            const edgeBinaryData = this.convertToBinary(edgeImageData, threshold, false); // Don't invert yet
            
            // Apply dithering to the original grayscale
            let ditheredImageData;
            if (dithering === 'floyd-steinberg') {
                ditheredImageData = this.applyFloydSteinbergDithering(imageData);
            } else if (dithering === 'atkinson') {
                ditheredImageData = this.atkinsonDithering(imageData, threshold);
            } else if (dithering === 'ordered') {
                ditheredImageData = this.orderedDithering(imageData, threshold);
            }
            const ditherBinaryData = this.convertDitheredToBinary(ditheredImageData, false); // Don't invert yet
            
            // Combine: a pixel is black if it's black in EITHER edge detection OR dithering
            binaryData = new Uint8Array(width * height);
            for (let i = 0; i < binaryData.length; i++) {
                const isBlackInEither = edgeBinaryData[i] === 1 || ditherBinaryData[i] === 1;
                binaryData[i] = isBlackInEither ? 1 : 0;
            }
            
            // Apply invert if needed
            if (invert) {
                for (let i = 0; i < binaryData.length; i++) {
                    binaryData[i] = binaryData[i] === 1 ? 0 : 1;
                }
            }
        } else if (edgeDetection) {
            // Only edge detection
            imageData = this.applyEdgeDetection(imageData);
            binaryData = this.convertToBinary(imageData, threshold, invert);
        } else if (dithering === 'floyd-steinberg') {
            // Only dithering
            imageData = this.applyFloydSteinbergDithering(imageData);
            binaryData = this.convertDitheredToBinary(imageData, invert);
        } else if (dithering === 'atkinson') {
            imageData = this.atkinsonDithering(imageData, threshold);
            binaryData = this.convertDitheredToBinary(imageData, invert);
        } else if (dithering === 'ordered') {
            imageData = this.orderedDithering(imageData, threshold);
            binaryData = this.convertDitheredToBinary(imageData, invert);
        } else {
            // No edge detection, no dithering - just threshold
            binaryData = this.convertToBinary(imageData, threshold, invert);
        }
        
        // Store processed data
        this.importedImageData = {
            width: width,
            height: height,
            data: binaryData
        };

        this.displayImportProcessedImage(canvas, binaryData, width, height);
    }

    displayImportProcessedImage(canvas, binaryData, width, height) {
        const container = document.getElementById('importProcessedImage');
        container.innerHTML = '';
        
        // Create display canvas
        const displayCanvas = document.createElement('canvas');
        const ctx = displayCanvas.getContext('2d', { willReadFrequently: true });
        
        // Scale for display
        const scale = Math.min(200 / width, 200 / height);
        const displayWidth = width * scale;
        const displayHeight = height * scale;
        
        displayCanvas.width = displayWidth;
        displayCanvas.height = displayHeight;
        displayCanvas.style.imageRendering = 'pixelated';
        
        // Draw binary data
        const imageData = ctx.createImageData(width, height);
        for (let i = 0; i < binaryData.length; i++) {
            const pixelIndex = i * 4;
            const value = binaryData[i] === 1 ? 0 : 255;
            imageData.data[pixelIndex] = value;     // R
            imageData.data[pixelIndex + 1] = value; // G
            imageData.data[pixelIndex + 2] = value; // B
            imageData.data[pixelIndex + 3] = 255;   // A
        }
        
        // Create temporary canvas at actual size
        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
        tempCanvas.width = width;
        tempCanvas.height = height;
        tempCtx.putImageData(imageData, 0, 0);
        
        // Draw scaled version
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tempCanvas, 0, 0, displayWidth, displayHeight);
        
        container.appendChild(displayCanvas);
        
        const info = document.createElement('p');
        info.textContent = `Processed: ${width} x ${height}`;
        info.style.color = 'var(--text-color)';
        info.style.fontSize = '12px';
        info.style.marginTop = '5px';
        container.appendChild(info);
    }

    importToCanvas() {
        if (!this.importedImageData) return;
        
        const { width, height, data } = this.importedImageData;
        const position = document.getElementById('importPosition').value;
        
        // Calculate position on canvas
        let startX, startY;
        switch (position) {
            case 'center':
                startX = Math.floor((this.canvasWidth - width) / 2);
                startY = Math.floor((this.canvasHeight - height) / 2);
                break;
            case 'top-left':
                startX = 0;
                startY = 0;
                break;
            case 'top-right':
                startX = this.canvasWidth - width;
                startY = 0;
                break;
            case 'bottom-left':
                startX = 0;
                startY = this.canvasHeight - height;
                break;
            case 'bottom-right':
                startX = this.canvasWidth - width;
                startY = this.canvasHeight - height;
                break;
        }
        
        // Get current frame context
        const ctx = this.getCurrentFrameContext();
        
        // Capture state before importing for undo
        this.captureSnapshot();
        
        // Draw the imported image data
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const dataIndex = y * width + x;
                const canvasX = startX + x;
                const canvasY = startY + y;
                
                if (canvasX >= 0 && canvasX < this.canvasWidth && 
                    canvasY >= 0 && canvasY < this.canvasHeight && 
                    data[dataIndex] === 1) {
                    // Set pixel to black (1 = black pixel in binary data)
                    this.setPixelInFrame(canvasX, canvasY, ctx);
                }
            }
        }
        
        // Update display and generate code
        this.redrawCanvas();
        this.generateThumbnail(this.currentFrameIndex);
        this.generateCode();
        
        // Close modal
        document.getElementById('imageImportModal').style.display = 'none';
        
        // Show success message
        alert(`Image imported successfully! (${width}x${height} at ${position})`);
    }

    importToPasteMode() {
        if (!this.importedImageData) return;
        
        const { width, height, data } = this.importedImageData;
        
        // Create a canvas with the imported image data
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = width;
        tempCanvas.height = height;
        const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
        
        // Convert binary data to image data
        const imageData = tempCtx.createImageData(width, height);
        for (let i = 0; i < data.length; i++) {
            const pixelIndex = i * 4;
            const value = data[i] === 1 ? 0 : 255; // 1 = black, 0 = white
            imageData.data[pixelIndex] = value;     // R
            imageData.data[pixelIndex + 1] = value; // G
            imageData.data[pixelIndex + 2] = value; // B
            imageData.data[pixelIndex + 3] = 255;   // A
        }
        tempCtx.putImageData(imageData, 0, 0);
        
        // Set up clipboard with the imported image
        this.clipboard = {
            data: tempCanvas,
            isSelection: true,
            width: width,
            height: height
        };
        
        // Enter paste mode
        this.setTool('select');
        this.isPasteModeActive = true;
        
        // Position at center of canvas
        this.pasteX = Math.floor((this.canvasWidth - width) / 2);
        this.pasteY = Math.floor((this.canvasHeight - height) / 2);
        
        // Update UI - set button to "Exit Paste Mode" state
        this.updateEditButtonStates();
        const pasteModeBtn = document.getElementById('pasteModeBtn');
        const pasteModeOptions = document.getElementById('pasteModeOptions');
        if (pasteModeBtn) {
            pasteModeBtn.classList.add('active');
            pasteModeBtn.textContent = 'Exit Paste Mode';
            pasteModeBtn.disabled = false;
        }
        if (pasteModeOptions) {
            pasteModeOptions.style.display = 'block';
        }
        
        // Close modal
        document.getElementById('imageImportModal').style.display = 'none';
        
        // Redraw to show the paste preview
        this.redrawCanvas();
        
        // Show success message
        alert(`Image loaded into paste mode! (${width}x${height})\nDrag to reposition, click to place.`);
    }

    // Image processing methods (adapted from converter.js)
    adjustBrightnessContrast(imageData, brightness, contrast) {
        const data = imageData.data;
        const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
        
        for (let i = 0; i < data.length; i += 4) {
            // Apply contrast
            data[i] = factor * (data[i] - 128) + 128;
            data[i + 1] = factor * (data[i + 1] - 128) + 128;
            data[i + 2] = factor * (data[i + 2] - 128) + 128;
            
            // Apply brightness
            data[i] = Math.max(0, Math.min(255, data[i] + brightness));
            data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + brightness));
            data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + brightness));
        }
        
        return imageData;
    }

    convertToGrayscale(imageData) {
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
            const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
            data[i] = gray;
            data[i + 1] = gray;
            data[i + 2] = gray;
        }
        return imageData;
    }

    applyEdgeDetection(imageData) {
        const { width, height, data } = imageData;
        const output = new Uint8ClampedArray(data.length);
        
        const sobelX = [[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]];
        const sobelY = [[-1, -2, -1], [0, 0, 0], [1, 2, 1]];
        
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                let gx = 0, gy = 0;
                
                for (let ky = -1; ky <= 1; ky++) {
                    for (let kx = -1; kx <= 1; kx++) {
                        const idx = ((y + ky) * width + (x + kx)) * 4;
                        const pixel = data[idx];
                        
                        gx += pixel * sobelX[ky + 1][kx + 1];
                        gy += pixel * sobelY[ky + 1][kx + 1];
                    }
                }
                
                const magnitude = Math.sqrt(gx * gx + gy * gy);
                const edgeValue = Math.min(255, magnitude);
                const invertedEdgeValue = 255 - edgeValue; // Invert the edge detection
                
                const idx = (y * width + x) * 4;
                output[idx] = invertedEdgeValue;
                output[idx + 1] = invertedEdgeValue;
                output[idx + 2] = invertedEdgeValue;
                output[idx + 3] = 255;
            }
        }
        
        // Handle border pixels (set to white background, no edge detection)
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (y === 0 || y === height - 1 || x === 0 || x === width - 1) {
                    const idx = (y * width + x) * 4;
                    // Set border pixels to white (no edges at border)
                    output[idx] = 255;
                    output[idx + 1] = 255;
                    output[idx + 2] = 255;
                    output[idx + 3] = 255;
                }
            }
        }
        
        return new ImageData(output, width, height);
    }

    applyDithering(imageData, method, threshold) {
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

    atkinsonDithering(imageData, threshold = 128) {
        const { width, height, data } = imageData;
        const newData = new Uint8ClampedArray(data);
        
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                const oldPixel = newData[idx];
                const newPixel = oldPixel > 128 ? 255 : 0;
                const error = oldPixel - newPixel;
                
                newData[idx] = newData[idx + 1] = newData[idx + 2] = newPixel;
                
                // Atkinson dithering distributes 3/4 of error to 6 neighbors
                const errorFraction = error / 8;
                
                // Right pixel (x+1, y)
                if (x + 1 < width) {
                    const idx1 = (y * width + (x + 1)) * 4;
                    newData[idx1] = Math.max(0, Math.min(255, newData[idx1] + errorFraction));
                    newData[idx1 + 1] = Math.max(0, Math.min(255, newData[idx1 + 1] + errorFraction));
                    newData[idx1 + 2] = Math.max(0, Math.min(255, newData[idx1 + 2] + errorFraction));
                }
                
                // Two pixels right (x+2, y)
                if (x + 2 < width) {
                    const idx2 = (y * width + (x + 2)) * 4;
                    newData[idx2] = Math.max(0, Math.min(255, newData[idx2] + errorFraction));
                    newData[idx2 + 1] = Math.max(0, Math.min(255, newData[idx2 + 1] + errorFraction));
                    newData[idx2 + 2] = Math.max(0, Math.min(255, newData[idx2 + 2] + errorFraction));
                }
                
                if (y + 1 < height) {
                    // Bottom left (x-1, y+1)
                    if (x - 1 >= 0) {
                        const idx3 = ((y + 1) * width + (x - 1)) * 4;
                        newData[idx3] = Math.max(0, Math.min(255, newData[idx3] + errorFraction));
                        newData[idx3 + 1] = Math.max(0, Math.min(255, newData[idx3 + 1] + errorFraction));
                        newData[idx3 + 2] = Math.max(0, Math.min(255, newData[idx3 + 2] + errorFraction));
                    }
                    
                    // Bottom center (x, y+1)
                    const idx4 = ((y + 1) * width + x) * 4;
                    newData[idx4] = Math.max(0, Math.min(255, newData[idx4] + errorFraction));
                    newData[idx4 + 1] = Math.max(0, Math.min(255, newData[idx4 + 1] + errorFraction));
                    newData[idx4 + 2] = Math.max(0, Math.min(255, newData[idx4 + 2] + errorFraction));
                    
                    // Bottom right (x+1, y+1)
                    if (x + 1 < width) {
                        const idx5 = ((y + 1) * width + (x + 1)) * 4;
                        newData[idx5] = Math.max(0, Math.min(255, newData[idx5] + errorFraction));
                        newData[idx5 + 1] = Math.max(0, Math.min(255, newData[idx5 + 1] + errorFraction));
                        newData[idx5 + 2] = Math.max(0, Math.min(255, newData[idx5 + 2] + errorFraction));
                    }
                }
                
                if (y + 2 < height) {
                    // Two pixels down (x, y+2)
                    const idx6 = ((y + 2) * width + x) * 4;
                    newData[idx6] = Math.max(0, Math.min(255, newData[idx6] + errorFraction));
                    newData[idx6 + 1] = Math.max(0, Math.min(255, newData[idx6 + 1] + errorFraction));
                    newData[idx6 + 2] = Math.max(0, Math.min(255, newData[idx6 + 2] + errorFraction));
                }
            }
        }
        
        return new ImageData(newData, width, height);
    }

    orderedDithering(imageData, threshold) {
        const { width, height, data } = imageData;
        const newData = new Uint8ClampedArray(data);
        
        const bayerMatrix = [
            [0, 8, 2, 10],
            [12, 4, 14, 6],
            [3, 11, 1, 9],
            [15, 7, 13, 5]
        ];
        
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                const pixel = newData[idx];
                const bayerValue = bayerMatrix[y % 4][x % 4];
                const adjustedThreshold = threshold + (bayerValue - 7.5) * 8;
                const newPixel = pixel > adjustedThreshold ? 255 : 0;
                
                newData[idx] = newData[idx + 1] = newData[idx + 2] = newPixel;
            }
        }
        
        return new ImageData(newData, width, height);
    }

    convertToBinary(imageData, threshold, invert) {
        const { width, height, data } = imageData;
        const binaryData = new Uint8Array(width * height);
        
        for (let i = 0; i < width * height; i++) {
            const pixelIndex = i * 4;
            const brightness = data[pixelIndex];
            let isBlack = brightness < threshold;
            
            if (invert) {
                isBlack = !isBlack;
            }
            
            binaryData[i] = isBlack ? 1 : 0;
        }
        
        return binaryData;
    }
    
    convertDitheredToBinary(imageData, invert) {
        // Convert already-dithered image (which has only 0 or 255 values) to binary
        const { width, height, data } = imageData;
        const binaryData = new Uint8Array(width * height);
        
        for (let i = 0; i < width * height; i++) {
            const pixelIndex = i * 4;
            const brightness = data[pixelIndex];
            // Dithering already produced 0 or 255, so just check if it's black (0)
            let isBlack = brightness < 128;
            
            if (invert) {
                isBlack = !isBlack;
            }
            
            binaryData[i] = isBlack ? 1 : 0;
        }
        
        return binaryData;
    }
    
    // Canvas transformation functions
    flipCanvasHorizontal() {
        // Capture state before transform for undo
        this.captureSnapshot();
        
        // Perform the transform
        this._flipCanvasHorizontalInternal();
        
        // Push to undo stack
        this.pushUndo();
    }
    
    _flipCanvasHorizontalInternal() {
        const ctx = this.getCurrentFrameContext();
        const imageData = ctx.getImageData(0, 0, this.canvasWidth, this.canvasHeight);
        
        // Create a temporary canvas for transformation
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = this.canvasWidth;
        tempCanvas.height = this.canvasHeight;
        const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
        
        // Put original image data on temp canvas
        tempCtx.putImageData(imageData, 0, 0);
        
        // Clear the main canvas and flip horizontally
        ctx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
        ctx.save();
        ctx.scale(-1, 1);
        ctx.drawImage(tempCanvas, -this.canvasWidth, 0);
        ctx.restore();
        
        this.redrawCanvas();
        this.generateThumbnail(this.currentFrameIndex);
        this.generateCode();
    }
    
    flipCanvasVertical() {
        // Capture state before transform for undo
        this.captureSnapshot();
        
        // Perform the transform
        this._flipCanvasVerticalInternal();
        
        // Push to undo stack
        this.pushUndo();
    }
    
    _flipCanvasVerticalInternal() {
        const ctx = this.getCurrentFrameContext();
        const imageData = ctx.getImageData(0, 0, this.canvasWidth, this.canvasHeight);
        
        // Create a temporary canvas for transformation
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = this.canvasWidth;
        tempCanvas.height = this.canvasHeight;
        const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
        
        // Put original image data on temp canvas
        tempCtx.putImageData(imageData, 0, 0);
        
        // Clear the main canvas and flip vertically
        ctx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
        ctx.save();
        ctx.scale(1, -1);
        ctx.drawImage(tempCanvas, 0, -this.canvasHeight);
        ctx.restore();
        
        this.redrawCanvas();
        this.generateThumbnail(this.currentFrameIndex);
        this.generateCode();
    }
    
    rotateCanvas(degrees) {
        // Capture state before transform for undo
        this.captureSnapshot();
        
        // Perform the transform
        this._rotateCanvasInternal(degrees);
        
        // Push to undo stack
        this.pushUndo();
    }
    
    _rotateCanvasInternal(degrees) {
        const ctx = this.getCurrentFrameContext();
        const imageData = ctx.getImageData(0, 0, this.canvasWidth, this.canvasHeight);
        
        // Create a temporary canvas for transformation
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = this.canvasWidth;
        tempCanvas.height = this.canvasHeight;
        const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
        
        // Put original image data on temp canvas
        tempCtx.putImageData(imageData, 0, 0);
        
        // Clear the main canvas and rotate
        ctx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
        ctx.save();
        
        // Move to center, rotate, then move back
        ctx.translate(this.canvasWidth / 2, this.canvasHeight / 2);
        ctx.rotate(degrees * Math.PI / 180);
        ctx.drawImage(tempCanvas, -this.canvasWidth / 2, -this.canvasHeight / 2);
        
        ctx.restore();
        this.redrawCanvas();
        this.generateThumbnail(this.currentFrameIndex);
        this.generateCode();
    }

    // Mobile menu methods
    toggleMobileMenu(menuType) {
        const menu = document.getElementById(`mobile-${menuType}-menu`);
        const overlay = document.getElementById('mobileMenuOverlay');
        
        if (menu.classList.contains('active')) {
            this.closeMobileMenus();
        } else {
            this.closeMobileMenus(); // Close any other open menus first
            menu.classList.add('active');
            overlay.classList.add('active');
        }
    }

    closeMobileMenus() {
        const menus = document.querySelectorAll('.mobile-popup');
        const overlay = document.getElementById('mobileMenuOverlay');
        
        menus.forEach(menu => menu.classList.remove('active'));
        overlay.classList.remove('active');
    }

    addMobileCloseButtons() {
        const overlay = document.getElementById('mobileMenuOverlay');
        const closeButtons = document.querySelectorAll('.mobile-close-btn');
        
        overlay.addEventListener('click', () => this.closeMobileMenus());
        
        closeButtons.forEach(button => {
            button.addEventListener('click', () => this.closeMobileMenus());
        });
    }

    handleMobileResize() {
        const isMobile = window.innerWidth <= 768;
        
        if (!isMobile) {
            this.closeMobileMenus(); // Close mobile menus on resize to desktop
        }
    }

    // Undo/Redo System Methods using Snapshots
    captureSnapshot() {
        // Capture current state before a change
        this.pendingSnapshot = new CanvasStateSnapshot(this);
    }
    
    pushUndo() {
        // Push the pending snapshot to undo stack after a change is complete
        if (this.pendingSnapshot) {
            this.undoStack.push(this.pendingSnapshot);
            this.redoStack = []; // Clear redo stack when new action is performed
            
            // Limit undo stack size
            if (this.undoStack.length > this.maxUndoStackSize) {
                this.undoStack.shift();
            }
            
            this.pendingSnapshot = null;
            this.markAsUnsaved();
            this.updateUndoRedoUI();
        }
    }
    
    // Legacy command execution for layer commands - pushes them to undo stack
    executeCommand(command) {
        command.execute();
        // Push command to undo stack for structural changes
        this.undoStack.push(command);
        this.redoStack = []; // Clear redo stack when new action is performed
        
        // Limit undo stack size
        if (this.undoStack.length > this.maxUndoStackSize) {
            this.undoStack.shift();
        }
        
        this.markAsUnsaved();
        this.updateUndoRedoUI();
    }
    
    undo() {
        if (this.undoStack.length === 0) return;
        
        const item = this.undoStack.pop();
        
        // Check if it's a snapshot or a command
        if (item instanceof CanvasStateSnapshot) {
            // Capture current state for redo
            const currentState = new CanvasStateSnapshot(this);
            this.redoStack.push(currentState);
            
            // Restore previous state
            if (item.restore()) {
                // Update layer UI if layers are enabled
                if (this.layersEnabled) {
                    this.updateLayersUI();
                }
                
                // Redraw canvas to show restored state
                this.redrawCanvas();
                
                this.updateUndoRedoUI();
                this.generateThumbnail(this.currentFrameIndex);
                this.generateCode();
            } else {
                // Restore failed, put it back
                this.undoStack.push(item);
                this.redoStack.pop();
            }
        } else if (item && typeof item.undo === 'function') {
            // It's a command object (layer command)
            this.redoStack.push(item);
            item.undo();
            this.updateUndoRedoUI();
        }
    }

    redo() {
        if (this.redoStack.length === 0) return;
        
        const item = this.redoStack.pop();
        
        // Check if it's a snapshot or a command
        if (item instanceof CanvasStateSnapshot) {
            // Capture current state for undo
            const currentState = new CanvasStateSnapshot(this);
            this.undoStack.push(currentState);
            
            // Restore redo state
            if (item.restore()) {
                // Update layer UI if layers are enabled
                if (this.layersEnabled) {
                    this.updateLayersUI();
                }
                
                // Redraw canvas to show restored state
                this.redrawCanvas();
                
                this.updateUndoRedoUI();
                this.generateThumbnail(this.currentFrameIndex);
                this.generateCode();
            } else {
                // Restore failed, put it back
                this.redoStack.push(item);
                this.undoStack.pop();
            }
        } else if (item && typeof item.execute === 'function') {
            // It's a command object (layer command)
            this.undoStack.push(item);
            item.execute();
            this.updateUndoRedoUI();
        }
    }

    updateUndoRedoUI() {
        // Update UI to show available undo/redo operations
        const canUndo = this.undoStack.length > 0;
        const canRedo = this.redoStack.length > 0;
        
        const undoBtn = document.getElementById('undoBtn');
        const redoBtn = document.getElementById('redoBtn');
        
        if (undoBtn) {
            undoBtn.disabled = !canUndo;
            undoBtn.style.opacity = canUndo ? '1' : '0.5';
        }
        
        if (redoBtn) {
            redoBtn.disabled = !canRedo;
            redoBtn.style.opacity = canRedo ? '1' : '0.5';
        }
    }

    // Helper method for setting pixels with color (needed for undo system)
    setPixelInFrameWithColor(x, y, color, ctx) {
        if (x >= 0 && x < this.canvasWidth && y >= 0 && y < this.canvasHeight) {
            const imageData = ctx.getImageData(x, y, 1, 1);
            const data = imageData.data;
            
            // Handle different color formats
            if (color === 'white') {
                data[0] = 255; data[1] = 255; data[2] = 255; data[3] = 255;
            } else if (color === 'black') {
                data[0] = 0; data[1] = 0; data[2] = 0; data[3] = 255;
            } else if (color.startsWith('rgba(')) {
                // Parse RGBA color string like "rgba(255, 255, 255, 1)"
                const rgba = color.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
                if (rgba) {
                    data[0] = parseInt(rgba[1]); // red
                    data[1] = parseInt(rgba[2]); // green  
                    data[2] = parseInt(rgba[3]); // blue
                    data[3] = Math.round(parseFloat(rgba[4]) * 255); // alpha
                }
            } else {
                // Default to black for unrecognized formats
                data[0] = 0; data[1] = 0; data[2] = 0; data[3] = 255;
            }
            
            ctx.putImageData(imageData, x, y);
        }
    }

    // Helper method to get pixel color as string
    getPixelColorString(x, y, ctx) {
        if (x < 0 || x >= this.canvasWidth || y < 0 || y >= this.canvasHeight) {
            return 'white';
        }
        
        const imageData = ctx.getImageData(x, y, 1, 1);
        const data = imageData.data;
        
        // Check if pixel is black (allowing for some tolerance)
        if (data[0] < 128 && data[1] < 128 && data[2] < 128) {
            return 'black';
        }
        return 'white';
    }

    // Start a new stroke for grouping drawing operations
    startStroke() {
        // Capture snapshot before drawing starts
        this.captureSnapshot();
        this.currentStroke = true; // Flag to indicate a stroke is in progress
    }

    // Add pixel to current stroke - no longer needed with snapshot system
    addPixelToStroke(x, y, oldColor, newColor) {
        // This method is kept for compatibility but doesn't do anything
    }
    
    // Pixel tracking - no longer needed with snapshot system
    startPixelTracking() {
        // This method is kept for compatibility but doesn't do anything
    }
    
    endPixelTracking() {
        // This method is kept for compatibility but doesn't do anything
    }
    
    // Convert RGBA values to color string
    rgbaToColorString(r, g, b, a) {
        // Convert to black or white based on the drawing system's color logic
        if (r === 0 && g === 0 && b === 0 && a === 255) {
            return 'black';
        } else if (r === 255 && g === 255 && b === 255 && a === 255) {
            return 'white';
        } else if (a === 0) {
            return 'transparent';
        } else {
            // For any other color, determine if it's closer to black or white
            const brightness = (r + g + b) / 3;
            return brightness < 128 ? 'black' : 'white';
        }
    }
    
    // Compare two ImageData objects and return array of changed pixels
    compareImageData(beforeImageData, afterImageData) {
        const pixelData = [];
        const beforeData = beforeImageData.data;
        const afterData = afterImageData.data;
        
        for (let i = 0; i < beforeData.length; i += 4) {
            const pixelIndex = i / 4;
            const x = pixelIndex % this.canvasWidth;
            const y = Math.floor(pixelIndex / this.canvasWidth);
            
            // Check if pixel changed
            const oldR = beforeData[i];
            const oldG = beforeData[i + 1];
            const oldB = beforeData[i + 2];
            const oldA = beforeData[i + 3];
            
            const newR = afterData[i];
            const newG = afterData[i + 1];
            const newB = afterData[i + 2];
            const newA = afterData[i + 3];
            
            if (oldR !== newR || oldG !== newG || oldB !== newB || oldA !== newA) {
                // Pixel changed - record it
                const oldColor = this.rgbaToColorString(oldR, oldG, oldB, oldA);
                const newColor = this.rgbaToColorString(newR, newG, newB, newA);
                pixelData.push({
                    x: x,
                    y: y,
                    oldColor: oldColor,
                    newColor: newColor
                });
            }
        }
        
        return pixelData;
    }

    // Finish current stroke and create command
    finishStroke() {
        // Push the snapshot that was captured at the start of the stroke
        this.pushUndo();
        this.currentStroke = false; // Clear the stroke flag
        
        // Generate thumbnail and code after stroke is complete
        this.generateThumbnail(this.currentFrameIndex);
        this.generateCode();
    }

    // Get pixels that will be affected by a shape
    getShapeAffectedPixels(startX, startY, endX, endY, shapeType) {
        const pixels = [];
        
        if (shapeType === 'circle') {
            const radius = Math.sqrt(Math.pow(endX - startX, 2) + Math.pow(endY - startY, 2));
            const centerX = startX;
            const centerY = startY;
            
            if (this.shapeFillMode === 'filled') {
                // Filled circle
                for (let x = -radius; x <= radius; x++) {
                    for (let y = -radius; y <= radius; y++) {
                        if (x * x + y * y <= radius * radius) {
                            const pixelX = centerX + x;
                            const pixelY = centerY + y;
                            if (pixelX >= 0 && pixelX < this.canvasWidth && pixelY >= 0 && pixelY < this.canvasHeight) {
                                pixels.push({x: pixelX, y: pixelY});
                            }
                        }
                    }
                }
            } else {
                // Circle outline - this is complex, so let's approximate
                const thickness = this.shapeThickness;
                const outerRadius = radius + Math.floor(thickness / 2);
                const innerRadius = Math.max(0, radius - Math.floor(thickness / 2));
                
                for (let x = -outerRadius; x <= outerRadius; x++) {
                    for (let y = -outerRadius; y <= outerRadius; y++) {
                        const distance = Math.sqrt(x * x + y * y);
                        if (distance <= outerRadius && distance >= innerRadius) {
                            const pixelX = centerX + x;
                            const pixelY = centerY + y;
                            if (pixelX >= 0 && pixelX < this.canvasWidth && pixelY >= 0 && pixelY < this.canvasHeight) {
                                pixels.push({x: pixelX, y: pixelY});
                            }
                        }
                    }
                }
            }
        } else if (shapeType === 'square') {
            const minX = Math.min(startX, endX);
            const maxX = Math.max(startX, endX);
            const minY = Math.min(startY, endY);
            const maxY = Math.max(startY, endY);
            
            if (this.shapeFillMode === 'filled') {
                // Filled rectangle
                for (let x = minX; x <= maxX; x++) {
                    for (let y = minY; y <= maxY; y++) {
                        if (x >= 0 && x < this.canvasWidth && y >= 0 && y < this.canvasHeight) {
                            pixels.push({x, y});
                        }
                    }
                }
            } else {
                // Rectangle outline - simplified version
                const thickness = this.shapeThickness;
                
                for (let t = 0; t < thickness; t++) {
                    const adjustedMinX = minX - t;
                    const adjustedMaxX = maxX + t;
                    const adjustedMinY = minY - t;
                    const adjustedMaxY = maxY + t;
                    
                    // Top and bottom edges
                    for (let x = adjustedMinX; x <= adjustedMaxX; x++) {
                        if (x >= 0 && x < this.canvasWidth) {
                            if (adjustedMinY >= 0 && adjustedMinY < this.canvasHeight) {
                                pixels.push({x, y: adjustedMinY});
                            }
                            if (adjustedMaxY >= 0 && adjustedMaxY < this.canvasHeight) {
                                pixels.push({x, y: adjustedMaxY});
                            }
                        }
                    }
                    
                    // Left and right edges
                    for (let y = adjustedMinY; y <= adjustedMaxY; y++) {
                        if (y >= 0 && y < this.canvasHeight) {
                            if (adjustedMinX >= 0 && adjustedMinX < this.canvasWidth) {
                                pixels.push({x: adjustedMinX, y});
                            }
                            if (adjustedMaxX >= 0 && adjustedMaxX < this.canvasWidth) {
                                pixels.push({x: adjustedMaxX, y});
                            }
                        }
                    }
                }
            }
        }
        
        // Add mirrored pixels if mirror mode is enabled
        if (this.mirrorHorizontal || this.mirrorVertical) {
            const mirroredPixels = [];
            pixels.forEach(pixel => {
                const mirrored = this.getMirroredPixels(pixel.x, pixel.y, 1, 'square');
                mirroredPixels.push(...mirrored);
            });
            pixels.push(...mirroredPixels);
        }
        
        return pixels;
    }

    // Setup unsaved changes warning
    setupUnsavedWarning() {
        window.addEventListener('beforeunload', (e) => {
            if (this.hasUnsavedChanges && !this.isBlankCanvas) {
                const message = 'You have unsaved changes. Are you sure you want to leave?';
                e.preventDefault();
                e.returnValue = message; // For Chrome
                return message; // For other browsers
            }
        });
    }

    // Initialize save reminder system
    initializeSaveReminder() {
        // Create banner element
        this.saveReminderBanner = document.createElement('div');
        this.saveReminderBanner.className = 'save-reminder-banner';
        this.saveReminderBanner.innerHTML = `
            <span class="save-reminder-text">⚠️ Don't forget to save your work!</span>
            <div class="save-reminder-actions">
                <button class="save-reminder-btn save-reminder-snooze" title="Snooze for 15s">💤 Snooze</button>
                <button class="save-reminder-btn save-reminder-off" title="Turn off reminders">🔕 Turn Off</button>
                <button class="save-reminder-dismiss" title="Dismiss">✕</button>
            </div>
        `;
        this.saveReminderBanner.style.display = 'none';
        document.body.appendChild(this.saveReminderBanner);
        
        // Add snooze button handler
        const snoozeBtn = this.saveReminderBanner.querySelector('.save-reminder-snooze');
        snoozeBtn.addEventListener('click', () => {
            this.snoozeSaveReminder();
        });
        
        // Add turn off button handler
        const offBtn = this.saveReminderBanner.querySelector('.save-reminder-off');
        offBtn.addEventListener('click', () => {
            this.turnOffSaveReminder();
        });
        
        // Add dismiss button handler
        const dismissBtn = this.saveReminderBanner.querySelector('.save-reminder-dismiss');
        dismissBtn.addEventListener('click', () => {
            this.hideSaveReminder();
        });
        
        // Start checking every minute
        this.saveReminderInterval = setInterval(() => {
            this.checkSaveReminder();
        }, 60000); // Check every 60 seconds
    }
    
    // Check if we should show the save reminder
    checkSaveReminder() {
        // Don't check if reminders are disabled
        if (!this.saveReminderEnabled) {
            return;
        }
        
        const timeSinceLastSave = Date.now() - this.lastSaveTime;
        const thirtyMinutes = 30 * 60 * 1000; // 30 minutes in milliseconds
        
        // Show banner if it's been 30+ minutes and there are unsaved changes
        if (timeSinceLastSave >= thirtyMinutes && this.hasUnsavedChanges && !this.isBlankCanvas) {
            this.showSaveReminder();
        }
    }
    
    // Show the save reminder banner
    showSaveReminder() {
        if (this.saveReminderBanner) {
            this.saveReminderBanner.style.display = 'flex';
            // Add animation class
            this.saveReminderBanner.classList.add('slide-in');
        }
    }
    
    // Hide the save reminder banner
    hideSaveReminder() {
        if (this.saveReminderBanner) {
            this.saveReminderBanner.classList.add('slide-out');
            setTimeout(() => {
                this.saveReminderBanner.style.display = 'none';
                this.saveReminderBanner.classList.remove('slide-in', 'slide-out');
            }, 300); // Match animation duration
        }
    }
    
    // Reset save reminder timer
    resetSaveReminderTimer() {
        this.lastSaveTime = Date.now();
        this.hideSaveReminder();
    }
    
    // Snooze the save reminder (reset timer and hide)
    snoozeSaveReminder() {
        this.lastSaveTime = Date.now();
        this.hideSaveReminder();
    }
    
    // Turn off save reminders permanently
    turnOffSaveReminder() {
        this.saveReminderEnabled = false;
        this.hideSaveReminder();
        
        // Clear the interval to stop checking
        if (this.saveReminderInterval) {
            clearInterval(this.saveReminderInterval);
            this.saveReminderInterval = null;
        }
    }

    // Mark canvas as having unsaved changes
    markAsUnsaved() {
        this.hasUnsavedChanges = true;
        this.isBlankCanvas = false;
        this.updateWindowTitle();
    }

    // Mark canvas as saved
    markAsSaved() {
        this.hasUnsavedChanges = false;
        this.updateWindowTitle();
    }

    // Check if canvas is blank (all white pixels)
    checkIfBlank() {
        const ctx = this.getCurrentFrameContext();
        const imageData = ctx.getImageData(0, 0, this.canvasWidth, this.canvasHeight);
        const data = imageData.data;
        
        // Check if all pixels are white (255, 255, 255, 255)
        for (let i = 0; i < data.length; i += 4) {
            if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255 || data[i + 3] !== 255) {
                return false;
            }
        }
        
        return true;
    }

    // Update window title to show unsaved changes
    updateWindowTitle() {
        const baseTitle = 'KOINSLOT Drawing Editor';
        if (this.hasUnsavedChanges && !this.isBlankCanvas) {
            document.title = `${baseTitle} - Unsaved Changes`;
        } else {
            document.title = baseTitle;
        }
    }

    // Helper method to get all pixels that will be affected by a brush stroke
    getAffectedPixels(x, y) {
        const pixels = [];
        
        // Get pixels for the main brush stroke
        const brushPixels = this.getBrushPixels(x, y, this.brushSize, this.brushShape);
        pixels.push(...brushPixels);
        
        // Get pixels for mirrored strokes
        if (this.mirrorHorizontal || this.mirrorVertical) {
            const mirroredPixels = this.getMirroredPixels(x, y, this.brushSize, this.brushShape);
            pixels.push(...mirroredPixels);
        }
        
        return pixels;
    }

    // Get pixels for a brush stroke at given position
    getBrushPixels(centerX, centerY, size, shape) {
        const pixels = [];
        const radius = Math.floor(size / 2);
        
        if (shape === 'circle') {
            for (let dx = -radius; dx <= radius; dx++) {
                for (let dy = -radius; dy <= radius; dy++) {
                    if (dx * dx + dy * dy <= radius * radius) {
                        const x = centerX + dx;
                        const y = centerY + dy;
                        if (x >= 0 && x < this.canvasWidth && y >= 0 && y < this.canvasHeight) {
                            pixels.push({x, y});
                        }
                    }
                }
            }
        } else { // square
            for (let dx = -radius; dx <= radius; dx++) {
                for (let dy = -radius; dy <= radius; dy++) {
                    const x = centerX + dx;
                    const y = centerY + dy;
                    if (x >= 0 && x < this.canvasWidth && y >= 0 && y < this.canvasHeight) {
                        pixels.push({x, y});
                    }
                }
            }
        }
        
        return pixels;
    }

    // Get mirrored pixels for a brush stroke
    getMirroredPixels(x, y, size, shape) {
        const pixels = [];
        
        if (this.mirrorHorizontal && !this.mirrorVertical) {
            // Horizontal mirror only
            let mirrorX;
            if (this.canvasWidth % 2 === 0) {
                const centerLine = (this.canvasWidth / 2) - 0.5;
                mirrorX = Math.floor(2 * centerLine - x);
            } else {
                const center = Math.floor(this.canvasWidth / 2);
                mirrorX = 2 * center - x;
            }
            
            if (mirrorX !== x && mirrorX >= 0 && mirrorX < this.canvasWidth) {
                const brushPixels = this.getBrushPixels(mirrorX, y, size, shape);
                pixels.push(...brushPixels);
            }
        } else if (this.mirrorVertical && !this.mirrorHorizontal) {
            // Vertical mirror only
            let mirrorY;
            if (this.canvasHeight % 2 === 0) {
                const centerLine = (this.canvasHeight / 2) - 0.5;
                mirrorY = Math.floor(2 * centerLine - y);
            } else {
                const center = Math.floor(this.canvasHeight / 2);
                mirrorY = 2 * center - y;
            }
            
            if (mirrorY !== y && mirrorY >= 0 && mirrorY < this.canvasHeight) {
                const brushPixels = this.getBrushPixels(x, mirrorY, size, shape);
                pixels.push(...brushPixels);
            }
        } else if (this.mirrorHorizontal && this.mirrorVertical) {
            // Both mirrors - create 4-way symmetry
            let mirrorX, mirrorY;
            
            if (this.canvasWidth % 2 === 0) {
                const centerLineX = (this.canvasWidth / 2) - 0.5;
                mirrorX = Math.floor(2 * centerLineX - x);
            } else {
                const centerX = Math.floor(this.canvasWidth / 2);
                mirrorX = 2 * centerX - x;
            }
            
            if (this.canvasHeight % 2 === 0) {
                const centerLineY = (this.canvasHeight / 2) - 0.5;
                mirrorY = Math.floor(2 * centerLineY - y);
            } else {
                const centerY = Math.floor(this.canvasHeight / 2);
                mirrorY = 2 * centerY - y;
            }
            
            // Add mirrored positions
            const positions = [
                {x: mirrorX, y: y},      // Horizontal mirror
                {x: x, y: mirrorY},      // Vertical mirror
                {x: mirrorX, y: mirrorY} // Both mirrors
            ];
            
            positions.forEach(pos => {
                if (pos.x >= 0 && pos.x < this.canvasWidth && pos.y >= 0 && pos.y < this.canvasHeight) {
                    const brushPixels = this.getBrushPixels(pos.x, pos.y, size, shape);
                    pixels.push(...brushPixels);
                }
            });
        }
        
        return pixels;
    }

    // Generate pattern data for stippling and gradients
    generatePatterns() {
        const patterns = {};
        
        // Stippling patterns (8x8 pixel patterns)
        patterns.stipple25 = [
            [0,0,0,1,0,0,0,1],
            [0,0,0,0,0,0,0,0],
            [0,0,0,1,0,0,0,1],
            [1,0,0,0,1,0,0,0],
            [0,0,0,1,0,0,0,1],
            [0,0,0,0,0,0,0,0],
            [0,0,0,1,0,0,0,1],
            [1,0,0,0,1,0,0,0]
        ];
        
        patterns.stipple50 = [
            [1,0,1,0,1,0,1,0],
            [0,1,0,1,0,1,0,1],
            [1,0,1,0,1,0,1,0],
            [0,1,0,1,0,1,0,1],
            [1,0,1,0,1,0,1,0],
            [0,1,0,1,0,1,0,1],
            [1,0,1,0,1,0,1,0],
            [0,1,0,1,0,1,0,1]
        ];
        
        patterns.stipple75 = [
            [1,1,1,0,1,1,1,0],
            [1,1,1,1,1,1,1,1],
            [1,1,1,0,1,1,1,0],
            [0,1,1,1,0,1,1,1],
            [1,1,1,0,1,1,1,0],
            [1,1,1,1,1,1,1,1],
            [1,1,1,0,1,1,1,0],
            [0,1,1,1,0,1,1,1]
        ];
        
        patterns.checkerboard = [
            [1,1,0,0,1,1,0,0],
            [1,1,0,0,1,1,0,0],
            [0,0,1,1,0,0,1,1],
            [0,0,1,1,0,0,1,1],
            [1,1,0,0,1,1,0,0],
            [1,1,0,0,1,1,0,0],
            [0,0,1,1,0,0,1,1],
            [0,0,1,1,0,0,1,1]
        ];
        
        patterns.diagonal = [
            [1,0,0,0,0,0,0,0],
            [0,1,0,0,0,0,0,0],
            [0,0,1,0,0,0,0,0],
            [0,0,0,1,0,0,0,0],
            [0,0,0,0,1,0,0,0],
            [0,0,0,0,0,1,0,0],
            [0,0,0,0,0,0,1,0],
            [0,0,0,0,0,0,0,1]
        ];
        
        patterns.crosshatch = [
            [1,0,0,0,1,0,0,0],
            [0,1,0,1,0,1,0,1],
            [0,0,1,0,0,0,1,0],
            [0,1,0,1,0,1,0,1],
            [1,0,0,0,1,0,0,0],
            [0,1,0,1,0,1,0,1],
            [0,0,1,0,0,0,1,0],
            [0,1,0,1,0,1,0,1]
        ];
        
        patterns.dots = [
            [0,0,0,0,0,0,0,0],
            [0,0,1,0,0,0,1,0],
            [0,0,0,0,0,0,0,0],
            [0,0,0,0,0,0,0,0],
            [0,0,0,0,0,0,0,0],
            [0,0,1,0,0,0,1,0],
            [0,0,0,0,0,0,0,0],
            [0,0,0,0,0,0,0,0]
        ];
        
        return patterns;
    }

    // Check if pixel should be filled based on pattern
    shouldFillPixel(x, y, pattern) {
        if (pattern === 'solid') {
            return true; // Solid fill
        }
        
        if (pattern === 'percentage') {
            // Generate percentage pattern using ordered dithering
            return this.shouldFillPixelPercentage(x, y, this.currentPercentage);
        }
        
        if (pattern === 'lines') {
            return this.shouldFillPixelLines(x, y);
        }
        
        if (pattern === 'checkerboard') {
            return this.shouldFillPixelCheckerboard(x, y);
        }
        
        if (pattern === 'clipboard') {
            return this.shouldFillPixelClipboard(x, y);
        }
        
        if (pattern === 'dots') {
            return this.shouldFillPixelDots(x, y);
        }
        
        if (!this.patterns[pattern]) {
            return true; // Unknown pattern defaults to solid
        }
        
        const patternData = this.patterns[pattern];
        const patternSize = patternData.length;
        const px = x % patternSize;
        const py = y % patternSize;
        
        return patternData[py][px] === 1;
    }

    // Generate checkerboard pattern with adjustable size
    shouldFillPixelCheckerboard(x, y) {
        const size = this.checkerboardSize;
        const checkX = Math.floor(x / size) % 2;
        const checkY = Math.floor(y / size) % 2;
        const fill = (checkX + checkY) % 2 === 0;
        return this.checkerboardInvert ? !fill : fill;
    }

    // Generate clipboard pattern with adjustable scaling
    shouldFillPixelClipboard(x, y) {
        // Check if we have clipboard data with valid dimensions
        if (!this.clipboard || !this.clipboard.data || 
            !this.clipboard.width || this.clipboard.width <= 0 ||
            !this.clipboard.height || this.clipboard.height <= 0) {
            return false;
        }
        
        const scale = this.clipboardScale / 100;
        const clipWidth = this.clipboard.width;
        const clipHeight = this.clipboard.height;
        
        // Scale coordinates to clipboard space
        const scaledX = Math.floor(x / scale);
        const scaledY = Math.floor(y / scale);
        
        // Tile the pattern by using modulo (safe now that we've checked dimensions)
        const tileX = scaledX % clipWidth;
        const tileY = scaledY % clipHeight;
        
        // Get pixel from clipboard canvas
        const clipCanvas = this.clipboard.data;
        const clipCtx = clipCanvas.getContext('2d', { willReadFrequently: true });
        
        // Additional safety check for coordinates
        if (tileX < 0 || tileX >= clipWidth || tileY < 0 || tileY >= clipHeight) {
            return false;
        }
        
        const imageData = clipCtx.getImageData(tileX, tileY, 1, 1);
        const pixelData = imageData.data;
        
        // Consider pixel filled if it's not white (RGB < 255)
        const isWhite = pixelData[0] === 255 && pixelData[1] === 255 && pixelData[2] === 255;
        const fill = !isWhite;
        return this.clipboardInvert ? !fill : fill;
    }

    // Generate dots pattern with adjustable spacing, size, and row offset
    shouldFillPixelDots(x, y) {
        const spacing = this.dotsSpacing;
        const size = this.dotsSize;
        const offset = Math.round(this.dotsOffset); // Use rounded integer offset
        
        // Calculate which row we're in
        const row = Math.floor(y / spacing);
        
        // Apply offset to alternate rows (staggered brick pattern)
        // Use integer offset for precise positioning
        const offsetX = (row % 2) * Math.round(spacing * offset / 100);
        const adjustedX = x - offsetX;
        
        // Find center of nearest dot grid position
        const gridX = Math.floor(adjustedX / spacing) * spacing + Math.floor(spacing / 2);
        const gridY = Math.floor(y / spacing) * spacing + Math.floor(spacing / 2);
        
        // Check if within dot radius
        const deltaX = Math.abs(adjustedX - gridX);
        const deltaY = Math.abs(y - gridY);
        const maxSize = Math.floor(size / 2);
        
        const fill = deltaX <= maxSize && deltaY <= maxSize;
        return this.dotsInvert ? !fill : fill;
    }

    // Generate percentage fill using ordered dithering for smooth distribution
    shouldFillPixelPercentage(x, y, percentage) {
        // 8x8 Bayer matrix for ordered dithering
        const bayerMatrix = [
            [0,  32, 8,  40, 2,  34, 10, 42],
            [48, 16, 56, 24, 50, 18, 58, 26],
            [12, 44, 4,  36, 14, 46, 6,  38],
            [60, 28, 52, 20, 62, 30, 54, 22],
            [3,  35, 11, 43, 1,  33, 9,  41],
            [51, 19, 59, 27, 49, 17, 57, 25],
            [15, 47, 7,  39, 13, 45, 5,  37],
            [63, 31, 55, 23, 61, 29, 53, 21]
        ];
        
        const matrixSize = 8;
        const mx = x % matrixSize;
        const my = y % matrixSize;
        const threshold = bayerMatrix[my][mx];
        
        // Convert percentage to threshold (0-63)
        const fillThreshold = (percentage / 100) * 64;
        
        return threshold < fillThreshold;
    }



    hexToRgba(hex) {
        // Handle different hex formats
        if (hex === 'black') hex = '#000000';
        if (hex === 'white') hex = '#ffffff';
        
        // Remove # if present
        hex = hex.replace('#', '');
        
        // Handle 3-character hex
        if (hex.length === 3) {
            hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        }
        
        const r = parseInt(hex.substr(0, 2), 16);
        const g = parseInt(hex.substr(2, 2), 16);
        const b = parseInt(hex.substr(4, 2), 16);
        const a = hex.length === 8 ? parseInt(hex.substr(6, 2), 16) : 255;
        
        return { r, g, b, a };
    }

    rgbaToHex(r, g, b, a = 255) {
        const toHex = (n) => {
            const hex = Math.max(0, Math.min(255, Math.round(n))).toString(16);
            return hex.length === 1 ? '0' + hex : hex;
        };
        
        return `#${toHex(r)}${toHex(g)}${toHex(b)}${a !== 255 ? toHex(a) : ''}`;
    }

    applyDithering(x, y, intensity, baseColor, algorithm) {
        // Adjust intensity based on center distance setting
        intensity = Math.max(0, Math.min(1, (intensity - this.gradientCenterDistance + 0.5)));
        
        // Apply steepness to control transition width
        // High steepness (5.0) = sharp cutoff, Low steepness (0.1) = gentle transition
        const transitionCenter = 0.5; // Center of transition
        
        // Create a smooth transition zone around the center
        let adjustedIntensity;
        if (this.gradientSteepness >= 1.0) {
            // Sharp transitions - use sigmoid function
            const steepnessFactor = this.gradientSteepness * 10; // Scale for sharper curves
            adjustedIntensity = 1 / (1 + Math.exp(-steepnessFactor * (intensity - transitionCenter)));
        } else {
            // Gentle transitions - use wider sigmoid
            const steepnessFactor = this.gradientSteepness * 5;
            adjustedIntensity = 1 / (1 + Math.exp(-steepnessFactor * (intensity - transitionCenter)));
        }
        
        // Apply contrast adjustment to intensity
        // High contrast (2.0) = more extreme values, Low contrast (0.1) = more mid-tones
        const contrastCenter = 0.5;
        const contrastAdjustedIntensity = contrastCenter + (adjustedIntensity - contrastCenter) * this.gradientContrast;
        const finalIntensity = Math.max(0, Math.min(1, contrastAdjustedIntensity));
        
        if (algorithm === 'floyd-steinberg') {
            const threshold = this.getFloydSteinbergThreshold(x, y, finalIntensity);
            const shouldFill = finalIntensity > threshold;
            return shouldFill ? baseColor : (baseColor === 'black' ? '#ffffff' : '#000000');
        } else if (algorithm === 'ordered') {
            const threshold = this.getOrderedDitherThreshold(x, y);
            const shouldFill = finalIntensity > threshold;
            return shouldFill ? baseColor : (baseColor === 'black' ? '#ffffff' : '#000000');
        }
        
        // Fallback - pure black or white based on adjusted intensity
        const threshold = 0.5;
        if (baseColor === 'black') {
            return finalIntensity > threshold ? '#000000' : '#ffffff';
        } else {
            return finalIntensity > threshold ? '#ffffff' : '#000000';
        }
    }

    getFloydSteinbergThreshold(x, y, intensity) {
        // Create a pseudo-random but consistent threshold based on position
        // Incorporate angle into the noise calculation for directional effects
        const angleOffset = this.gradientAngle * 0.01; // Small influence from angle
        const noise = (Math.sin((x + angleOffset) * 12.9898 + (y + angleOffset) * 78.233) * 43758.5453) % 1;
        const smoothedNoise = Math.abs(noise); // Ensure positive
        
        // Add some structure to avoid pure randomness
        // Include center distance in the structured component
        const structureOffset = this.gradientCenterDistance * 0.2;
        const structuredNoise = (smoothedNoise * 0.7) + (((x + y) % 4) / 4) * 0.3 + structureOffset;
        
        // Apply contrast to the threshold range
        // High contrast = wider threshold range (more variation)
        // Low contrast = narrower threshold range (less variation)
        const baseThreshold = 0.5;
        const thresholdRange = 0.3 * this.gradientContrast; // Contrast affects threshold spread
        const finalThreshold = baseThreshold + (structuredNoise - 0.5) * thresholdRange;
        
        return Math.max(0.1, Math.min(0.9, finalThreshold));
    }

    getOrderedDitherThreshold(x, y) {
        // 4x4 Bayer dithering matrix
        const bayerMatrix = [
            [0,  8,  2, 10],
            [12, 4, 14,  6],
            [3, 11,  1,  9],
            [15, 7, 13,  5]
        ];
        
        // Apply angle rotation to the matrix coordinates
        let matrixX = x;
        let matrixY = y;
        
        if (this.gradientAngle !== 0) {
            const angleRad = (this.gradientAngle * Math.PI) / 180;
            const rotatedX = Math.round(x * Math.cos(angleRad) - y * Math.sin(angleRad));
            const rotatedY = Math.round(x * Math.sin(angleRad) + y * Math.cos(angleRad));
            matrixX = Math.abs(rotatedX);
            matrixY = Math.abs(rotatedY);
        }
        
        const finalX = matrixX % 4;
        const finalY = matrixY % 4;
        const baseThreshold = bayerMatrix[finalY][finalX] / 16;
        
        // Adjust threshold based on center distance
        const centerAdjustment = (this.gradientCenterDistance - 0.5) * 0.2;
        
        // Apply contrast to the threshold
        // High contrast = more extreme threshold values
        // Low contrast = threshold values closer to 0.5
        const contrastCenter = 0.5;
        const contrastAdjustedThreshold = contrastCenter + (baseThreshold - contrastCenter) * this.gradientContrast;
        
        return Math.max(0, Math.min(1, contrastAdjustedThreshold + centerAdjustment));
    }

    // Custom line pattern function with adjustable angle, spacing, and width
    // Custom line pattern function with adjustable angle, spacing, width, and phase
    shouldFillPixelLines(x, y) {
        const angleRad = (this.lineAngle * Math.PI) / 180;
        const cosAngle = Math.cos(angleRad);
        const sinAngle = Math.sin(angleRad);
        
        // Apply rotation to coordinates
        const rotatedX = x * cosAngle + y * sinAngle;
        const rotatedY = -x * sinAngle + y * cosAngle;
        
        // Add phase offset to shift the pattern
        const phasedY = rotatedY + this.linePhase;
        
        // Calculate distance from line centers
        const lineCenter = Math.floor(phasedY / this.lineSpacing) * this.lineSpacing;
        const distanceFromCenter = Math.abs(phasedY - lineCenter);
        
        // Use half-width for consistent thickness across all angles
        // Add 0.5 to ensure diagonal lines maintain consistent appearance
        const effectiveHalfWidth = this.lineWidth * 0.5 + 0.5;
        
        // Return true if within line width
        return distanceFromCenter < effectiveHalfWidth;
    }

    getGradientColor(x, y, gradientType, baseColor) {
        let intensity = 0;
        
        // Calculate base intensity based on gradient type
        switch (gradientType) {
            case 'gradient-linear':
            case 'gradient-linear-stipple':
            case 'gradient-linear-dither':
                // Linear gradient with angle and position
                const linearAngleRad = (this.gradientAngle * Math.PI) / 180;
                const cosAngle = Math.cos(linearAngleRad);
                const sinAngle = Math.sin(linearAngleRad);
                
                // Transform coordinates based on gradient center position
                const centerX = this.gradientPositionX * this.canvasWidth;
                const centerY = this.gradientPositionY * this.canvasHeight;
                const relativeX = x - centerX;
                const relativeY = y - centerY;
                
                // Project point onto gradient axis
                const projection = (relativeX * cosAngle + relativeY * sinAngle);
                
                // Simple linear mapping without steepness complications
                const maxSpan = Math.max(this.canvasWidth, this.canvasHeight) * 0.5;
                intensity = 0.5 + (projection / maxSpan);
                intensity = Math.max(0, Math.min(1, intensity));
                break;
                
            case 'gradient-radial':
            case 'gradient-radial-stipple':
            case 'gradient-radial-dither':
                // Simplified radial gradient
                const radialCenterX = this.radialPositionX * this.canvasWidth;
                const radialCenterY = this.radialPositionY * this.canvasHeight;
                
                const deltaX = x - radialCenterX;
                const deltaY = y - radialCenterY;
                const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
                
                // Simple radius calculation
                const maxRadius = Math.min(this.canvasWidth, this.canvasHeight) * this.radialRadius;
                
                intensity = Math.max(0, Math.min(1, 1 - (distance / maxRadius)));
                break;
                
            default:
                intensity = 0.5; // Default to middle intensity
                break;
        }
        
        // Handle stipple and dither variants
        if (gradientType.includes('stipple')) {
            return this.applyDithering(x, y, intensity, baseColor, 'ordered');
        } else if (gradientType.includes('dither')) {
            return this.applyDithering(x, y, intensity, baseColor, 'floyd-steinberg');
        }
        
        // Simple binary threshold - no smooth gradients
        if (baseColor === 'black') {
            return intensity > 0.5 ? '#000000' : '#ffffff';
        } else {
            return intensity > 0.5 ? '#ffffff' : '#000000';
        }
    }
}

// Mobile Interface Management
class MobileInterface {
    constructor(editor) {
        this.editor = editor;
        this.toolSettingsVisible = false;
        this.initializeDropdowns();
        this.initializeBottomToolbar();
        this.initializeToolSettings();
    }
    
    initializeDropdowns() {
        // Menu dropdown
        const menuBtn = document.getElementById('mobileMenuDropdown');
        const menuMenu = document.getElementById('mobileMainMenu');
        
        // Toggle menu dropdown
        menuBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            menuMenu?.classList.toggle('active');
            menuBtn?.classList.toggle('active');
        });
        
        // Close dropdown when clicking outside
        document.addEventListener('click', () => {
            menuMenu?.classList.remove('active');
            menuBtn?.classList.remove('active');
        });
        
        // Menu dropdown actions
        document.getElementById('mobileBackToMenu')?.addEventListener('click', () => {
            window.location.href = 'menu.html';
        });
        document.getElementById('mobileHelpBtn')?.addEventListener('click', () => document.getElementById('helpBtn')?.click());
        document.getElementById('mobileImportBtn')?.addEventListener('click', () => document.getElementById('importImageBtn')?.click());
        document.getElementById('mobileClearBtn')?.addEventListener('click', () => document.getElementById('clearCanvas')?.click());
        document.getElementById('mobileUndoBtn')?.addEventListener('click', () => document.getElementById('undoBtn')?.click());
        document.getElementById('mobileRedoBtn')?.addEventListener('click', () => document.getElementById('redoBtn')?.click());
        document.getElementById('mobileNewBtn')?.addEventListener('click', () => document.getElementById('newBtn')?.click());
        document.getElementById('mobileSaveBtn')?.addEventListener('click', () => document.getElementById('saveBtn')?.click());
        document.getElementById('mobileLoadBtn')?.addEventListener('click', () => document.getElementById('loadBtn')?.click());
        document.getElementById('mobileThemeBtn')?.addEventListener('click', () => {
            if (typeof toggleTheme === 'function') {
                toggleTheme();
            }
        });
        
        // Mobile panel toggle buttons for full-screen overlays
        document.getElementById('mobileToolsToggle')?.addEventListener('click', () => {
            const toolsPanel = document.getElementById('toolsPanel');
            const exportPanel = document.getElementById('exportPanel');
            const btn = document.getElementById('mobileToolsToggle');
            
            if (toolsPanel && btn) {
                // Close export panel if open
                exportPanel?.classList.remove('open');
                document.getElementById('mobileExportToggle')?.classList.remove('active');
                
                // Toggle tools panel
                const isOpen = toolsPanel.classList.contains('open');
                if (isOpen) {
                    toolsPanel.classList.remove('open');
                    btn.classList.remove('active');
                } else {
                    toolsPanel.classList.add('open');
                    btn.classList.add('active');
                }
            }
        });
        
        document.getElementById('mobileExportToggle')?.addEventListener('click', () => {
            const exportPanel = document.getElementById('exportPanel');
            const toolsPanel = document.getElementById('toolsPanel');
            const btn = document.getElementById('mobileExportToggle');
            
            if (exportPanel && btn) {
                // Close tools panel if open
                toolsPanel?.classList.remove('open');
                document.getElementById('mobileToolsToggle')?.classList.remove('active');
                
                // Toggle export panel
                const isOpen = exportPanel.classList.contains('open');
                if (isOpen) {
                    exportPanel.classList.remove('open');
                    btn.classList.remove('active');
                } else {
                    exportPanel.classList.add('open');
                    btn.classList.add('active');
                }
            }
        });
        
        // Close button handlers
        document.getElementById('toolsPanelClose')?.addEventListener('click', () => {
            document.getElementById('toolsPanel')?.classList.remove('open');
            document.getElementById('mobileToolsToggle')?.classList.remove('active');
        });
        
        document.getElementById('exportPanelClose')?.addEventListener('click', () => {
            document.getElementById('exportPanel')?.classList.remove('open');
            document.getElementById('mobileExportToggle')?.classList.remove('active');
        });
    }
    
    initializeBottomToolbar() {
        // Zoom controls
        document.getElementById('mobileZoomOut')?.addEventListener('click', () => {
            this.editor.setZoom(this.editor.zoom * 0.8);
            this.updateZoomDisplay();
        });
        
        document.getElementById('mobileZoomIn')?.addEventListener('click', () => {
            this.editor.setZoom(this.editor.zoom * 1.25);
            this.updateZoomDisplay();
        });
        
        // View controls
        document.getElementById('mobileFitBtn')?.addEventListener('click', () => {
            this.editor.fitToWindow();
            this.updateZoomDisplay();
        });
        
        document.getElementById('mobileCenterBtn')?.addEventListener('click', () => {
            this.editor.centerCanvas();
        });
        
        document.getElementById('mobileGridBtn')?.addEventListener('click', () => {
            this.editor.togglePixelGrid();
            // Update button appearance
            const gridBtn = document.getElementById('mobileGridBtn');
            if (gridBtn) {
                if (this.editor.showPixelGrid) {
                    gridBtn.style.background = 'var(--primary-color)';
                    gridBtn.style.color = 'white';
                } else {
                    gridBtn.style.background = 'var(--button-bg)';
                    gridBtn.style.color = 'var(--text-color)';
                }
            }
        });
        
        // Tool selection buttons
        const toolButtons = document.querySelectorAll('.mobile-tool-btn[data-tool]');
        toolButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const tool = btn.dataset.tool;
                this.selectTool(tool);
            });
        });
        
        // Mobile color toggle button
        const colorToggle = document.getElementById('mobileColorToggle');
        
        colorToggle?.addEventListener('click', () => {
            const currentColor = colorToggle.dataset.color;
            if (currentColor === 'black') {
                // Switch to white
                this.editor.currentColor = 'white';
                colorToggle.dataset.color = 'white';
                colorToggle.textContent = '⬜';
            } else {
                // Switch to black
                this.editor.currentColor = 'black';
                colorToggle.dataset.color = 'black';
                colorToggle.textContent = '⬛';
            }
        });
        
        // Initial state
        this.updateZoomDisplay();
    }
    
    initializeToolSettings() {
        const closeBtn = document.getElementById('closeToolSettings');
        closeBtn?.addEventListener('click', () => {
            this.hideToolSettings();
        });
        
        // Close tool settings when clicking outside
        document.addEventListener('click', (e) => {
            const popup = document.getElementById('toolSettingsPopup');
            if (popup && !popup.contains(e.target) && this.toolSettingsVisible) {
                this.hideToolSettings();
            }
        });
    }
    
    showToolSettings() {
        const popup = document.getElementById('toolSettingsPopup');
        const content = document.getElementById('toolSettingsContent');
        
        if (!popup || !content) return;
        
        // Generate settings content based on current tool
        content.innerHTML = this.generateToolSettingsContent();
        
        popup.style.display = 'block';
        this.toolSettingsVisible = true;
        
        // Close dropdowns
        this.closeDropdowns();
    }
    
    hideToolSettings() {
        const popup = document.getElementById('toolSettingsPopup');
        if (popup) {
            popup.style.display = 'none';
            this.toolSettingsVisible = false;
        }
    }
    
    generateToolSettingsContent() {
        const tool = this.editor.currentTool;
        
        switch (tool) {
            case 'pen':
                return `
                    <div class="mobile-tool-settings">
                        <h4>Brush Settings</h4>
                        <div class="setting-group">
                            <label>Size: <span id="mobileBrushSizeDisplay">${this.editor.brushSize || 1}</span>px</label>
                            <input type="range" id="mobileBrushSize" min="1" max="50" value="${this.editor.brushSize || 1}">
                        </div>
                        
                        <div class="setting-group">
                            <label>Shape:</label>
                            <div class="brush-shape-mobile">
                                <button class="mobile-brush-shape-btn ${(!this.editor.brushShape || this.editor.brushShape === 'square') ? 'active' : ''}" data-shape="square">⬜ Square</button>
                                <button class="mobile-brush-shape-btn ${this.editor.brushShape === 'circle' ? 'active' : ''}" data-shape="circle">⭕ Circle</button>
                            </div>
                        </div>
                        
                        <div class="setting-group">
                            <label>Color:</label>
                            <div class="mobile-color-picker">
                                <button class="mobile-color-btn ${this.editor.currentColor === 'black' ? 'active' : ''}" data-color="black">⬛ Black</button>
                                <button class="mobile-color-btn ${this.editor.currentColor === 'white' ? 'active' : ''}" data-color="white">⬜ White</button>
                            </div>
                        </div>
                    </div>
                `;
                
            case 'circle':
            case 'square':
                return `
                    <div class="mobile-tool-settings">
                        <h4>Shape Settings</h4>
                        <div class="setting-group">
                            <label>Color:</label>
                            <div class="mobile-color-picker">
                                <button class="mobile-color-btn ${(!this.editor.shapeColor || this.editor.shapeColor === 'black') ? 'active' : ''}" data-color="black">⬛ Black</button>
                                <button class="mobile-color-btn ${this.editor.shapeColor === 'white' ? 'active' : ''}" data-color="white">⬜ White</button>
                            </div>
                        </div>
                        
                        <div class="setting-group">
                            <label>Fill Style:</label>
                            <div class="mobile-fill-style">
                                <button class="mobile-fill-btn ${(!this.editor.shapeFillStyle || this.editor.shapeFillStyle === 'outline') ? 'active' : ''}" data-fill="outline">⬜ Outline</button>
                                <button class="mobile-fill-btn ${this.editor.shapeFillStyle === 'filled' ? 'active' : ''}" data-fill="filled">⬛ Filled</button>
                            </div>
                        </div>
                        
                        <div class="setting-group">
                            <label>Stroke Width: <span id="mobileShapeThicknessDisplay">${this.editor.shapeThickness || 1}</span>px</label>
                            <input type="range" id="mobileShapeThickness" min="1" max="50" value="${this.editor.shapeThickness || 1}">
                        </div>
                        
                        <div class="setting-group">
                            <label>Position:</label>
                            <div class="mobile-thickness-style">
                                <button class="mobile-style-btn ${(!this.editor.shapeThicknessStyle || this.editor.shapeThicknessStyle === 'outside') ? 'active' : ''}" data-style="outside">⊡ Outside</button>
                                <button class="mobile-style-btn ${this.editor.shapeThicknessStyle === 'inside' ? 'active' : ''}" data-style="inside">⊞ Inside</button>
                                <button class="mobile-style-btn ${this.editor.shapeThicknessStyle === 'centered' ? 'active' : ''}" data-style="centered">⊟ Centered</button>
                            </div>
                        </div>
                    </div>
                `;
                
            case 'bucket':
                return `
                    <div class="mobile-tool-settings">
                        <h4>Fill Settings</h4>
                        <div class="setting-group">
                            <label>Color:</label>
                            <div class="mobile-color-picker">
                                <button class="mobile-color-btn ${(!this.editor.fillColor || this.editor.fillColor === 'black') ? 'active' : ''}" data-color="black">⬛ Black</button>
                                <button class="mobile-color-btn ${this.editor.fillColor === 'white' ? 'active' : ''}" data-color="white">⬜ White</button>
                            </div>
                        </div>
                        
                        <div class="setting-group">
                            <label>Basic Patterns:</label>
                            <div class="mobile-pattern-grid">
                                <button class="mobile-pattern-btn ${(!this.editor.fillPattern || this.editor.fillPattern === 'solid') ? 'active' : ''}" data-pattern="solid">⬛ Solid</button>
                                <button class="mobile-pattern-btn ${this.editor.fillPattern === 'percentage' ? 'active' : ''}" data-pattern="percentage">▦ %</button>
                                <button class="mobile-pattern-btn ${this.editor.fillPattern === 'checkerboard' ? 'active' : ''}" data-pattern="checkerboard">▞ Check</button>
                                <button class="mobile-pattern-btn ${this.editor.fillPattern === 'lines' ? 'active' : ''}" data-pattern="lines">≡ Lines</button>
                                <button class="mobile-pattern-btn ${this.editor.fillPattern === 'clipboard' ? 'active' : ''}" data-pattern="clipboard">📋 Clip</button>
                                <button class="mobile-pattern-btn ${this.editor.fillPattern === 'dots' ? 'active' : ''}" data-pattern="dots">⋅ Dots</button>
                            </div>
                        </div>
                        
                        <div class="setting-group">
                            <label>Gradients:</label>
                            <div class="mobile-pattern-grid" style="grid-template-columns: 1fr 1fr;">
                                <button class="mobile-pattern-btn ${this.editor.fillPattern === 'gradient-linear' ? 'active' : ''}" data-pattern="gradient-linear">═ Linear</button>
                                <button class="mobile-pattern-btn ${this.editor.fillPattern === 'gradient-radial' ? 'active' : ''}" data-pattern="gradient-radial">◉ Radial</button>
                            </div>
                        </div>
                        
                        ${this.editor.fillPattern === 'percentage' ? `
                        <div class="setting-group">
                            <label>Fill Amount: <span id="mobilePercentageDisplay">${this.editor.percentageFill || 50}</span>%</label>
                            <input type="range" id="mobilePercentageFill" min="5" max="95" value="${this.editor.percentageFill || 50}" step="5">
                        </div>
                        ` : ''}
                        
                        ${this.editor.fillPattern === 'checkerboard' ? `
                        <div class="setting-group">
                            <label>Size: <span id="mobileCheckerboardSizeDisplay">${this.editor.checkerboardSize || 2}</span>px</label>
                            <input type="range" id="mobileCheckerboardSize" min="1" max="8" value="${this.editor.checkerboardSize || 2}" step="1">
                            <div class="mobile-checkbox">
                                <input type="checkbox" id="mobileCheckerboardInvert" ${this.editor.checkerboardInvert ? 'checked' : ''}>
                                <label for="mobileCheckerboardInvert">Invert Pattern</label>
                            </div>
                        </div>
                        ` : ''}
                        
                        ${this.editor.fillPattern === 'lines' ? `
                        <div class="setting-group">
                            <label>Angle: <span id="mobileLineAngleDisplay">${this.editor.lineAngle || 0}</span>°</label>
                            <input type="range" id="mobileLineAngle" min="0" max="180" value="${this.editor.lineAngle || 0}" step="15">
                            <label>Spacing: <span id="mobileLineSpacingDisplay">${this.editor.lineSpacing || 6}</span>px</label>
                            <input type="range" id="mobileLineSpacing" min="2" max="20" value="${this.editor.lineSpacing || 6}" step="1">
                        </div>
                        ` : ''}
                        
                        ${this.editor.fillPattern === 'dots' ? `
                        <div class="setting-group">
                            <label>Spacing: <span id="mobileDotsSpacingDisplay">${this.editor.dotsSpacing || 4}</span>px</label>
                            <input type="range" id="mobileDotsSpacing" min="2" max="16" value="${this.editor.dotsSpacing || 4}" step="1">
                            <label>Size: <span id="mobileDotsDisplay">${this.editor.dotsSize || 1}</span>px</label>
                            <input type="range" id="mobileDotsSize" min="1" max="4" value="${this.editor.dotsSize || 1}" step="1">
                        </div>
                        ` : ''}
                        
                        ${this.editor.fillPattern && this.editor.fillPattern.includes('gradient') ? `
                        <div class="setting-group">
                            <label>Style:</label>
                            <div class="mobile-pattern-grid">
                                <button class="mobile-pattern-btn ${(!this.editor.gradientVariant || this.editor.gradientVariant === 'stipple') ? 'active' : ''}" data-variant="stipple">⋅ Stipple</button>
                                <button class="mobile-pattern-btn ${this.editor.gradientVariant === 'dither' ? 'active' : ''}" data-variant="dither">▦ Dither</button>
                            </div>
                        </div>
                        ` : ''}
                    </div>
                `;
                
            case 'select':
                return `
                    <div class="mobile-tool-settings">
                        <h4>Edit Tools</h4>
                        <div class="setting-group">
                            <div class="mobile-edit-buttons">
                                <button class="mobile-edit-btn" id="mobileCopyBtn">📋 Copy</button>
                                <button class="mobile-edit-btn" id="mobilePasteBtn" ${!this.editor.clipboard ? 'disabled' : ''}>📋 Paste Mode</button>
                                <button class="mobile-edit-btn" id="mobileCutBtn">✂️ Cut</button>
                                <button class="mobile-edit-btn" id="mobileClearSelectionBtn">🗑️ Clear</button>
                            </div>
                        </div>
                        
                        <div class="setting-group">
                            <label>Rotation: <span id="mobileRotationAngleDisplay">0</span>°</label>
                            <input type="range" id="mobileRotationAngle" min="-180" max="180" value="0" step="15">
                            <div class="mobile-edit-buttons">
                                <button class="mobile-edit-btn" id="mobileRotateBtn">🔄 Rotate</button>
                                <button class="mobile-edit-btn" id="mobileResetRotationBtn">↺ Reset</button>
                            </div>
                        </div>
                    </div>
                `;
                
            default:
                return `
                    <div class="mobile-tool-settings">
                        <p>No settings available for ${tool} tool.</p>
                    </div>
                `;
        }
    }
    
    selectTool(tool) {
        this.editor.setTool(tool);
        this.updateToolButtons();
        this.closeDropdowns();
    }
    
    closeDropdowns() {
        document.querySelectorAll('.mobile-dropdown-content').forEach(menu => {
            menu.classList.remove('active');
        });
        document.querySelectorAll('.mobile-dropdown-btn').forEach(btn => {
            btn.classList.remove('active');
        });
    }

    updateToolSettingsContent() {
        const content = document.getElementById('mobileToolSettingsContent');
        if (!content) return;

        // Generate settings content based on current tool
        content.innerHTML = this.generateToolSettingsContent();
        
        // Add event listeners for the settings controls
        this.attachToolSettingsListeners();
    }

    attachToolSettingsListeners() {
        // Brush Settings (Pen Tool)
        const mobileBrushSize = document.getElementById('mobileBrushSize');
        if (mobileBrushSize) {
            mobileBrushSize.addEventListener('input', (e) => {
                this.editor.brushSize = parseInt(e.target.value);
                const display = document.getElementById('mobileBrushSizeDisplay');
                if (display) display.textContent = e.target.value;
                // Sync with desktop
                const desktopBrushSize = document.getElementById('brushSize');
                const desktopDisplay = document.getElementById('brushSizeDisplay');
                if (desktopBrushSize) desktopBrushSize.value = e.target.value;
                if (desktopDisplay) desktopDisplay.textContent = e.target.value;
            });
        }

        // Brush Shape (Pen Tool)
        document.querySelectorAll('.mobile-brush-shape-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.mobile-brush-shape-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.editor.brushShape = btn.dataset.shape;
                // Sync with desktop
                document.querySelectorAll('.brush-shape-btn').forEach(b => b.classList.remove('active'));
                document.querySelector(`[data-shape="${btn.dataset.shape}"]`)?.classList.add('active');
            });
        });

        // Color Picker (All Tools)
        document.querySelectorAll('.mobile-color-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const tool = this.editor.currentTool;
                document.querySelectorAll('.mobile-color-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                
                if (tool === 'pen') {
                    this.editor.currentColor = btn.dataset.color;
                    // Sync with desktop
                    document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
                    document.querySelector(`[data-color="${btn.dataset.color}"]`)?.classList.add('active');
                } else if (tool === 'bucket') {
                    this.editor.fillColor = btn.dataset.color;
                    // Sync with desktop
                    document.querySelectorAll('#bucketSettings .color-btn').forEach(b => b.classList.remove('active'));
                    document.querySelector(`#bucket${btn.dataset.color.charAt(0).toUpperCase() + btn.dataset.color.slice(1)}Color`)?.classList.add('active');
                } else if (tool === 'circle' || tool === 'square') {
                    this.editor.shapeColor = btn.dataset.color;
                    // Sync with desktop
                    document.querySelectorAll('#shapeSettings .color-btn').forEach(b => b.classList.remove('active'));
                    document.querySelector(`#shape${btn.dataset.color.charAt(0).toUpperCase() + btn.dataset.color.slice(1)}Color`)?.classList.add('active');
                }
            });
        });

        // Shape Fill Style
        document.querySelectorAll('.mobile-fill-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.mobile-fill-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.editor.shapeFillStyle = btn.dataset.fill;
                // Sync with desktop
                document.querySelectorAll('.fill-btn').forEach(b => b.classList.remove('active'));
                document.querySelector(`[data-fill="${btn.dataset.fill}"]`)?.classList.add('active');
            });
        });

        // Shape Thickness
        const mobileShapeThickness = document.getElementById('mobileShapeThickness');
        if (mobileShapeThickness) {
            mobileShapeThickness.addEventListener('input', (e) => {
                this.editor.shapeThickness = parseInt(e.target.value);
                const display = document.getElementById('mobileShapeThicknessDisplay');
                if (display) display.textContent = e.target.value;
                // Sync with desktop
                const desktopSlider = document.getElementById('shapeThicknessSlider');
                const desktopDisplay = document.getElementById('shapeThicknessDisplay');
                if (desktopSlider) desktopSlider.value = e.target.value;
                if (desktopDisplay) desktopDisplay.textContent = e.target.value;
            });
        }

        // Shape Thickness Style
        document.querySelectorAll('.mobile-style-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.mobile-style-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.editor.shapeThicknessStyle = btn.dataset.style;
                // Sync with desktop
                document.querySelectorAll('.style-btn').forEach(b => b.classList.remove('active'));
                document.querySelector(`[data-style="${btn.dataset.style}"]`)?.classList.add('active');
            });
        });

        // Fill Patterns (Bucket Tool)
        document.querySelectorAll('.mobile-pattern-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.mobile-pattern-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.editor.fillPattern = btn.dataset.pattern;
                // Sync with desktop
                document.querySelectorAll('.pattern-btn').forEach(b => b.classList.remove('active'));
                document.querySelector(`[data-pattern="${btn.dataset.pattern}"]`)?.classList.add('active');
            });
        });

        // Edit Actions (Select Tool)
        document.getElementById('mobileCopyBtn')?.addEventListener('click', () => {
            document.getElementById('copyBtn')?.click();
        });
        
        document.getElementById('mobilePasteBtn')?.addEventListener('click', () => {
            document.getElementById('pasteModeBtn')?.click();
        });
        
        document.getElementById('mobileCutBtn')?.addEventListener('click', () => {
            document.getElementById('cutBtn')?.click();
        });

        // Rotation
        const mobileRotationAngle = document.getElementById('mobileRotationAngle');
        if (mobileRotationAngle) {
            mobileRotationAngle.addEventListener('input', (e) => {
                const display = document.getElementById('mobileRotationAngleDisplay');
                if (display) display.textContent = e.target.value;
                // Sync with desktop
                const desktopRotation = document.getElementById('rotationAngle');
                const desktopDisplay = document.getElementById('rotationAngleDisplay');
                if (desktopRotation) desktopRotation.value = e.target.value;
                if (desktopDisplay) desktopDisplay.textContent = e.target.value;
            });
        }

        document.getElementById('mobileRotateBtn')?.addEventListener('click', () => {
            document.getElementById('rotateBtn')?.click();
        });

        document.getElementById('mobileResetRotationBtn')?.addEventListener('click', () => {
            document.getElementById('resetRotationBtn')?.click();
            // Update display
            const display = document.getElementById('mobileRotationAngleDisplay');
            const slider = document.getElementById('mobileRotationAngle');
            if (display) display.textContent = '0';
            if (slider) slider.value = '0';
        });

        // Fill Pattern Controls (Bucket Tool)
        
        // Gradient variants
        document.querySelectorAll('[data-variant]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('[data-variant]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.editor.gradientVariant = btn.dataset.variant;
            });
        });

        // Percentage Fill
        const mobilePercentageFill = document.getElementById('mobilePercentageFill');
        if (mobilePercentageFill) {
            mobilePercentageFill.addEventListener('input', (e) => {
                this.editor.percentageFill = parseInt(e.target.value);
                const display = document.getElementById('mobilePercentageDisplay');
                if (display) display.textContent = e.target.value;
                // Sync with desktop
                const desktopSlider = document.getElementById('percentageFillSlider');
                const desktopDisplay = document.getElementById('percentageDisplay');
                if (desktopSlider) desktopSlider.value = e.target.value;
                if (desktopDisplay) desktopDisplay.textContent = e.target.value;
            });
        }

        // Checkerboard
        const mobileCheckerboardSize = document.getElementById('mobileCheckerboardSize');
        if (mobileCheckerboardSize) {
            mobileCheckerboardSize.addEventListener('input', (e) => {
                this.editor.checkerboardSize = parseInt(e.target.value);
                const display = document.getElementById('mobileCheckerboardSizeDisplay');
                if (display) display.textContent = e.target.value;
                // Sync with desktop
                const desktopSlider = document.getElementById('checkerboardSize');
                const desktopDisplay = document.getElementById('checkerboardSizeDisplay');
                if (desktopSlider) desktopSlider.value = e.target.value;
                if (desktopDisplay) desktopDisplay.textContent = e.target.value;
            });
        }

        const mobileCheckerboardInvert = document.getElementById('mobileCheckerboardInvert');
        if (mobileCheckerboardInvert) {
            mobileCheckerboardInvert.addEventListener('change', (e) => {
                this.editor.checkerboardInvert = e.target.checked;
                // Sync with desktop
                const desktopCheckbox = document.getElementById('checkerboardInvert');
                if (desktopCheckbox) desktopCheckbox.checked = e.target.checked;
            });
        }

        // Line Pattern
        const mobileLineAngle = document.getElementById('mobileLineAngle');
        if (mobileLineAngle) {
            mobileLineAngle.addEventListener('input', (e) => {
                this.editor.lineAngle = parseInt(e.target.value);
                const display = document.getElementById('mobileLineAngleDisplay');
                if (display) display.textContent = e.target.value;
                // Sync with desktop
                const desktopSlider = document.getElementById('lineAngle');
                const desktopDisplay = document.getElementById('lineAngleDisplay');
                if (desktopSlider) desktopSlider.value = e.target.value;
                if (desktopDisplay) desktopDisplay.textContent = e.target.value + '°';
            });
        }

        const mobileLineSpacing = document.getElementById('mobileLineSpacing');
        if (mobileLineSpacing) {
            mobileLineSpacing.addEventListener('input', (e) => {
                this.editor.lineSpacing = parseInt(e.target.value);
                const display = document.getElementById('mobileLineSpacingDisplay');
                if (display) display.textContent = e.target.value;
                // Sync with desktop
                const desktopSlider = document.getElementById('lineSpacing');
                const desktopDisplay = document.getElementById('lineSpacingDisplay');
                if (desktopSlider) desktopSlider.value = e.target.value;
                if (desktopDisplay) desktopDisplay.textContent = e.target.value + 'px';
            });
        }

        // Dots Pattern
        const mobileDotsSpacing = document.getElementById('mobileDotsSpacing');
        if (mobileDotsSpacing) {
            mobileDotsSpacing.addEventListener('input', (e) => {
                this.editor.dotsSpacing = parseInt(e.target.value);
                const display = document.getElementById('mobileDotsSpacingDisplay');
                if (display) display.textContent = e.target.value;
                // Sync with desktop
                const desktopSlider = document.getElementById('dotsSpacing');
                const desktopDisplay = document.getElementById('dotsSpacingDisplay');
                if (desktopSlider) desktopSlider.value = e.target.value;
                if (desktopDisplay) desktopDisplay.textContent = e.target.value + 'px';
            });
        }

        const mobileDotsSize = document.getElementById('mobileDotsSize');
        if (mobileDotsSize) {
            mobileDotsSize.addEventListener('input', (e) => {
                this.editor.dotsSize = parseInt(e.target.value);
                const display = document.getElementById('mobileDotsDisplay');
                if (display) display.textContent = e.target.value;
                // Sync with desktop
                const desktopSlider = document.getElementById('dotsSize');
                const desktopDisplay = document.getElementById('dotsSizeDisplay');
                if (desktopSlider) desktopSlider.value = e.target.value;
                if (desktopDisplay) desktopDisplay.textContent = e.target.value + 'px';
            });
        }
    }
    
    updateToolButtons() {
        const toolButtons = document.querySelectorAll('.mobile-tool-btn[data-tool]');
        toolButtons.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tool === this.editor.currentTool);
        });
    }
    
    updateZoomDisplay() {
        const zoomDisplay = document.getElementById('mobileZoomDisplay');
        if (zoomDisplay) {
            zoomDisplay.textContent = Math.round(this.editor.zoom * 100) + '%';
        }
    }
}

// Sidebar toggle functionality
function initializeSidebarToggles() {
    const leftToggle = document.getElementById('leftToggle');
    const rightToggle = document.getElementById('rightToggle');
    const toolsPanel = document.getElementById('toolsPanel');
    const exportPanel = document.getElementById('exportPanel');
    const editorLayout = document.querySelector('.editor-layout');
    
    leftToggle.addEventListener('click', () => {
        toolsPanel.classList.toggle('collapsed');
        leftToggle.classList.toggle('collapsed');
        editorLayout.classList.toggle('left-collapsed');
    });
    
    rightToggle.addEventListener('click', () => {
        exportPanel.classList.toggle('collapsed');
        rightToggle.classList.toggle('collapsed');
        editorLayout.classList.toggle('right-collapsed');
    });
}

// Initialize the drawing editor when the page loads
document.addEventListener('DOMContentLoaded', () => {
    const editor = new DrawingEditor();
    
    // Initialize sidebar toggles
    initializeSidebarToggles();
    
    // Initialize mobile interface if on mobile
    if (window.innerWidth <= 768) {
        new MobileInterface(editor);
    }
});
