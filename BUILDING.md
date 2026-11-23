# Building Webring Studio Executables

Webring Studio uses [`electron-builder`](https://www.electron.build/) configured in [electron-builder.yml](./electron-builder.yml) to produce desktop executables for **Windows**, **macOS**, and **Linux** (including **Arch Linux / Omarchy** and Debian/Ubuntu).

Builds are **unsigned by default** so anyone can compile an executable for their own machine without purchasing code-signing certificates.

---

## Prerequisites

- **Node.js 24** and `npm` (the repo includes `.nvmrc`; run `nvm use` if you use nvm)
- **Git**
- Install dependencies once:
  ```bash
  npm install
  ```

> **Host OS note:** Build each platform on its matching OS for best results:
> - Build **Windows** executables on Windows.
> - Build **macOS** `.dmg` / `.zip` bundles on macOS (Xcode Command Line Tools required).
> - Build **Linux** `.AppImage` / `.deb` / `.pacman` packages on Linux (or WSL2 on Windows).

---

## Quick Build Commands

All packaged artifacts are written to `release/` (gitignored).

| Command | Output in `release/` |
| --- | --- |
| `npm run dist` | Builds the default executable(s) for your current OS |
| `npm run pack:dir` | Builds an unpacked app folder (fast local smoke test, no installer) |
| `npm run dist:win` | Windows NSIS installer (`Webring Studio Setup *.exe`) + standalone portable (`Webring Studio-*-portable.exe`) |
| `npm run dist:mac` | macOS `.dmg` and `.zip` (`arm64` and `x64`) |
| `npm run dist:linux` | Linux `.AppImage`, `.deb` (Debian/Ubuntu), and `.pacman` (Arch Linux / Omarchy) |

---

## Platform-Specific Instructions

### Windows

```bash
npm run dist:win
```

Outputs in `release/`:
- `Webring Studio Setup <version>.exe` — standard installer (adds Start Menu & Desktop shortcuts and registers the `webring://` protocol).
- `Webring Studio-<version>-portable.exe` — single standalone executable you can run directly without installing.

**Running an unsigned Windows build:** Windows SmartScreen may show *"Windows protected your PC"*. Click **More info → Run anyway** (only for builds you created yourself or trust).

---

### macOS

```bash
npm run dist:mac
```

Outputs in `release/`:
- `Webring Studio-<version>-arm64.dmg` / `.zip` (Apple Silicon)
- `Webring Studio-<version>.dmg` / `.zip` (Intel x64)

To build only for your Mac's architecture (faster):
```bash
npm run build && npx electron-builder --mac --arm64   # Apple Silicon
npm run build && npx electron-builder --mac --x64     # Intel
```

**Running an unsigned macOS build:** macOS Gatekeeper blocks unsigned apps downloaded or copied across machines. If macOS says the app *"is damaged"* or *"cannot be opened"*, remove the quarantine attribute on your own local build:
```bash
xattr -cr "/Applications/Webring Studio.app"
```
(Or right-click the app in Finder → **Open**.)

---

### Linux (Ubuntu, Debian, Fedora, Arch & Omarchy)

```bash
npm run dist:linux
```

Outputs in `release/`:
- `Webring Studio-<version>.AppImage` — universal single-file executable (works on most distros, including **Omarchy**, Arch, Fedora, Ubuntu).
- `webring-studio_<version>_amd64.deb` — Debian / Ubuntu package (`sudo apt install ./release/webring-studio_*.deb`).
- `webring-studio-<version>.pacman` — native Arch Linux / **Omarchy** package (`sudo pacman -U ./release/webring-studio-*.pacman`).

#### Notes for Omarchy / Arch Linux (Hyprland / Wayland)

- **Installing the native package:**
  ```bash
  sudo pacman -U ./release/webring-studio-*.pacman
  ```
- **Or running the AppImage directly:**
  ```bash
  chmod +x ./release/Webring\ Studio-*.AppImage
  ./release/Webring\ Studio-*.AppImage
  ```
  If FUSE 2 isn't installed on Arch/Omarchy, either install `fuse2` or run with `--appimage-extract-and-run`.
- **Native Wayland (Hyprland):** Launch with Wayland auto-detection for crisp HiDPI scaling on Hyprland:
  ```bash
  ELECTRON_OZONE_PLATFORM_HINT=auto webring-studio
  ```
  *(You can also add `--ozone-platform-hint=auto` to `~/.config/electron-flags.conf`.)*
- **Keyring / Secret Service:** Studio encrypts your signing keys and publish credentials via `libsecret` (e.g. `gnome-keyring`). If your session has no Secret Service daemon running, Studio will notify you before saving any secrets.

---

## Optional: Code Signing & Notarization

Code signing is disabled in `electron-builder.yml` by default (`signExecutable: false` on Windows, `identity: null` on macOS) so local builds work out of the box while still embedding app icons and metadata.

If you have your own signing certificates and want to produce signed distributables:

### Windows (Authenticode)

1. Export your code-signing certificate as a `.pfx` / `.p12` file (or base64-encode it).
2. Set environment variables and override `signExecutable`:
   ```bash
   export CSC_LINK=/path/to/cert.p12
   export CSC_KEY_PASSWORD=your-cert-password
   npm run build && npx electron-builder --win -c.win.signExecutable=true
   ```

### macOS (Developer ID + Apple Notarization)

1. Install your **Developer ID Application** certificate in Keychain (or supply `CSC_LINK` + `CSC_KEY_PASSWORD`).
2. Supply Apple notarization credentials (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`).
3. Override `mac.identity` with your Developer ID identity name (or omit `identity: null`):
   ```bash
   export CSC_LINK=/path/to/developer-id.p12
   export CSC_KEY_PASSWORD=your-cert-password
   export APPLE_ID=you@example.com
   export APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
   export APPLE_TEAM_ID=YOURTEAMID
   npm run build && npx electron-builder --mac -c.mac.identity="Developer ID Application: Your Name (YOURTEAMID)" -c.mac.hardenedRuntime=true
   ```

See the [electron-builder code signing documentation](https://www.electron.build/code-signing) for CI/CD workflows and hardware-token (EV) signing.
