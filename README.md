# Kywy Web Tools Suite

A collection of professional web-based tools for creating and converting images, drawings, and animations for the Kywy display library.

🌐 **Live Demo**: [https://koinslot-inc.github.io/kywy-web-tools/](https://koinslot-inc.github.io/kywy-web-tools/)

*Last updated: September 2025 - Now with enhanced drawing editor features!*

## License

This project is licensed under the BSD 3-Clause License - see the [LICENSE](LICENSE) file for details.

## Tools

### 🔄 Image Converter
Convert images to binary HPP format for Kywy displays.
- **Dithering algorithms** (Floyd-Steinberg, Atkinson, Ordered)
- **Auto adjustments** for brightness, contrast, and threshold
- **Edge detection** for outline effects
- **Live preview** with scale controls

### ✏️ Drawing Editor  
Create pixel-perfect black and white drawings with advanced features.
- **Multi-frame animation** with onion skinning
- **Copy & paste** support with selection tools
- **Professional drawing tools** (brush, eraser, fill)
- **Real-time code generation** for animations

### 🎞️ Animation Generator
Generate multi-frame animations from image sequences.
- **Image sequence import** 
- **SpriteSheet export** for C++/Arduino
- **Frame management** with preview player
- **Automated frame timing**

## Usage

1. Open `index.html` in your web browser
2. Select the tool you need from the main menu
3. Follow the tool-specific interface to create or convert content
4. Copy the generated C++ code for use in your Kywy projects

## Integration

All tools generate code compatible with the [Kywy Display Library](https://github.com/KOINSLOT-Inc/kywy) for 144×168 monochrome displays.

```cpp
#include "Kywy.hpp"

Kywy::Engine engine;

void setup() {
    engine.start();
    engine.display.drawBitmap(0, 0, width, height, bitmap_data);
    engine.display.update();
}
```

## Development

- Pure HTML5, CSS3, and JavaScript - no dependencies
- Responsive design for desktop and tablet use
- Professional UI with KOINSLOT branding
- Optimized for production deployment

---

**Made for the Kywy ecosystem** | [KOINSLOT, Inc.](https://github.com/KOINSLOT-Inc)
