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
* 🇯🇵 **The UI is Japanese-Only & My English Skill is ZERO! 🌍**
  * I am a Japanese developer with **zero English skills**! If you talk to me in English, I will rely 100% on machine translation and will probably sound like a slightly weird person lol.
  * Also, **the app's UI is currently in Japanese only!** However, since the UI runs in an Edge/Chrome `--app` window (HTML/JS) and is released under the MIT License, feel free to ask your favorite AI to translate the UI into English if you'd like!
* 🛠️ **Personal Hobby Project (About Feature Requests & Issues)**
  * This software is built for my own personal photography workflow.
  * While I happily read feature requests and bug reports for reference, **whether they actually get implemented or fixed depends entirely on the AI's mood!** Please enjoy it with a *"lucky if it works for me as-is"* mindset.

---

## ⚠️ About False-Positive "SmartScreen" Warnings on First Launch

When downloading this software from GitHub Releases and launching it for the first time, you may see a blue confirmation screen like **"Windows protected your PC (Microsoft Defender SmartScreen)"**.

### ❓ Why does this warning appear? (Is it safe?)
* **There are NO viruses or malicious programs whatsoever.** In fact, this app operates **100% offline** with no external network communication.
* Because this is a personal hobby project without an expensive commercial EV Code Signing Certificate, Windows Defender SmartScreen automatically flags unsigned `.exe` launchers (`PhotoManager.exe`) as *"unknown executable"*.

### 🛡️ How to Launch (Direct Run or Local Rebuild via `Build.bat`)
1. **Direct Launch**:
   * If the blue SmartScreen prompt appears, simply click **"More info" → "Run anyway"** (it won't ask again after the first run).
2. **Clean Local Build via `Build.bat` (Optional / Fallback)**:
   * Double-clicking **`Build.bat`** uses Windows' built-in official C# compiler (`csc.exe`) to compile a tiny, plain-text source file ([`launcher/Launcher.cs`](launcher/Launcher.cs) — you can inspect all of it in Notepad!) directly into **`PhotoManager.exe`** and **`autorun.inf`** on your own PC in 1 second, and immediately launches the app without download-origin blocks.

---

## ✨ Key Features

1. **🔍 Obsessive "Exclusive Search (Exclude Filter `[-]`) "**
   * When filtering by tags/albums, you can not only include `[+]` a tag, but also **exclude `[-]` specific tags**.
   * Combined with folder and date filters, this makes it super easy to find **"photos you forgot to add to an album"**!
2. **🛡️ 100% Non-Destructive (Never touches a single byte of your original files)**
   * Rotating, cropping, straightening, adjusting exposure/color in the Lab, or marking photos as "Rejected" never alters or deletes your original files on disk.
3. **🔒 100% Offline & Privacy-First**
   * Your photos are never uploaded to any cloud. AI auto-tagging & semantic similarity search (ONNX Runtime / CLIP) and reverse geocoding (GPS to Country / Prefecture / City) run completely locally on your PC.
4. **⚡ Fast One-Handed Culling, Burst Stacking & Map Visualization**
   * **4-Tier Rating**: Cull tens of thousands of photos using just number keys (`1`: Best / `2`: Good / `3`: Reject / `0`: Unrated). Rejected photos hide immediately from the grid.
   * **Smart Burst, Exposure Bracketing (AEB) & Duplicate Stacking**: Automatically groups continuous bursts, exposure brackets, and duplicate files across folders. Compare EV+ / EV- brackets or burst shots instantly with `↑` / `↓` keys in the lightbox.
   * **Location Map & 47-Prefecture Conquest Map**: Visualize photo locations, GPS route tracks, and your travel footprint on an interactive map.
   * **Smart Takeout (Batch Export)**: Batch-export your selected best shots with non-destructive Lab edits baked in, custom resizing, contact sheets, offline HTML galleries, and Exif privacy stripping.
5. **🔌 USB Portable & 📱 Smartphone Offline Culling (`PhotoManager_Mobile.html`)**
   * **USB Portable**: Run directly from a USB flash drive or external SSD on any Windows PC (even without Python installed). Automatically tracks drive letter changes (e.g., `D:` → `E:`).
   * **Mobile Offline Culling**: High-quality WebP thumbnails are stored directly inside the SQLite database (`cache/library.db`). Using WebAssembly (`sql.js`), you can load the `.db` file on your smartphone in ~1 second without carrying hundreds of GBs of RAW files, cull with one thumb in bed or on the train, and sync ratings back to your PC later!

---

## 🚀 Setup & How to Run

### Option A: Using the Release ZIP Package (Recommended — Portable Python Included)
1. Download the `.zip` package from **[GitHub Releases](../../releases)** and extract it to any folder (or USB drive).
2. Double-click **`PhotoManager.exe`** to start (opens in a dedicated borderless app window without a command prompt).
   * *(Note: If SmartScreen blocks the first launch or if your antivirus removes the `.exe`, double-click **`Build.bat`** once to cleanly re-compile `PhotoManager.exe` locally.)*

### Option B: Cloning / Downloading Source from GitHub
The git repository does not include the large portable Python runtime (`python/`). On your first run, follow these two steps (no system-wide Python installation required):

1. **Double-click `setup_portable_python.bat`** (Requires internet connection, first time only)
   * Automatically downloads official Python 3.11 Embeddable and required packages (FastAPI, Pillow, rawpy, ONNX Runtime, etc.) into the `python/` folder.
2. **Double-click `Build.bat`**
   * Compiles `PhotoManager.exe` and starts the application.

---

## 📖 Documentation (Japanese)

* 📘 **[User Manual (`MANUAL.md`)](MANUAL.md)**
* 🔌 **[USB Portable Guide (`README_USB.md`)](README_USB.md)**
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
