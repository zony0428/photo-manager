# Photo Manager

[日本語](README.md) | English

A local, non-destructive photo viewer and culling tool for Windows, inspired by Picasa and Tiat.  
Browse, compare, and organize large collections of photos (JPEG, PNG, WebP, HEIC, and RAW files from major camera brands) smoothly, without modifying a single byte of your original files or folder structure.

To try it right away, download the latest ZIP from [GitHub Releases](../../releases), extract it to any folder, and run `PhotoManager.exe` (no installation required).

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
>   Although the code is written by AI, one strict rule is enforced throughout: your original photo files (RAW, JPEG, XMP, etc.) in your folders are never modified, moved, or deleted by even a single byte. It never forces your photos into a proprietary library folder, nor does it scatter sidecar or management files inside your photo folders. All tags, ratings, rotations, and crops are saved solely inside a single database file (`cache/library.db`) within the app's own folder. If you decide the app isn't for you, simply delete the Photo Manager folder and your PC environment and photo folders remain completely untouched.

---

## Key Characteristics

### 1. Exclusive Search (`[-]` Exclude Filter) & Floating Natural-Language Filter Bar
Built on the snappy tag-browsing experience of Picasa and Tiat, Photo Manager focuses on effortless exclusion (`[-]`) and hierarchical combination filtering.  
When filtering by hierarchical tags or the "Camera Body > Lens" tree, left-click to include `[+]` or right-click to exclude `[-]`. Sub-tags under the same top-level parent combine with `OR`, while different top-level groups combine with `AND`. You can select a broad parent category with `[+]` and subtract specific sub-tags with `[-]`, or immediately spot photos where you forgot to apply a tag.  
Whenever filters are active, a floating filter footer bar appears at the bottom of the screen displaying your active conditions as a readable sentence. Clicking any condition pill opens an inline popover to add/exclude sibling tags or select the same month across all years without opening the sidebar, while collapsed parent nodes display a dashed border and count badge (`+1` / `-1`) as a trail marker. Daily tag assignment takes place in the right Inspector and context menu, while structural edits (reorganizing hierarchies, renaming, and deleting tags) are separated into a dedicated editor inside Settings to prevent accidental changes during culling.

### 2. Fast Viewing for Foveon (`X3F`) and Modern Camera RAWs
Alongside JPEG, PNG, WebP, and HEIC, the app directly displays RAW formats including SIGMA Foveon (`X3F`), Panasonic (`RW2`), Canon (`CR2` / `CR3`), Nikon (`NEF`), Sony (`ARW`), Olympus (`ORF`), Fujifilm (`RAF`), Pentax (`PEF`), and `DNG`.  
Instead of running slow RAW development, it prioritizes extracting embedded JPEG previews (falling back to LibRaw only when needed), preserving camera-original colors with zero development wait time. Camera bodies and lenses are automatically organized into a hierarchical tree for instant gear-based filtering.

### 3. Clean Photo Folders & XMP Sidecar Integration
Rotating, leveling horizons, cropping, adjusting tone, shifting capture timestamps, or marking photos as "Rj (Reject)" never alters or deletes your original files on disk, and never creates hidden management files or sidecars inside your photo directories.  
When companion `.xmp`, `.pp3`, or `.dop` sidecar files already exported by RAW developers (such as Lightroom or Adobe Camera Raw) exist in the same folder, the app reads them non-destructively so you can hold down the "XMP Preview" button in the Inspector to compare adjustments, or import XMP ratings and hierarchical keywords into an isolated `XMP/...` tag branch.

### 4. Quiet, Tiat-Inspired Workspace Where Photos Stand Out
Visual noise such as colorful emojis and heavy borders is kept to a minimum so the colors and tonal gradations of your photographs stand out naturally.
- Switch anytime between the bright Japanese paper theme (Washi) and the darkroom-inspired ink theme (Urusi).
- Choose between aspect-ratio-preserving Masonry view and film-frame Slide Mount view.
- The left sidebar (Folders, Tags, Geotags, Date, Gear, Lab, etc.) can be collapsed to maximize grid space or opened as an overlay when needed.
- The right Inspector keeps an uncropped 4:3 preview (double-click to open Lightbox) and a quick EXIF summary (Date Taken, Dimensions, Camera, Lens, and Exposure settings) visible at all times without switching tabs.

### 5. Local-First Operation & USB Portability
Your photos are never sent to any external cloud or server. Web fonts and the map library (Leaflet) are bundled locally with no external CDN requests (only viewing map background tiles connects to OpenStreetMap). AI auto-tagging (CLIP) and reverse geocoding (GPS coordinates to Country, Prefecture/State, and City) run entirely locally on your PC.  
You can run the app directly from an external SSD or USB flash drive even on a PC without Python installed. When you copy selected photos into the app's internal `storage/` folder, you can organize subfolders and batch-rename files (<kbd>F2</kbd>) while automatically keeping paired RAW files and `.xmp` sidecars together.

---

## Feature Overview

| Category | Feature | Description |
| :--- | :--- | :--- |
| Culling & Comparison | 4-Tier Rating | One-handed culling with number keys (<kbd>1</kbd>: Ex / <kbd>2</kbd>: Gd / <kbd>3</kbd>: Rj / <kbd>0</kbd>: Nm). Rejected photos hide immediately from the grid |
| | 2-Up Side-by-Side Duel | Compare two photos side-by-side with synchronized zoom & pan and knockout selection (<kbd>W</kbd> key) |
| | Smart Stacks | Automatically groups continuous bursts, exposure brackets (AEB), and duplicates. Flip frames with <kbd>↑</kbd> <kbd>↓</kbd> in Lightbox and promote the cover frame via the top Primary button |
| Search & Filtering | Type & Rating Bar | Persistent filter bar at the top of the left menu for format/attribute (RAW / JPEG Only / RAW+JPG Pair / Edited / Has XMP) and ratings (Ex / Gd / Nm / Rj) |
| | Include `[+]` / Exclude `[-]` Filter | Exclusive filtering across tags and the Camera > Lens hierarchy, with collapsed-tree trail indicators and click-to-jump filter chips |
| | Multi-Axis Sorting | Sort by Date Taken, Rating, Filename, File Size, Focal Length, Aperture, Shutter Speed, or ISO |
| Non-Destructive Edits | Crop, Straighten & Tone | Fine horizon leveling (±45°), aspect-ratio cropping, exposure/contrast/saturation adjustments, and batch copy/paste |
| | Live RGB Histogram | Real-time RGB & Luminance histogram (<kbd>H</kbd> key) linked dynamically to tone adjustments |
| | Batch Capture Time Shift | Non-destructively offset capture timestamps (Days/Hours/Min/Sec) to fix camera clock drift or timezones, with one-click reset to original EXIF |
| Export & Print | Smart Takeout | Batch-export selected photos with baked-in edits, resizing, sequential renaming, EXIF stripping, and optional `.xmp` sidecar output |
| | Contact Sheet HTML (Betayaki) | Generate a darkroom-style negative contact sheet in a single standalone HTML file with red grease-pencil marks and A4 print layout |
| Photography Lab | Winning Lens & Sweet-Spot Chart | Summarizes your keeper rates (Ex / Gd) to highlight your best-performing lenses and sweet-spot focal lengths, apertures, and hours |
| | Solar Elevation & Shake Check | Computes solar angle from timestamp & GPS to extract Golden Hour, Blue Hour, and Night shots, plus slow-shutter shake candidates |
| | Prefecture Map & Walk Trajectory | Visualize your shooting footprint across Japan's 47 prefectures, density heatmaps, and chronological photo-walk trajectories |
| | On This Day & Folder Gacha | Rediscover photos taken on the same calendar date across years, or open a random unrated folder to cull |
| Mobile Sync | Smartphone Wi-Fi & Offline Culling | Token-authenticated QR Wi-Fi culling (auto-stops after 30 min idle), plus offline culling by loading `cache/library.db` via WebAssembly on your phone and syncing back to PC |

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

1. First-Time Setup (Full Package `PhotoManager_vX.X.X.zip`):  
   Download the full package ZIP from [GitHub Releases](../../releases), extract it to any folder or USB drive, and double-click `PhotoManager.exe` to launch in a dedicated application window.
2. Updating an Existing Setup (Lightweight Diff `PhotoManager_vX.X.Xdiff.zip`):  
   If you already have a full package running, you do not need to re-download `python/` or `models/`. Extract the lightweight diff ZIP and overwrite your existing folder to update while keeping your `cache/` database and `storage/` intact.

> [!IMPORTANT]
> If Microsoft Defender SmartScreen Appears on First Launch
>
> This application operates locally with no photo uploads or registry changes (only map tiles connect to OpenStreetMap). Because it is an independent personal project without a commercial code-signing certificate, Windows Defender SmartScreen may show a confirmation dialog when launching a downloaded `.exe` for the first time. You can start the app in either of two ways:
>
> 1. Run directly: Click "More info" on the SmartScreen dialog and select "Run anyway" (this prompt will not appear on subsequent launches).
> 2. Build locally with `Build.bat`: Double-click `Build.bat` in the folder. It uses the standard C# compiler (`csc.exe`) included with Windows to compile `PhotoManager.exe` directly on your PC from the plain-text source code ([`launcher/Launcher.cs`](launcher/Launcher.cs)) and launches the app without download-related blocks.

### Option B: Cloning from the GitHub Repository

The Git repository does not include the large portable Python directory (`python/`). Run the following two steps once on first setup (installing Python on your system is not required):

1. Run `setup_portable_python.bat` (requires internet connection on first run):  
   Automatically downloads and sets up Embeddable Python 3.11 and required packages into the `python/` folder.
2. Run `Build.bat`:  
   Compiles `PhotoManager.exe` and starts the application.

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

The original source code of Photo Manager is released under the [MIT License](LICENSE). Feel free to use and modify it on an "AS IS" basis without warranty.

> [!WARNING]
> Compliance with Bundled Third-Party Licenses
>
> When modifying, redistributing, or packaging this software, please comply with the license terms of all bundled third-party libraries and datasets.
> - Full license texts and notices for all included libraries (Python, FastAPI, Pillow, LibRaw / rawpy [LGPL 2.1], pystray [LGPL 3.0], ONNX Runtime, sql.js, etc.) and offline geocoding datasets (Code for Fukui, GeoNames, etc. [CC BY 4.0 / ODbL]) are located in [`LICENSES/NOTICE.txt`](LICENSES/NOTICE.txt) and the [`LICENSES/`](LICENSES) directory.
> - In particular, to comply with the LGPL 2.1 license of LibRaw (bundled within `rawpy`), keep it dynamically linked (as DLLs) and do not statically bundle it into a single executable using tools like `PyInstaller --onefile` when redistributing.
