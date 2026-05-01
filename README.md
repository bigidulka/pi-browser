# pi-browser

Terminal Chromium browser manager for [Pi](https://pi.dev) coding agent. 30 tools, 7 browsers, cross-platform.

<p align="center">
  <strong>Launch → Navigate → Snap → Click → Extract → DevTools</strong>
</p>

## What It Does

Pi-browser gives your Pi coding agent full control over a Chromium-based browser. Navigate pages, click elements, fill forms, inspect network requests, run JavaScript, take screenshots — all from the terminal.

```
You: "Open Hacker News and show me top 5 stories"
Pi:  🌐 Launching brave...
     🌐 Navigating to https://news.ycombinator.com
     📸 Snapshot with refs...
     1. Uber Torches 2026 AI Budget on Claude Code (278 points)
     2. Ask HN: Who is hiring? (133 points)
     3. whohas – cross-repo package search (65 points)
     ...
```

## Features

- **30 agent tools** — navigate, snap, click, fill, eval, screenshot, network, console, perf, audit...
- **7 browsers** — Brave, Chrome, Chromium, Edge, Vivaldi, Opera, Arc
- **Cross-platform** — Linux, macOS, Windows
- **Multi-profile** — isolated browser profiles in `~/.cache/pi-browser/`
- **DevTools** — network requests, console, performance, cookies, storage, HAR, coverage, Lighthouse
- **Token-efficient** — query-filtered snapshots save 95-99% tokens on large pages
- **Ref-based selection** — `@e1`, `@e2` instead of fragile CSS selectors
- **Zero runtime deps** — backend uses only Node.js built-ins
- **TUI integration** — status bar, widget, `/browser` command

## Install

```bash
pi install npm:pi-browser
```

Or from GitHub:

```bash
pi install git:github.com/bigidulka/pi-browser
```

## Quick Start

```
You: "Launch browser and go to https://news.ycombinator.com"
You: "Open https://example.com and fill the login form"
You: "Take a screenshot of the current page"
You: "Check network requests and console errors"
```

## Tools (30)

### Navigation & Interaction

| Tool | Description |
|------|-------------|
| `browser_launch` | Launch Chromium browser with profile |
| `browser_detect` | Scan system for installed browsers |
| `browser_list` | List open tabs |
| `browser_open` | Open new tab with URL |
| `browser_navigate` | Go to URL / back / forward / reload |
| `browser_snap` | Accessibility tree snapshot (refs, query, depth) |
| `browser_click` | Click element by `@ref` or selector |
| `browser_fill` | Fill form input |
| `browser_type` | Type text at focus |
| `browser_key` | Press key combo (Enter, Control+A...) |
| `browser_screenshot` | Capture viewport or full page |
| `browser_eval` | Evaluate JavaScript in page |
| `browser_html` | Get element or page HTML |
| `browser_scroll` | Scroll up/down/top/bottom |
| `browser_select` | Switch active tab |
| `browser_close` | Close tab |
| `browser_extract` | Extract visible text content |
| `browser_wait` | Wait for element or page event |
| `browser_form` | Batch fill form fields |

### DevTools

| Tool | Description |
|------|-------------|
| `browser_net` | Network requests list + detail |
| `browser_console` | Browser console (capture/list/detail) |
| `browser_perf` | Core Web Vitals + metrics |
| `browser_throttle` | Network throttle (3g/4g/offline) |
| `browser_intercept` | Block/mock network requests |
| `browser_har` | Record HTTP traffic as HAR |
| `browser_domsnapshot` | DOM with bounding rects + styles |
| `browser_cookies` | Cookies (list/set/clear) |
| `browser_storage` | localStorage / sessionStorage |
| `browser_coverage` | CSS/JS code coverage |
| `browser_audit` | Lighthouse audit |

## Commands

| Command | Description |
|---------|-------------|
| `/browser status` | Show connection status |
| `/browser detect` | List installed browsers |
| `/browser list` | Interactive tab selector |
| `/browser launch` | Launch browser via TUI dialog |
| `/browser stop` | Stop daemons (browser stays open) |

## Browsers

| Browser | Linux | macOS | Windows |
|---------|-------|-------|---------|
| Brave | ✅ | ✅ | ✅ |
| Google Chrome | ✅ | ✅ | ✅ |
| Chromium | ✅ | ✅ | ✅ |
| Microsoft Edge | ✅ | ✅ | ✅ |
| Vivaldi | ✅ | ✅ | ✅ |
| Opera | ✅ | ✅ | ✅ |
| Arc | — | ✅ | ✅ |

Auto-detect: if no browser specified, picks first available.

## Profiles

Each profile is an isolated browser data directory:

```
~/.cache/pi-browser/          (Linux)
~/Library/Application Support/pi-browser/  (macOS)
%APPDATA%/pi-browser/         (Windows)
  ├── default/
  ├── work/
  └── shopping/
```

```
You: "Launch browser with profile 'work'"
```

## Architecture

```
Pi TUI (terminal)
  └─ pi-browser extension (TypeScript)
       ├─ registerTool() × 30
       ├─ registerCommand("/browser")
       └─ spawn("chromex", args) → CLI
            └─ CDP WebSocket → Browser
```

- **Extension API** — native Pi tools, no MCP overhead
- **chromex-mcp** — zero-dependency CDP client + daemon manager
- **CDP** — Chrome DevTools Protocol (part of Chromium, stable)

## Security

- Profile names sanitized (path traversal prevention)
- URL validation (http/https only)
- CSS selector sanitization in extract
- Output truncation (30KB max, 20KB for eval)
- Browser process detached — survives Pi shutdown

## Requirements

- [Pi](https://pi.dev) coding agent
- Node.js 22+
- Any Chromium-based browser

## License

MIT
