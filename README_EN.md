# TETHERACT pm (Tetheract Photo Manager)

[日本語](README.md) | English

> **📢 Rebranding Notice (Formerly: Photo Manager)**  
> Starting with `v1.0.0`, Photo Manager has been renamed to **TETHERACT pm (Tetheract Photo Manager)**—combining the 4D hypercube (**Tesseract**) from *Interstellar* with **Tether** (linking memories across time and drives). Existing databases (`cache/`) and photos carry over seamlessly when updating.

A local, non-destructive photo viewer and culling tool for Windows, inspired by Picasa and Tiat.  
Browse, compare, and organize large collections of photos (JPEG, PNG, WebP, HEIC, and camera RAW files) smoothly without modifying a single byte of your original files or folder structure.

To try it right away, download the latest ZIP from [GitHub Releases](../../releases), extract it, and run `Tetheract.exe` (no installation required).

![Workflow Demo (One-handed rating, layout & theme toggle, RAW Lightbox, burst frame flip, and 2-Up Duel comparison)](docs/images/demo_workflow.webp)

| Masonry View (Aspect-ratio preserved & Burst Stack) | Slide Mount View (Film Slide Frame Mode) | 2-Up Side-by-Side Duel & RGB Histograms |
| :---: | :---: | :---: |
| ![Masonry View](docs/images/screenshot_masonry.png) | ![Slide Mount View](docs/images/screenshot_mount.png) | ![2-Up Duel Comparison](docs/images/screenshot_compare.png) |

---

> [!NOTE]
> Read Me First (Development Stance & Data Safety)
>
> - 100% "Vibe Coding" (Built by Asking AI): Every line of code was written by AI, so I (the author) have zero knowledge of how the code inside works lol. Please don't ask technical code questions because I genuinely have no idea.
> - Personal Hobby Project: Built for my own photography workflow. Feature requests and bug reports are welcome for reference, though whether they get fixed depends on the AI's mood. Please use it with a relaxed "lucky if it fits my workflow" mindset.
> - Real-Time `JP` / `EN` Toggle (Though My English is Zero): I rely 100% on machine translation if you talk to me in English lol. Click the top `JP` / `EN` button to switch the UI and built-in Help into English anytime.
> - 100% Non-Destructive: Original photo files in your folders are never modified, moved, or deleted. If the app isn't for you, simply delete the folder and your PC and photo directories remain completely untouched.

---

## Features

### 1. Flexible Classification and Search, Independent of Where Photos Are Stored.
No need to reorganize folders or import files into a proprietary library. Keep your existing directory structure across multiple drives while freely grouping and subtracting photos using tags and EXIF metadata.

- Cross-Drive Browsing: Browse and search across internal and external drives while keeping your existing folder hierarchy intact.
- Tag & Gear Include `[+]` / Exclude `[-]` Search: Combine include `[+]` and exclude `[-]` conditions across hierarchical tags and the "Camera > Lens" tree (OR within the same root group, AND across groups, toggleable in one click).
- Natural-Language Filter Bar: Summarizes active filters at the bottom of the screen with click-to-edit popovers for sibling tags and same-month selection across years.
- Multi-Axis Filtering & Binder Presets: Filter by Date (with calendar view), Location (Country > State/Prefecture > City), 12-Color Palette, Format, and 4-Tier Rating, sort by EXIF parameters, and save filter combinations in `Binder`.
- Photography Lab & Map Insights: Explore your 47-prefecture footprint map, heatmaps, walk trajectories, "Winning Lens Chart" based on keeper rates, and solar-angle Golden/Blue Hour extraction.

### 2. Never Touch or Break Original Files — Yet Go Beyond Just Viewing.
Your original files and photo folders are never touched, and no hidden management files are created inside them. Within that strict boundary, you can cull, adjust, and export in one continuous workflow.

- Zero Writes to Original Files or Folders: Rotating, adjusting, tagging, or rejecting photos never modifies original files. All records stay inside a single database (`cache/library.db`) within the app folder.
- Non-Destructive Rotate, Straighten, Crop & Tone: Apply 90° rotations, horizon leveling (±45°), aspect-ratio cropping, and exposure/contrast/saturation edits with a live histogram and batch copy/paste.
- Capture Time Shift & Phone GPS Copy: Batch-offset capture timestamps to fix camera clock drift or timezones (with one-click EXIF restore), and copy GPS coordinates from smartphone photos taken within ±1 hour.
- XMP Sidecar Reading: Read existing `.xmp` / `.pp3` / `.dop` sidecars without modifying them, preview adjustments, and import ratings and hierarchical keywords into an isolated `XMP/...` branch.
- Flexible Export: Batch-export with "Smart Takeout" (applying edits, resizing, sequential renaming, EXIF stripping, and optional `.xmp` output), generate darkroom-style "Contact Sheet HTML", or copy images to the clipboard (<kbd>Ctrl</kbd>+<kbd>C</kbd>).
- Managed Vault "Loome" (`Loome/` & External `<Drive>:\Loome`): Copy only the specific photos you want to physically reorganize into `Loome` to move across subfolders or batch-rename (<kbd>F2</kbd>) while paired RAW and `.xmp` files follow automatically.

### 3. A Quiet Look & Feel That Stays Out of Your Way.
A visually quiet interface where photo colors stand out naturally, designed for smooth keyboard-driven culling with minimal eye movement.

- Quiet Interface & 4 Themes: Free of noisy emojis, featuring 4 presets (`Tetheract D / L` champagne monotone, `Urusi` dark, and `Washi` light) plus instant `JP` / `EN` switching.
- Three Grid Layouts: Switch between Standard Grid, aspect-ratio Masonry view, and film-frame Slide Mount view. Hide text overlays (<kbd>I</kbd> key) or collapse panels to maximize space.
- Fast Viewing for Foveon (`X3F`) & Camera RAWs: Supports SIGMA (`X3F`), Canon, Nikon, Sony, Fujifilm, Panasonic, Olympus, Pentax, `DNG`, and more, prioritizing embedded previews for instant viewing in camera-original colors.
- Smart Stacks for Bursts & Brackets: Automatically groups bursts, exposure brackets (AEB), RAW+JPG pairs, and duplicates (prioritizing the highest-rated shot as the cover). Flip frames with <kbd>↑</kbd> <kbd>↓</kbd> in Lightbox and switch cover shots easily.
- One-Handed Rating & 2-Up Duel: Rate with number keys (<kbd>1</kbd>: Ex / <kbd>2</kbd>: Gd / <kbd>3</kbd>: Rj / <kbd>0</kbd>: Nm), or compare two contenders side-by-side (<kbd>V</kbd> key) with synchronized zoom and knockout selection (<kbd>W</kbd> key).
- Separation of Daily Tagging and Tree Editing: Daily tagging stays in the right Inspector, while moving, renaming, and deleting tag hierarchies are isolated in a dedicated Settings editor to prevent accidental edits.

### 4. No Reliance on the Cloud — Yet Fully Portable.
Every feature runs locally offline. Place the folder on an external SSD or USB drive to carry your entire environment across PCs and smartphones.

- 100% Local Execution: Never uploads photos or loads external CDNs (only map tiles connect to OpenStreetMap). Local AI auto-tagging (CLIP & color re-evaluation) and offline GPS reverse geocoding run entirely on your PC.
- No Installation Required: The portable Python runtime and SQLite database live in a single folder, launching directly via `Tetheract.exe` on any PC. Updates require only overwriting with a lightweight diff ZIP.
- Multi-SD Card & Drive Tracking by VSN: Tracks Volume Serial Numbers (VSN) to follow drive-letter changes automatically and distinguish multiple SD cards even on the same drive letter. Ratings, tags, and edits made on an SD card automatically carry over when files are moved to your PC.
- Unplugged Browsing & Smartphone Culling: Browse thumbnails, search, and rate even when external drives are unplugged. Cull on your phone via home Wi-Fi (QR token) or offline USB (WebAssembly) and sync changes back to your PC.

---

## Keyboard Shortcuts

| Key | Action |
| :--- | :--- |
| <kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd> (<kbd>X</kbd>) / <kbd>0</kbd> | Set rating (<kbd>1</kbd>: Ex / <kbd>2</kbd>: Gd / <kbd>3</kbd>: Rj / <kbd>0</kbd>: Nm / Clear) |
| <kbd>Space</kbd> / <kbd>Enter</kbd> | Open / close Lightbox view |
| <kbd>←</kbd> <kbd>→</kbd> <kbd>↑</kbd> <kbd>↓</kbd> | Navigate photos (in Lightbox, <kbd>↑</kbd> <kbd>↓</kbd> switches frames inside a stack) |
| <kbd>V</kbd> / <kbd>W</kbd> | Open 2-Up Duel comparison / Keep right photo as winner |
| <kbd>C</kbd> / <kbd>H</kbd> | Open Crop / Straighten / Tone modal / Toggle histogram |
| <kbd>R</kbd> / <kbd>L</kbd> | Rotate 90° clockwise / Rotate 90° counter-clockwise |
| <kbd>F2</kbd> | Rename file (single or batch sequential rename in `Loome`) |
| <kbd>[</kbd> (<kbd>B</kbd>) / <kbd>D</kbd> / <kbd>I</kbd> | Toggle left menu / Toggle right inspector / Toggle thumbnail text overlay |

---

## Download & How to Run

### Option A: Release ZIP Package (Portable Python Included)

No prior Python installation is required.

1. First-Time Setup (Full Package `Tetheract_vX.X.X.zip`): Extract the ZIP and run `Tetheract.exe`.
2. Updating (Lightweight Diff `Tetheract_vX.X.Xdiff.zip`): Extract and overwrite your existing folder to update while keeping `cache/` and `Loome/` (`storage/`) intact.

> [!NOTE]
> Upgrading from Photo Manager v3.x
> - Legacy `PhotoManager.exe` and `PhotoManager_Mobile.html` are automatically cleaned up when launching `Tetheract.exe`.
> - A pre-migration DB snapshot is saved to `cache/backups/` on first launch, and backward compatibility with v3.x is preserved.
> - If you use `autorun.inf` on a USB root, delete the existing `autorun.inf` and re-run `Build.bat` to regenerate it with the new icon and `TETHERACT pm` label.

> [!IMPORTANT]
> If Windows Defender SmartScreen Appears on First Launch
> Because this personal project does not use a commercial code-signing certificate, SmartScreen may appear on first launch:
> 1. Run directly: Click "More info" → "Run anyway".
> 2. Build locally: Double-click `Build.bat` to compile `Tetheract.exe` locally from plain-text source ([`launcher/Launcher.cs`](launcher/Launcher.cs)) using the standard Windows C# compiler.

### Option B: Cloning from GitHub

Run these two steps once on first setup (no system Python installation required):

1. Run `setup_portable_python.bat` (requires internet): Downloads Embeddable Python 3.11 and required packages into `python/`.
2. Run `Build.bat`: Compiles `Tetheract.exe` and launches the app.

---

## Future Outlook

While there is no fixed schedule for this hobby project, the following ideas are being considered under the same offline, non-destructive design:

- Visual Similarity Search: Find photos with similar composition, color tone, or mood using local AI analysis.
- Focus Peaking Highlight: Highlight sharp in-focus edges during Lightbox and 2-Up Duel comparison.
- GPS Logger (`.gpx`) Matching: Match `.gpx` track logs against capture timestamps non-destructively.
- Direct Handoff to External RAW Editors: Pass selected photos or paired RAWs to external RAW developers via a shortcut.
- Mat Frame & Subtle EXIF Export: Export photos with a clean mat border and minimal camera/exposure text.

---

## Documentation

- [User Manual (`MANUAL.md`)](MANUAL.md): Complete guide covering basic culling, exclusive search, non-destructive edits, and mobile/USB workflows (also accessible in-app via <kbd>F1</kbd>).
- [USB Portable Guide (`README_USB.md`)](README_USB.md): Instructions for external drive portability and smartphone sync.
- [Architecture & Technical Notes (`docs/knowledge/`)](docs/knowledge/README.md): Design records for SQLite BLOB storage, WebAssembly sync, and UI design.

---

## License

Source code is released under the [MIT License](LICENSE) on an "AS IS" basis without warranty.  
When redistributing or modifying, please comply with the licenses of all bundled libraries (Python, FastAPI, Pillow, LibRaw / rawpy [LGPL 2.1], pystray [LGPL 3.0], ONNX Runtime, sql.js, etc.) and offline geocoding datasets (Code for Fukui, GeoNames, etc.). Full notices and license texts are in [`LICENSES/NOTICE.txt`](LICENSES/NOTICE.txt) and [`LICENSES/`](LICENSES) (keep LibRaw in `rawpy` dynamically linked as DLLs under LGPL 2.1; do not statically bundle into a single file).
