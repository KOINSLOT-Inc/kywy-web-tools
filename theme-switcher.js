// Theme Switcher for Kywy Web Tools
class ThemeSwitcher {
    constructor() {
        this.themes = [
            {
                name: 'Original',
                id: 'original',
                stylesheets: [] // Uses original CSS files only
            },
            {
                name: 'Windows 95',
                id: 'windows95',
                stylesheets: ['windows95-cosmetic.css']
            },
            {
                name: 'Original Dark',
                id: 'dark',
                stylesheets: ['dark-theme.css']
            },
            {
                name: 'Apple II',
                id: 'apple2',
                stylesheets: ['apple2-theme.css']
            },
            {
                name: 'NES',
                id: 'nes',
                stylesheets: ['nes-theme.css']
            },
            {
                name: 'AMIGA',
                id: 'amiga',
                stylesheets: ['amiga-theme.css']
            },
            {
                name: 'Windows XP',
                id: 'windowsxp',
                stylesheets: ['windowsxp-theme.css']
            }
            // Future themes can be added here
        ];
        
        this.currentThemeIndex = this.loadCurrentTheme();
        this.themeStylesheets = [];
        
        this.init();
    }
    
    init() {
        this.createThemeButton();
        this.applyTheme(this.currentThemeIndex);
    }
    
    createThemeButton() {
        // Find a good place to add the theme button
        const navBar = document.querySelector('.nav-bar');
        const headerActions = document.querySelector('.nav-actions');
        const taskbarTheme = document.querySelector('.taskbar-theme');
        
        if (taskbarTheme) {
            // For menu page - add to taskbar
            const themeButton = document.createElement('button');
            themeButton.id = 'themeButton';
            themeButton.className = 'theme-btn';
            themeButton.innerHTML = '🎨';
            themeButton.title = 'Cycle through themes';
            
            themeButton.addEventListener('click', () => {
                this.cycleTheme();
            });
            
            taskbarTheme.appendChild(themeButton);
            this.updateButtonText(themeButton);
        } else if (navBar || headerActions) {
            // For other pages - add to nav area
            const themeButton = document.createElement('button');
            themeButton.id = 'themeButton';
            themeButton.className = 'nav-btn theme-btn';
            themeButton.innerHTML = '🎨 Theme';
            themeButton.title = 'Cycle through themes';
            
            themeButton.addEventListener('click', () => {
                this.cycleTheme();
            });
            
            // Add to nav actions if available, otherwise to nav bar
            const container = headerActions || navBar;
            container.appendChild(themeButton);
            
            // Update button text to show current theme
            this.updateButtonText(themeButton);
        }
    }
    
    cycleTheme() {
        this.currentThemeIndex = (this.currentThemeIndex + 1) % this.themes.length;
        this.applyTheme(this.currentThemeIndex);
        this.saveCurrentTheme();
        
        // Update button text
        const themeButton = document.getElementById('themeButton');
        if (themeButton) {
            this.updateButtonText(themeButton);
        }
    }
    
    updateButtonText(button) {
        const currentTheme = this.themes[this.currentThemeIndex];
        const isTaskbarButton = button.parentElement && button.parentElement.classList.contains('taskbar-theme');
        
        if (isTaskbarButton) {
            // For taskbar button, just show icon and theme name on hover
            button.innerHTML = '🎨';
            button.title = `Theme: ${currentTheme.name}. Click to cycle themes.`;
        } else {
            // For nav button, show full text
            button.innerHTML = `🎨 ${currentTheme.name}`;
            button.title = `Current theme: ${currentTheme.name}. Click to cycle themes.`;
        }
    }
    
    applyTheme(themeIndex) {
        const theme = this.themes[themeIndex];
        
        // Remove existing theme stylesheets
        this.removeThemeStylesheets();
        
        // Apply new theme stylesheets
        theme.stylesheets.forEach(stylesheet => {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = stylesheet;
            link.className = 'theme-stylesheet';
            document.head.appendChild(link);
            this.themeStylesheets.push(link);
        });
        
        // Store theme info on document for CSS to access
        document.documentElement.setAttribute('data-theme', theme.id);
    }
    
    removeThemeStylesheets() {
        this.themeStylesheets.forEach(link => {
            if (link.parentNode) {
                link.parentNode.removeChild(link);
            }
        });
        this.themeStylesheets = [];
        
        // Also remove any existing theme stylesheets in the DOM
        document.querySelectorAll('.theme-stylesheet').forEach(link => {
            if (link.parentNode) {
                link.parentNode.removeChild(link);
            }
        });
    }
    
    saveCurrentTheme() {
        try {
            localStorage.setItem('kywy-theme', this.currentThemeIndex.toString());
        } catch (e) {
            // Silently fail if localStorage is not available
        }
    }
    
    loadCurrentTheme() {
        try {
            const saved = localStorage.getItem('kywy-theme');
            if (saved !== null) {
                const themeIndex = parseInt(saved, 10);
                if (themeIndex >= 0 && themeIndex < this.themes.length) {
                    return themeIndex;
                }
            }
        } catch (e) {
            // Silently fail if localStorage is not available
        }
        
        // Check if Windows 95 CSS is already loaded (for backward compatibility)
        const existingWin95 = document.querySelector('link[href*="windows95-cosmetic.css"]');
        return existingWin95 ? 1 : 0; // Default to Windows 95 if already loaded, otherwise Original
    }
    
    // Method to add new themes dynamically
    addTheme(name, id, stylesheets) {
        this.themes.push({
            name: name,
            id: id,
            stylesheets: stylesheets
        });
    }
}

// Auto-initialize when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    // Small delay to ensure other scripts have loaded
    setTimeout(() => {
        if (!window.themeSwitcher) {
            window.themeSwitcher = new ThemeSwitcher();
        }
    }, 100);
});

// Also initialize if DOM is already loaded
if (document.readyState === 'loading') {
    // DOM is still loading
} else {
    // DOM is already loaded
    setTimeout(() => {
        if (!window.themeSwitcher) {
            window.themeSwitcher = new ThemeSwitcher();
        }
    }, 100);
}
