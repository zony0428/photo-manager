# Tetheract Photo Manager

[日本語](README.md) | English

> **📢 Rebranding Notice (Formerly: Photo Manager)**  
> Starting with `v1.0.0`, **Photo Manager** (up to v3.x) has been officially renamed to **Tetheract Photo Manager**.  
> Inspired by the 4D hypercube (**Tesseract**) in the film *Interstellar*—where moments across time and space are connected—combined with **Tether** (to link and preserve your memories across drives and locations): **Tesseract ⇒ Tetheract**. Existing databases (`cache/`) and photos carry over seamlessly when updating.

A local, non-destructive photo viewer and culling tool for Windows, inspired by Picasa and Tiat.  
Browse, compare, and organize large collections of photos (JPEG, PNG, WebP, HEIC, and RAW files from major camera brands) smoothly, without modifying a single byte of your original files or folder structure.

To try it right away, download the latest ZIP from [GitHub Releases](../../releases), extract it to any folder, and run `Tetheract.exe` (no installation required).

![Workflow Demo (One-handed rating, layout & theme toggle, RAW Lightbox, burst frame flip, and 2-Up Duel comparison)](docs/images/demo_workflow.webp)

| Masonry View (Aspect-ratio preserved & Burst Stack) | Slide Mount View (Film Slide Frame Mode) | 2-Up Side-by-Side Duel & RGB Histograms |
| :---: | :---: | :---: |
| ![Masonry View](docs/images/screenshot_masonry.png) | ![Slide Mount View](docs/images/screenshot_mount.png) | ![2-Up Duel Comparison](docs/images/screenshot_compare.png) |

---

> [!NOTE]
> Read Me First (Development Stance & Data Safety)
>
> - 100% "Vibe Coding" — Built Entirely by Asking AI:  
>   Every line of code in this application was written by AI. I (the author) have zero knowledge of how the code inside actually works lol. Please don't ask me technical questions like "How does line X work?" because I genuinely have no idea.
> - Personal Hobby Project (About Feature Requests & Issues):  
>   This software is built for my own personal photography workflow. While I happily read feature requests and bug reports for reference, whether they actually get implemented or fixed depends on the AI's mood. Please use it with a relaxed "lucky if it works for my workflow as-is" mindset. That said, whenever I have free time, I'm constantly pestering the AI to add new features and polish things up.
> - Real-Time `JP` / `EN` UI Toggle Included (Though My English Skill is Zero):  
>   I am a Japanese developer with zero English skills. If you talk to me in English, I will rely 100% on machine translation and might sound a bit odd. However, clicking the `JP` / `EN` button in the top header switches the entire UI, tooltips, and the built-in Help Manual into English in real time (also 100% AI-generated lol).
> - Your Original Photo Files & Folders Are Never Modified (100% Non-Destructive & Read-Only):  
>   Although the code is written by AI, one strict rule is enforced throughout: your original photo files in your folders are never modified, moved, or deleted by even a single byte. If you decide the app isn't for you, simply delete the Tetheract Photo Manager folder and your PC environment and photo folders remain completely untouched.

---

## Features & Design Philosophy

### 1. Flexible Classification and Search, Independent of Where Photos Are Stored.
Over the years, photos naturally spread across internal drives and external SSDs, and reorganizing folders or importing everything into a proprietary library just to suit a management app is a burden. Tetheract Photo Manager is designed so you can keep your existing folders and storage locations as they are, while freely grouping, combining, and subtracting photos across drives using tags and shooting metadata.

- Cross-Drive Browsing Without Moving Folders: Browse and search across internal drives and multiple external drives while keeping your existing directory structure intact.
- Hierarchical Tag & Gear Include `[+]` / Exclude `[-]` Search: Combine include `[+]` and exclude `[-]` conditions across hierarchical tags and the "Camera > Lens" tree. Sibling tags under the same top-level parent combine with `OR`, while different top-level groups combine with `AND`, making it easy to subtract unwanted sub-tags or spot untagged photos.
- Floating Natural-Language Filter Bar & Trail Markers: While filters are active, a bottom floating bar summarizes your query in natural language with click-to-edit popovers for sibling tags and same-month selection across years. Collapsed parent nodes display dashed borders and count badges (`+1` / `-1`) to indicate active sub-filters.
- Multi-Axis Filtering, Sorting & Presets: Filter by Date Taken, Location (Country > State/Prefecture > City), 12-Color Palette, Format/Attribute (RAW / JPEG Only / RAW+JPG Pair / Edited / Has XMP), and 4-Tier Rating, sort by EXIF parameters (Focal Length, Aperture, Shutter Speed, ISO), and save frequent combinations as Filter Presets.
- Photography Lab & Map Insights: Explore your 47-prefecture footprint map, density heatmaps, chronological walk trajectories, "Winning Lens & Sweet-Spot Chart" based on high-rated keeper rates, solar-angle Golden/Blue Hour extraction, "On This Day", and random unrated folder Gacha.

### 2. Never Touch or Break Original Files — Yet Go Beyond Just Viewing.
No one wants an application to silently alter original RAW/JPEG files or scatter hidden management and sidecar files inside photo folders. At the same time, a viewer that only displays images forces you to open another editor just to fix a tilted horizon, crop, shift a camera clock, or export. Tetheract Photo Manager strictly preserves your original files and folders untouched while handling culling, non-destructive adjustments, export, and optional file organization in one continuous workflow.

- Zero Writes to Original Files or Photo Folders: Rotating, adjusting, tagging, shifting timestamps, or marking photos as "Rj (Reject)" never modifies or deletes your original files. All records are stored solely inside a single database (`cache/library.db`) within the app folder.
- Non-Destructive Rotate, Straighten, Crop & Tone: Apply 90° rotations, fine horizon leveling (±45°), aspect-ratio cropping, and brightness/contrast/saturation adjustments (linked with a live RGB & Luminance histogram), complete with instant before/after comparison and batch copy/paste.
- Capture Time Shift & Smartphone GPS Copy: Batch-offset capture timestamps to fix camera clock drift or travel timezones (with one-click reset to original EXIF), and non-destructively copy GPS coordinates from smartphone photos taken within ±1 hour.
- Non-Destructive XMP Sidecar Integration: Read existing `.xmp`, `.pp3`, or `.dop` sidecars exported by Lightroom or other RAW developers without modifying them, compare adjustments via the "XMP Preview" button, and import XMP ratings and hierarchical keywords into an isolated `XMP/...` branch.
- Flexible Export Options: Batch-export with "Smart Takeout" (applying edits, resizing, sequential capture-order renaming, EXIF stripping, and optional `.xmp` output), generate darkroom-style "Contact Sheet HTML" with red grease-pencil marks and A4 print layout, or copy images directly to the clipboard (<kbd>Ctrl</kbd>+<kbd>C</kbd>).
- Optional Internal Storage for Physical File Organization: Copy only the specific photos you want to physically reorganize into the app's `storage/` folder to move across subfolders or batch-rename (<kbd>F2</kbd>) while automatically keeping paired RAW and `.xmp` files together.

### 3. A Quiet Look & Feel That Stays Out of Your Way.
When comparing and culling hundreds or thousands of frames, colorful icons, heavy borders, slow RAW loading, or accidental drag-and-drop changes to your tag tree break your concentration. The interface is kept visually quiet so the colors and tones of your photographs stand out naturally, allowing you to cull smoothly with the keyboard and minimal eye movement.

- Quiet, Photo-First Interface: Free of colorful emojis and heavy visual clutter, with one-click switching between the bright Japanese paper theme (Washi), darkroom ink theme (Urusi), and `JP` / `EN` display languages.
- Three Grid Layouts & Collapsible Panels: Switch between Standard Grid, aspect-ratio-preserving Masonry view, and film-frame Slide Mount view. Hide thumbnail text overlays (<kbd>I</kbd> key) or collapse sidebars to maximize space, while keeping an uncropped 4:3 preview and Quick EXIF summary visible in the right Inspector.
- Fast Viewing for Foveon (`X3F`) & Camera RAWs: Supports SIGMA (`X3F`), Panasonic (`RW2`), Canon (`CR2` / `CR3`), Nikon (`NEF`), Sony (`ARW`), Olympus (`ORF`), Fujifilm (`RAF`), Pentax (`PEF`), `DNG`, and more, prioritizing embedded previews for instant viewing in camera-original colors.
- Smart Stacks for Bursts & Brackets: Automatically stacks continuous bursts, exposure brackets (AEB), RAW+JPG pairs, and duplicates. Flip through stacked frames with <kbd>↑</kbd> <kbd>↓</kbd> in Lightbox and switch the cover shot via the top Primary button.
- One-Handed 4-Tier Rating & 2-Up Duel Comparison: Cull with one hand using number keys (<kbd>1</kbd>: Ex / <kbd>2</kbd>: Gd / <kbd>3</kbd>: Rj / <kbd>0</kbd>: Nm), where rejected photos immediately hide from the view without confirmation dialogs. Compare two close contenders side-by-side (<kbd>V</kbd> key) with synchronized zoom/pan and dual histograms, promoting winners with the <kbd>W</kbd> key.
- Separation of Daily Tagging and Tree Editing: Daily tag assignment is limited to the right Inspector and context menu, while moving, renaming, and deleting tag hierarchies are isolated inside a dedicated Settings editor to prevent accidental edits. Left and right tag lists also support independent Name (natural order) vs. Count sorting.

### 4. No Reliance on the Cloud — Yet Fully Portable.
Tetheract Photo Manager was built from the desire not to leave personal photo libraries locked in external cloud services or struggle with environment setup and database migration every time you replace a PC. Every feature runs locally without an internet connection, and placing the folder on an external SSD or USB flash drive lets you carry your entire environment across different PCs and even onto your smartphone.

- 100% Local Execution with Zero Uploads: Never sends photos to external servers or loads external CDNs (only viewing map background tiles connects to OpenStreetMap). Local AI auto-tagging (CLIP) and offline GPS reverse geocoding (Country, State/Prefecture, and City) run entirely on your PC.
- No Installation Required — Run Directly from USB: The portable Python runtime and SQLite database (`cache/library.db`) live inside a single folder, launching directly from an external SSD or USB drive even on a PC without Python installed. Updates require only overwriting with a lightweight diff ZIP.
- Drive-Letter Tracking & Unplugged Browsing: Tracks drives by Volume Serial Number (VSN) so links never break when drive letters change (`E:\` to `F:\`) across PCs. Even when external drives are unplugged, you can continue browsing thumbnails, searching, tagging, and rating.
- Smartphone Wi-Fi & Offline USB Culling: Cull on your smartphone over home Wi-Fi (QR one-time token authentication, auto-stops after 30 min idle) or completely offline on the go by opening `Tetheract_Mobile.html` and `cache/library.db` directly in your phone's browser via WebAssembly, then sync changes back to your PC.

---

## Keyboard Shortcuts

| Key | Action |
| :--- | :--- |
| <kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd> (<kbd>X</kbd>) / <kbd>0</kbd> | Set rating (<kbd>1</kbd>: Ex / <kbd>2</kbd>: Gd / <kbd>3</kbd>: Rj / <kbd>0</kbd>: Nm / Clear) |
| <kbd>Space</kbd> / <kbd>Enter</kbd> | Open / close Lightbox view |
| <kbd>←</kbd> <kbd>→</kbd> <kbd>↑</kbd> <kbd>↓</kbd> | Navigate photos (in Lightbox, <kbd>↑</kbd> <kbd>↓</kbd> switches frames inside a burst or AEB stack) |
| <kbd>V</kbd> / <kbd>W</kbd> | Open 2-Up Duel comparison / Keep right photo as winner during comparison |
| <kbd>C</kbd> / <kbd>H</kbd> | Open Crop / Straighten / Tone modal / Toggle RGB & Luminance histogram |
| <kbd>R</kbd> / <kbd>L</kbd> | Rotate 90° clockwise / Rotate 90° counter-clockwise |
| <kbd>F2</kbd> | Rename file (single rename or batch sequential rename for photos in `storage/`) |
| <kbd>[</kbd> (<kbd>B</kbd>) / <kbd>D</kbd> / <kbd>I</kbd> | Toggle left menu / Toggle right inspector / Toggle thumbnail text overlay |

---

## Download & How to Run

### Option A: Using the Release ZIP Package (Portable Python Included)

Because the portable Python runtime and all required libraries are bundled, no prior setup or installation is needed on your PC.

1. First-Time Setup (Full Package `Tetheract_vX.X.X.zip`):  
   Download the full package ZIP from [GitHub Releases](../../releases), extract it to any folder or USB drive, and double-click `Tetheract.exe` to launch in a dedicated application window.
2. Updating an Existing Setup (Lightweight Diff `Tetheract_vX.X.Xdiff.zip`):  
   If you already have a full package running, you do not need to re-download `python/` or `models/`. Extract the lightweight diff ZIP and overwrite your existing folder to update while keeping your `cache/` database and `storage/` intact.

> [!NOTE]
> Upgrading from Photo Manager v3.x & Downgrade Compatibility
>
> - Automatic Launcher Cleanup: When you overwrite an existing `PhotoManager` folder and launch `Tetheract.exe`, legacy `PhotoManager.exe` and `PhotoManager_Mobile.html` files in the root folder are automatically cleaned up and unified into `Tetheract.exe` and `Tetheract_Mobile.html`.
> - Regenerating `autorun.inf` on USB Drives (Recommended): If you run from the root of a USB drive and use `autorun.inf` for a custom drive icon and label, delete your existing `autorun.inf` and re-run `Build.bat` to regenerate `autorun.inf` with the new icon and volume label (`TETHERACT pm`).
> - Automatic DB Snapshot & Backward Compatibility: Immediately before running the `tag_keys_v1` schema migration on first startup, a full snapshot of your database is automatically backed up to `cache/backups/library_pre_tag_keys_v1_YYYYMMDD_HHMMSS.db`. Furthermore, because the migrated `cache/library.db` retains the legacy table and column structure in a hybrid layout, it remains compatible even if you revert the program files to v3.x (or you can restore the pre-migration snapshot from `cache/backups/`).

> [!IMPORTANT]
> If Microsoft Defender SmartScreen Appears on First Launch
>
> This application operates locally with no photo uploads or registry changes (only map tiles connect to OpenStreetMap). Because it is an independent personal project without a commercial code-signing certificate, Windows Defender SmartScreen may show a confirmation dialog when launching a downloaded `.exe` for the first time. You can start the app in either of two ways:
>
> 1. Run directly: Click "More info" on the SmartScreen dialog and select "Run anyway" (this prompt will not appear on subsequent launches).
> 2. Build locally with `Build.bat`: Double-click `Build.bat` in the folder. It uses the standard C# compiler (`csc.exe`) included with Windows to compile `Tetheract.exe` directly on your PC from the plain-text source code ([`launcher/Launcher.cs`](launcher/Launcher.cs)) and launches the app without download-related blocks.

### Option B: Cloning from the GitHub Repository

The Git repository does not include the large portable Python directory (`python/`). Run the following two steps once on first setup (installing Python on your system is not required):

1. Run `setup_portable_python.bat` (requires internet connection on first run):  
   Automatically downloads and sets up Embeddable Python 3.11 and required packages into the `python/` folder.
2. Run `Build.bat`:  
   Compiles `Tetheract.exe` and starts the application.

---

## Future Outlook

Because this software is developed as a personal hobby through Vibe Coding, there is no fixed schedule or guarantee of implementation. While keeping the core principles of 100% offline, non-destructive, and lightweight operation intact, the following ideas are being considered:

- Visual Similarity Search (Local Image-to-Image Search):  
  Using local AI image analysis on your PC, select a favorite shot to find other photos across your library with a similar composition, color tone, or lighting mood, even without tags.
- Focus Peaking Highlight:  
  Highlight sharp, in-focus edges with a colored overlay during Lightbox and 2-Up Duel comparison—much like a camera's focus peaking—to make it easier to spot the sharpest frame in a burst.
- Location & Route Matching from GPS Logs (`.gpx`):  
  Match `.gpx` logs from hiking or travel GPS loggers against capture timestamps so photos from cameras without built-in GPS can also be mapped and traced non-destructively in the database.
- Direct Handoff to External RAW Editors:  
  Pass selected photos (or paired RAW files) directly to your preferred external RAW developer with a single keyboard shortcut.
- Mat Frame & Subtle EXIF Export:  
  An export option in Smart Takeout that places a quiet mat border around your photo with minimal camera, lens, and exposure details printed along the margin.

---

## Documentation

- [User Manual (`MANUAL.md`)](MANUAL.md)  
  Covers basic operation, one-handed culling, 2-Up Duel comparison, exclusive search, non-destructive edits, export, and mobile/USB workflows. The same guide can also be viewed in English from the in-app Help button (<kbd>F1</kbd>) after switching the UI to `EN`.
- [USB Portable Guide (`README_USB.md`)](README_USB.md)  
  Instructions for carrying your library on an external SSD or USB drive and syncing with a smartphone.
- [Architecture & Technical Notes (`docs/knowledge/`)](docs/knowledge/README.md)  
  Design records covering SQLite BLOB thumbnail storage, WebAssembly mobile sync, and the v3.00 UI design system.

---

## License

The original source code of Tetheract Photo Manager is released under the [MIT License](LICENSE). Feel free to use and modify it on an "AS IS" basis without warranty.

> [!WARNING]
> Compliance with Bundled Third-Party Licenses
>
> When modifying, redistributing, or packaging this software, please comply with the license terms of all bundled third-party libraries and datasets.
> - Full license texts and notices for all included libraries (Python, FastAPI, Pillow, LibRaw / rawpy [LGPL 2.1], pystray [LGPL 3.0], ONNX Runtime, sql.js, etc.) and offline geocoding datasets (Code for Fukui, GeoNames, etc. [CC BY 4.0 / ODbL]) are located in [`LICENSES/NOTICE.txt`](LICENSES/NOTICE.txt) and the [`LICENSES/`](LICENSES) directory.
> - In particular, to comply with the LGPL 2.1 license of LibRaw (bundled within `rawpy`), keep it dynamically linked (as DLLs) and do not statically bundle it into a single executable using tools like `PyInstaller --onefile` when redistributing.
