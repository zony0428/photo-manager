# 📷 Photo Manager

**[ 🇯🇵 日本語 (Japanese) ](README.md) | [ 🇺🇸 English ](README_EN.md)**

**A blazingly fast, local, non-destructive RAW & standard photo viewer / culling tool for Windows — inspired by Picasa & Tiat.**

Browse, cull, and organize tens of thousands of photos (JPEG / PNG / WebP / HEIC and RAW files from major camera brands) with zero lag, without modifying a single byte of your original files or folder structure. Designed as a standalone, USB-portable application for Windows.

| ▤ Masonry View (Aspect-ratio preserved & Burst Stack) | 🎞️ Slide Mount View (Film Slide Frame Mode) |
| :---: | :---: |
| ![Masonry View](docs/images/screenshot_masonry.png) | ![Slide Mount View](docs/images/screenshot_mount.png) |

---

## 💬 Read Me First! (Development Stance & Honest Disclaimers)

Thank you for visiting this repository! Before using or exploring this project, please keep the following in mind:

* 🤖 **100% "Vibe Coding" — Built Entirely by Asking AI!**
  * Every single line of code in this app was generated via **100% Vibe Coding (asking AI to write it)**. **I (the author) have ZERO knowledge of how the code inside actually works!** lol
  * So please don't ask me technical questions like *"How does line X work?"* — I genuinely have no idea!
* 🇯🇵 **One-Click `🇯🇵 JP` ⇄ `🇺🇸 EN` English UI Included! (Though My Own English Skill is ZERO! 🌍)**
  * I am a Japanese developer with **zero English skills**! If you talk to me in English, I will rely 100% on machine translation and will probably sound like a slightly weird person lol.
  * **Good news: The app now includes a real-time `🇯🇵 JP` ⇄ `🇺🇸 EN` language toggle button at the top-left!** Clicking it switches the entire UI, tooltips, and the built-in Help Manual into English on the fly (including playful photography terms like **`Washi / Urusi`** themes, **`Ex / Gd / Nm / Rj`** ratings, **`Lens Shaker`** camera-shake detector, **`Betayaki`** darkroom contact sheets, and **`Gacha`** random folder picker—all 100% AI-translated, of course! lol).
* 🛠️ **Personal Hobby Project (About Feature Requests & Issues)**
  * This software is built for my own personal photography workflow.
  * While I happily read feature requests and bug reports for reference, **whether they actually get implemented or fixed depends entirely on the AI's mood!** Please enjoy it with a *"lucky if it works for me as-is"* mindset.

---

## ⚠️ About False-Positive "SmartScreen" Warnings on First Launch

When downloading this software from GitHub Releases and launching it for the first time, you may see a blue confirmation screen like **"Windows protected your PC (Microsoft Defender SmartScreen)"**.

### ❓ Why does this warning appear? (Is it safe?)
* **There are NO viruses or malicious programs whatsoever.** In fact, this app operates **100% offline** with no external network communication or registry modifications.
* By default, the local server binds strictly to `127.0.0.1` (localhost only) so it never triggers Windows Firewall warnings or exposes ports on public Wi-Fi (LAN listening is activated on-demand only when you open the `📱 Mobile` QR modal, with strict cross-origin & localhost-only API protection).
* Because this is a personal hobby project without an expensive commercial EV Code Signing Certificate, Windows Defender SmartScreen automatically flags unsigned `.exe` launchers (`PhotoManager.exe`) as *"unknown executable"*.

### 🛡️ How to Launch (Direct Run or Local Rebuild via `Build.bat`)
1. **Direct Launch**:
   * If the blue SmartScreen prompt appears, simply click **"More info" → "Run anyway"** (it won't ask again after the first run).
2. **Clean Local Build via `Build.bat` (Optional / Fallback)**:
   * Double-clicking **`Build.bat`** uses Windows' built-in official C# compiler (`csc.exe`) to compile a tiny, plain-text source file ([`launcher/Launcher.cs`](launcher/Launcher.cs) — you can inspect all of it in Notepad!) directly into **`PhotoManager.exe`** on your own PC in 1 second, and immediately launches the app without download-origin blocks (if run from a USB drive root, it can optionally generate `autorun.inf` for a custom drive icon).

---

## ✨ Key Features

1. **🔍 Obsessive "Exclusive Search (Exclude Filter `[-]`)" & Dedicated Drag-and-Drop "Tag Tree Editor"**
   * The left sidebar is dedicated 100% to pure, mistake-free filtering. When filtering by tags/albums or the **Camera Body > Mounted Lens tree**, you can not only include `[+]` an item, but also **exclude `[-]` specific tags, cameras, or lenses** to easily find **"photos you forgot to add to an album"**! A one-click **`📊 By Count`** toggle switches between sorting tags by photo count and your preferred name sort rule (Lexical `24-xxx → 2410-xxx → 25-xxx` or Natural numeric order).
   * Daily tag assignment (`+Add`) stays clean in the right Inspector, while structural operations—**Drag & Drop hierarchy reorganization, promoting child tags to root, inline renaming (`✏`), and library-wide deletion (`🗑️`)**—are safely isolated in the 2-pane **`⚙️ Settings & Tag Tree Editor`**.
2. **🛡️ 100% Non-Destructive & 📄 XMP Sidecar Integration (`[👁️ XMP Preview]` Hold-to-Compare & Safe Import)**
   * Rotating, cropping, horizon leveling, adjusting exposure/color, or marking photos as "Rj (Reject)" never alters or deletes your original files on disk.
   * When companion `.xmp` sidecar files (from Lightroom, Adobe Camera Raw, etc.) are detected, hold down the **`[👁️ XMP Preview]`** button in the Inspector to temporarily preview XMP adjustments, or click **`📥 Import Rating & Tags`** to safely map XMP ratings to Photo Manager's 4-tier scale and import keywords under an isolated **`XMP/...` root** without polluting your existing tag tree.
3. **📦 Self-Contained In-App Storage (`storage/`) & Automatic Sidecar Tracking**
   * Select external photos and click **`📥 Import to storage`** to copy them into the app's internal `storage/` folder. Create/rename subfolders, move photos between `storage` subfolders (including Drag & Drop), rename files (`F2` single rename or batch sequential rename with live preview), and export folders right from the UI.
   * Companion sidecars (`.xmp`, `.pp3`, `.dop`, etc.) and cross-folder paired RAW files automatically follow your photos during import, move, rename, and export!
4. **🔒 100% Offline & Privacy-First**
   * Your photos are never uploaded to any cloud. AI auto-tagging (ONNX Runtime / CLIP) and reverse geocoding (GPS to Country / Prefecture / City) run completely locally on your PC.
5. **⚡ Fast One-Handed Culling, ⚖️ 2-Up Duel Comparison & 📊 Live RGB Histogram**
   * **4-Tier Rating (`Ex / Gd / Nm / Rj`)**: Cull tens of thousands of photos using just number keys (`1`: Ex / `2`: Gd / `3`: Rj / `0`: Nm). Rejected photos hide immediately from the grid.
   * **Smart Burst, Exposure Bracketing (AEB) & Duplicate Stacking**: Automatically groups continuous bursts, exposure brackets, and duplicate files across folders. Compare EV+ / EV- brackets or burst shots instantly with `↑` / `↓` keys in Lightbox.
   * **⚖️ 2-Up Side-by-Side Duel & 📊 Live Histogram**: Compare two photos side-by-side with **synchronized zoom & pan**, highlight Exif differences, and run knockout selection (`W` to crown Right as the new champion). Includes a real-time RGB & Luminance waveform histogram (`H` key).
   * **📤 Smart Takeout (with `.xmp` Export) & 🎞️ Betayaki Contact Sheet HTML**: Batch-export selected shots with non-destructive edits baked in, custom resizing, chronological renaming, Exif privacy stripping, and optional `.xmp` sidecar generation—or generate a classic darkroom negative contact sheet HTML (`Betayaki`) with interactive red grease-pencil `⭕` marks and A4 print support.
6. **🧪 Photography Lab & 🗾 47-Prefecture Conquest Map / Walk Trajectory**
   * **🏆 Winning Lens & Sweet-Spot Chart**: Automatically analyzes your `Ex` / `Gd` keeper rates to rank your best-performing lenses and sweet-spot focal lengths, apertures, and shooting hours.
   * **🌅 Solar Elevation Lab & ⚠️ "Lens Shaker" Detector**: Computes sun angle from timestamp & GPS to filter Golden Hour, Blue Hour, and Night/Astro shots, plus one-click extraction of slow-shutter camera-shake risks (`< 1/focal_length sec`).
   * **🗾 47-Prefecture Conquest Map, Heatmap & 👣 Walk Trajectory**: Visualize your travel footprint across Japan, shooting density heatmaps, and chronological photo-walk routes.
   * **🎂 On This Day & 🎲 Unrated Folder Gacha**: Rediscover photos taken on the same date across years, or spin the random `Gacha` to pick an unculled folder.
7. **📜 Washi / 🌙 Urusi Themes & 🇯🇵 JP ⇄ 🇺🇸 EN Real-Time Language Toggle**
   * Switch between bright Japanese paper (`📜 Washi`) and darkroom ink (`🌙 Urusi`) themes, and toggle the entire UI & built-in manual between Japanese and English in one click.
8. **🔌 USB Portable & 📱 Smartphone Offline Culling (`PhotoManager_Mobile.html`)**
   * **USB Portable**: Run directly from a USB flash drive or external SSD on any Windows PC (even without Python installed). Automatically tracks drive letter changes (e.g., `D:` → `E:`).
   * **Mobile Offline Culling**: High-quality WebP thumbnails are stored directly inside the SQLite database (`cache/library.db`). Using WebAssembly (`sql.js`), you can load the `.db` file on your smartphone in ~1 second without carrying hundreds of GBs of RAW files, cull with one thumb in bed or on the train, and sync ratings back to your PC later!

---

## 🚀 Setup & How to Run

### Option A: Using the Release ZIP Package (Recommended — Portable Python Included)
1. **First-Time Install (Full Package)**:
   * Download the full `.zip` package from **[GitHub Releases](../../releases)** and extract it to any folder (or USB drive).
   * Double-click **`PhotoManager.exe`** to start (opens in a dedicated borderless app window without a command prompt).
   * *(Note: If SmartScreen blocks the first launch or if your antivirus removes the `.exe`, double-click **`Build.bat`** once to cleanly re-compile `PhotoManager.exe` locally.)*
2. **Updating from v2.42 (Lightweight Diff Package `PhotoManager_v2.43diff.zip`)**:
   * If you already have `v2.42` running, simply extract **`PhotoManager_v2.43diff.zip`** and overwrite your existing folder—your `python/`, `models/`, `cache/` (database), and `storage/` remain untouched!

### Option B: Cloning / Downloading Source from GitHub
The git repository does not include the large portable Python runtime (`python/`). On your first run, follow these two steps (no system-wide Python installation required):

1. **Double-click `setup_portable_python.bat`** (Requires internet connection, first time only)
   * Automatically downloads official Python 3.11 Embeddable and required packages (FastAPI, Pillow, rawpy, ONNX Runtime, etc.) into the `python/` folder.
2. **Double-click `Build.bat`**
   * Compiles `PhotoManager.exe` and starts the application.

---

## 📖 Documentation

* 📘 **Built-in Interactive Manual**: Click the **`? Help` (`F1`)** button at the top-right of the app (fully available in both `🇯🇵 JP` and `🇺🇸 EN`!).
* 📘 **[User Manual (`MANUAL.md` - Japanese)](MANUAL.md)**
* 🔌 **[USB Portable Guide (`README_USB.md` - Japanese)](README_USB.md)**
* 🧠 **[Architecture & Technical Knowledge (`docs/knowledge/`)](docs/knowledge/README.md)**

---

## ⚖️ License

* **Photo Manager Source Code**:
  * The original source code of this project is licensed under the **[MIT License](LICENSE)**.
  * Provided "AS IS" without warranty of any kind. Feel free to use, modify, or translate it!
* **🚨 [IMPORTANT] Licenses of Bundled / Third-Party Libraries**:
  * **If you modify, redistribute, or package this software, please strictly comply with the licenses of the third-party libraries used!**
  * Full license texts and notices for all dependencies (Python, FastAPI, Pillow, **LibRaw / rawpy [LGPL 2.1]**, **pystray [LGPL 3.0]**, ONNX Runtime, sql.js, etc.) and offline geocoding datasets (Code for Fukui, GeoNames, etc. [CC BY 4.0 / ODbL]) are included in **[`LICENSES/NOTICE.txt`](LICENSES/NOTICE.txt)** and the **[`LICENSES/`](LICENSES)** directory.
  * In particular, to comply with **LibRaw (LGPL 2.1)** bundled in `rawpy`, always keep dynamic linking (DLLs) intact and **do NOT** bundle the app into a single executable using `PyInstaller --onefile`.
