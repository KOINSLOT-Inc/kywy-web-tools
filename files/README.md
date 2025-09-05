# UF2 Files Directory

This directory contains UF2 files automatically synced from GitHub releases.

Files are organized as:
```
files/
├── KOINSLOT-Inc/kywy/
│   ├── v1.16.0/
│   │   ├── program1.uf2
│   │   └── program2.uf2
│   └── v1.15.0/
│       └── program3.uf2
├── releases.json (metadata)
└── index.html (browsable index)
```

## Auto-sync Process

- Runs daily at 2 AM UTC via GitHub Actions
- Downloads latest UF2 files from configured repositories  
- Creates metadata file for the web interface
- Only downloads new/changed files (size-based deduplication)
- Provides CORS-free access for the uploader tool

## Benefits

- ✅ No CORS issues (same-domain access)
- ✅ Faster loading (no GitHub API calls)
- ✅ Offline-capable after initial load
- ✅ Automatic updates without manual intervention
- ✅ Direct upload capability (no download fallback needed)
