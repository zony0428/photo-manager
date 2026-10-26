# Photo Manager

**[日本語](README.md) | English**

A fast, local, non-destructive RAW and standard photo viewer and culling tool for Windows, inspired by Picasa and Tiat.  
Browse, cull, and organize tens of thousands of photos (JPEG, PNG, WebP, HEIC, and RAW files from major camera brands) with zero lag, without modifying a single byte of your original files or folder structure. Built as a standalone, USB-portable application.

| Masonry View (Aspect-ratio preserved & Burst Stack) | Slide Mount View (Film Slide Frame Mode) |
| :---: | :---: |
| ![Masonry View](docs/images/screenshot_masonry.png) | ![Slide Mount View](docs/images/screenshot_mount.png) |

---

> [!NOTE]
> **Read Me First (Development Stance & Honest Disclaimers)**
>
> - **100% "Vibe Coding" — Built Entirely by Asking AI**  
>   Every single line of code in this application was generated via 100% Vibe Coding (asking AI to write it). I (the author) have zero knowledge of how the code inside actually works! lol. So please don't ask me technical questions like *"How does line X work?"* — I genuinely have no idea.
> - **Personal Hobby Project (About Feature Requests & Issues)**  
>   This software is built for my own personal photography workflow. While I happily read feature requests and bug reports for reference, whether they actually get implemented or fixed depends entirely on the AI's mood. Please enjoy it with a *"lucky if it works for me as-is"* mindset.
> - **Real-Time `JP` / `EN` UI Toggle Included (Though My Own English Skill is Zero)**  
>   I am a Japanese developer with zero English skills. If you talk to me in English, I will rely 100% on machine translation and will probably sound like a slightly weird person lol.  
>   However, clicking the `JP` / `EN` button in the top header switches the entire UI, tooltips, and the built-in Help Manual into English in real time (including photography terms like `Washi / Urusi` themes, `Ex / Gd / Nm / Rj` ratings, `Lens Shaker` camera-shake detector, `Betayaki` contact sheets, and `Gacha` random folder picker — all 100% AI-translated, of course! lol).

---

## Core Concepts

### 1. Stoic, Photography-First Workspace (v3.00 UI Architecture)
Designed to keep visual noise out of your way so your photographs take center stage:
- **Unified Single-Row Header (44px)**: Consolidates layout switching, thumbnail size, multi-axis sorting, theme toggle (`Washi` / `Urusi`), and language toggle (`JP` / `EN`) into a single 44px bar.
- **2-Stage Left Sidebar**: Pairs a persistent 54px vertical icon rail (`Quick / Folders / Tags / Geotags / Date / Gear / Lab / Search`) with a full-height menu stage that gives 100% vertical space to the active tree. When the menu is collapsed (`Menu Off`), the 54px icon rail stays accessible and opens the menu as a floating overlay over the photo grid on click. Persistent global filters (Attribute pills & 4-tier Rating pills) sit right at the top of the menu stage.
- **4:3 Inspector Preview & Always-Visible Quick EXIF**: The right Inspector features a non-cropped `4:3` preview and a permanent Quick EXIF summary (Date Taken, Dimensions, Camera/Lens, and Exposure pills) right below the rating buttons—no tab switching required.

### 2. Non-Destructive Workflow & XMP Sidecar Integration
Rotating, cropping, leveling horizons, adjusting tone, shifting capture timestamps, or marking photos as "Rj (Reject)" never alters or deletes your original files on disk.  
When companion `.xmp`, `.pp3`, or `.dop` sidecar files (from Lightroom, Adobe Camera Raw, etc.) are detected, you can hold down the `XMP Preview` button in the Inspector to temporarily preview XMP adjustments, or import XMP ratings (mapped to Photo Manager's 4-tier scale) and hierarchical keywords under an isolated `XMP/...` root without polluting your existing tag tree.

### 3. Exclusive Search (`[-]` Exclude Filter) & Separated Tag Hierarchy Management
When filtering by tags/albums or the **Camera Body > Mounted Lens** tree, you can not only include `[+]` an item, but also exclude `[-]` specific tags, cameras, or lenses — making it effortless to find photos you forgot to add to an album or shots taken with anything other than a specific lens.  
Daily tag assignment stays clean in the right Inspector and right-click context menu, while structural operations (drag-and-drop hierarchy reorganization, promoting child tags to root, inline renaming, and library-wide deletion) are isolated inside the 2-pane **Settings & Tag Tree Editor**.

### 4. 100% Offline, USB Portability & Self-Contained Storage (`storage/`)
Your photos are never uploaded to any external cloud. AI auto-tagging (ONNX Runtime / CLIP) and reverse geocoding (GPS to Country / Prefecture / City) run completely locally on your PC.  
Run directly from a USB flash drive or external SSD on any Windows PC without installing Python. Selecting external photos via `Import` copies them into the app's internal `storage/` directory, allowing you to create/rename subfolders, move photos via drag-and-drop, batch-rename files (`F2`), and export folders while automatically tracking companion sidecars and paired RAW files.

---

## Feature Overview

| Category | Feature | Description |
| :--- | :--- | :--- |
| **Culling & Comparison** | **4-Tier Rating (`Ex / Gd / Nm / Rj`)** | One-handed culling using number keys (`1`: Ex / `2`: Gd / `3`: Rj / `0`: Nm). Rejected photos hide immediately from the grid |
| | **2-Up Side-by-Side Duel** | Compare two photos side-by-side with synchronized zoom & pan, Exif diff highlighting, and knockout selection (`W` key) |
| | **Smart Stacks** | Automatically groups continuous bursts, exposure brackets (AEB), and duplicates. Flip through stacked shots with `↑` / `↓` in Lightbox |
| **Search & Filtering** | **Persistent Type & Rating Bar** | Always-visible filter bar at the top of the left menu for format/attribute (`All / RAW / Edited / JPEG Only / RAW+JPG Pair / Has XMP`) and rating (`Ex / Gd / Nm / Rj`) |
| | **Include `[+]` / Exclude `[-]` Filter** | Exclusive filtering across tags and the Camera > Lens hierarchy. Includes a `By Count` toggle and Lexical / Natural name sorting |
| | **Multi-Axis Sorting** | Sort by Date Taken, Rating, Filename, File Size, Focal Length, Aperture, Shutter Speed (Fast ↔ Slow), or ISO |
| **Non-Destructive Edits** | **Crop, Straighten & Tone** | Fine horizon leveling (±45°), aspect-ratio cropping, exposure/contrast/saturation adjustments, and batch tone copy/paste |
| | **Live RGB Histogram** | Real-time RGB & Luminance waveform histogram (`H` key) linked dynamically to tone adjustments |
| | **Batch Capture Time Shift** | Non-destructively offset capture timestamps (`±Days/Hours/Min/Sec`) to fix camera clock drift or timezones, with one-click reset to original Exif time |
| **Export & Print** | **Smart Takeout** | Batch-export selected photos with baked-in edits, resizing, sequential renaming, Exif stripping, and optional `.xmp` sidecar output |
| | **Betayaki Contact Sheet HTML** | Generate a darkroom-style negative contact sheet in a single standalone HTML file with interactive red grease-pencil marks and A4 print layout |
| **Photography Lab** | **Winning Lens & Sweet-Spot Chart** | Analyzes your `Ex` / `Gd` keeper rates to rank your best-performing lenses and sweet-spot focal lengths, apertures, and hours |
| | **Solar Elevation & Lens Shaker** | Computes solar angle from timestamp & GPS to extract Golden Hour, Blue Hour, and Night shots, plus slow-shutter shake risks (`< 1/focal_length sec`) |
| | **Conquest Map & Walk Trajectory** | Visualize your footprint across Japan's 47 prefectures, shooting density heatmaps, and chronological photo-walk trajectories |
| | **On This Day & Folder Gacha** | Rediscover photos taken on the same calendar date across years, or draw a random unrated folder to cull |
| **UI & Mobile Sync** | **Washi / Urusi Themes & i18n** | Switch between bright Japanese paper (`Washi`) and darkroom ink (`Urusi`) themes, and toggle the UI between `JP` and `EN` |
| | **Smartphone Offline Culling** | High-quality WebP thumbnails are embedded in `cache/library.db`. Load the `.db` via WebAssembly (`sql.js`) on your phone to cull offline and sync back to PC |

---

## Keyboard Shortcuts

| Key | Action |
| :--- | :--- |
| <kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd> (<kbd>X</kbd>) / <kbd>0</kbd> | Set rating (`1`: Ex / `2`: Gd / `3`: Rj / `0`: Nm / Clear) |
| <kbd>Space</kbd> / <kbd>Enter</kbd> | Open / close Lightbox view |
| <kbd>←</kbd> <kbd>→</kbd> <kbd>↑</kbd> <kbd>↓</kbd> | Navigate photos (in Lightbox, <kbd>↑</kbd> <kbd>↓</kbd> switches frames inside a burst or AEB stack) |
| <kbd>V</kbd> / <kbd>W</kbd> | Open 2-Up Duel comparison / Crown right photo as winner during comparison |
| <kbd>C</kbd> / <kbd>H</kbd> | Open Crop / Straighten / Tone modal / Toggle live RGB & Luminance histogram |
| <kbd>R</kbd> / <kbd>L</kbd> | Rotate 90° clockwise / Rotate 90° counter-clockwise |
| <kbd>F2</kbd> | Rename file (single rename or batch sequential rename for photos in `storage/`) |
| <kbd>[</kbd> (<kbd>B</kbd>) / <kbd>D</kbd> / <kbd>I</kbd> | Toggle left menu / Toggle right inspector / Toggle card metadata overlay |

---

## Setup & How to Run

### Option A: Using the Release ZIP Package (Portable Python Included)

1. **First-Time Install (Full Package `PhotoManager_vX.XX.zip`)**  
   Extract the full `.zip` archive to any folder or USB drive, and double-click `PhotoManager.exe` to launch in a dedicated borderless application window.
2. **Updating an Existing Installation (Lightweight Diff `PhotoManager_vX.XXdiff.zip`)**  
   If you already have a recent full version running, extract the lightweight diff `.zip` and overwrite your existing folder. Your `python/` runtime, `models/`, `cache/` database, and `storage/` remain intact.

> [!IMPORTANT]
> **About Microsoft Defender SmartScreen Prompts on First Launch**
>
> This application operates 100% offline with no external network requests or registry modifications. However, because it is an independent hobby project without a commercial EV Code Signing Certificate, Windows Defender SmartScreen may display a confirmation screen when launching a downloaded `.exe` for the first time. You can proceed in either of two ways:
>
> 1. **Run Directly**: On the SmartScreen prompt, click **"More info" → "Run anyway"** (this prompt will not appear on subsequent launches).
> 2. **Clean Local Build via `Build.bat`**: Double-clicking **`Build.bat`** uses Windows' built-in official C# compiler (`csc.exe`) to compile the plain-text launcher source ([`launcher/Launcher.cs`](launcher/Launcher.cs)) directly into `PhotoManager.exe` on your own machine in one second and starts the app without download-origin blocks (Mark of the Web).

### Option B: Cloning from GitHub

The Git repository does not include the large portable Python runtime (`python/`). On your first run, execute these two steps (no system-wide Python installation required):

1. **Run `setup_portable_python.bat`** (Requires internet connection, first time only)  
   Automatically downloads official Python 3.11 Embeddable and required packages (FastAPI, Pillow, rawpy, ONNX Runtime, etc.) into the `python/` directory.
2. **Run `Build.bat`**  
   Compiles `PhotoManager.exe` and starts the application.

---

## Documentation

- **Built-in Interactive Manual**: Click the **Help (`F1`)** button at the top-right of the application (available in both `JP` and `EN`).
- **[User Manual (`MANUAL.md` - Japanese)](MANUAL.md)**
- **[USB Portable Guide (`README_USB.md` - Japanese)](README_USB.md)**
- **[Architecture & Technical Knowledge (`docs/knowledge/`)](docs/knowledge/README.md)**

---

## License

- **Photo Manager Source Code**  
  The original source code of this project is licensed under the **[MIT License](LICENSE)**, provided "AS IS" without warranty of any kind.

> [!WARNING]
> **Third-Party Library Licenses & Redistribution Requirements**
>
> If you modify, redistribute, or package this software, you must comply with the licenses of the bundled third-party libraries and datasets.
> - Full license texts and notices for all dependencies (Python, FastAPI, Pillow, **LibRaw / rawpy [LGPL 2.1]**, **pystray [LGPL 3.0]**, ONNX Runtime, sql.js, etc.) and offline geocoding datasets (Code for Fukui, GeoNames, etc. [CC BY 4.0 / ODbL]) are provided in [`LICENSES/NOTICE.txt`](LICENSES/NOTICE.txt) and the [`LICENSES/`](LICENSES) directory.
> - In particular, to comply with **LibRaw (LGPL 2.1)** bundled inside `rawpy`, always keep dynamic linking (DLLs) intact and do **not** statically bundle the application into a single executable using `PyInstaller --onefile`.
