# Changelog

All notable changes to Context Lens are documented in this file.

## [1.3.1] - 2026-11-15

### Fixed
- **Official Quota Bucket Mapping (`3p-*` vs `gemini-*`)**: Fixed `classifyBucketPool()` in `scripts/cli-quota-sync.mjs` so `agy` third-party buckets (`3p-5h`, `3p-weekly`) map accurately to **`Claude & GPT`** instead of falling back into **`Gemini Models`**. Unknown bucket IDs no longer overwrite identified pool buckets.
- **TUI `/usage` Fallback Parser**: Fixed fractional percentage regex (`84.78%` -> `85%`, `28.85%` -> `29%`, avoiding partial matches after `.`), skipped `Models within this group:` lines, and linked multi-line `Refreshes in ...` countdowns to the preceding window.
- **PTY `/usage` Submission Timing**: Added brief post-idle stabilization and fallback Enter retry when triggering `/usage` inside headless PTY sync runs.

### Improved
- **Open-Source Portability**: Added multi-environment Node.js (`>= 22.5`) auto-discovery (`Homebrew`, `nvm`, `fnm`, `volta`, `mise`, `asdf`) in `ContextLensBar.swift` so macOS GUI & LaunchAgent launches work without shell PATH inheritance.
- **Universal Binary & Installer**: Added `--universal` (`arm64` + `x86_64`) support to `menubar/build.sh`, created one-command `install.sh` (with `--uninstall`), `package.json`, `scripts/validate-repo.mjs`, bilingual docs, and GitHub Actions CI / Release workflows.

## [1.3.0] - 2026-11-15

### Added
- **Official `agy` CLI Cloud Sync**: Integrated `scripts/cli-quota-sync.mjs` using official `agy --settings statusLine` + `/usage` PTY hooks to fetch exact cloud remaining percentages and reset timestamps automatically (on launch and every 180s) or on demand (`↻`).
- **Unified Dual-Pool Architecture**: Aligned completely with Antigravity `Models & Usage`: **`Gemini Models`** (Carbon / Argon / Hydrogen / Pro / Flash) and **`Claude & GPT`** (Claude Opus / Sonnet · GPT-OSS).
- **Proxy Configuration UI & Auto-Detection**: Added automatic macOS system proxy detection (`scutil --proxy`), `--set-proxy` CLI flag, and inline proxy configuration inside `ContextLensBar.app`.
- **Pricing Updates**: Added `Gemini 4 Hydrogen` and `GPT-OSS` reference pricing rules and fixed decimal truncation in model-selection parsing.

### Removed
- Removed manual calibration controls in `ContextLensBar.app` in favor of official `agy` CLI sync (with automatic local rolling estimation fallback when offline).

## [1.2.0] - 2026-11-14

### Added
- **7-Day Weekly Limit & Pacing Runway**: Added 7d quota meters alongside 5h limits, compaction-aware rolling estimates, `dual_pct` status bar mode, and runway/reset pacing indicators.

## [1.1.0] - 2026-11-13

### Added
- **Native macOS Menu Bar App (`ContextLensBar.app`)**: Zero-dependency SwiftUI + AppKit status bar popover displaying active session context occupancy, cache hit rate, quota pools, monthly API reference cost, and LaunchAgent auto-start toggle.

## [1.0.0] - 2026-11-12

### Added
- **Initial Non-Invasive Antigravity Plugin**: Added `plugin.json`, `hooks.json` (`SessionStart` model recorder), `skills/context-lens/SKILL.md` (`/context-lens`), and `sidecars/dashboard` (live 6-category context breakdown, 52-week heatmap, and standalone web dashboard mode).
