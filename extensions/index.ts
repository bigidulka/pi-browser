/**
 * pi-browser — Terminal Chromium browser manager for Pi
 *
 * Cross-platform: Linux, macOS, Windows
 * Browsers: Brave, Chrome, Chromium, Edge, Vivaldi, Opera, Arc
 * Backend: chromex CLI (CDP over WebSocket, per-tab daemons)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { resolve, join } from "node:path";
import { homedir, tmpdir, platform } from "node:os";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { spawn, execSync } from "node:child_process";

// ─── Platform Detection ──────────────────────────────────────────────────────

const IS_WIN = platform() === "win32";
const IS_MAC = platform() === "darwin";

// ─── Constants ────────────────────────────────────────────────────────────────

const CHROMEX_BIN = resolve(
  __dirname,
  "node_modules",
  ".bin",
  IS_WIN ? "chromex.cmd" : "chromex"
);
const PROFILES_DIR = platformConfigDir();
const TMP_DIR = tmpdir();
const DEFAULT_TIMEOUT = 30_000;
const MAX_OUTPUT = 30_000;
const MAX_EVAL_OUTPUT = 20_000;

/** Platform-aware config directory */
function platformConfigDir(): string {
  if (IS_WIN) return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "pi-browser");
  if (IS_MAC) return join(homedir(), "Library", "Application Support", "pi-browser");
  const xdg = process.env.XDG_CACHE_HOME;
  return xdg ? join(xdg, "pi-browser") : join(homedir(), ".cache", "pi-browser");
}

/** Platform-aware temp file path */
function tmpPath(filename: string): string {
  return join(TMP_DIR, filename);
}

// ─── Module-level state ──────────────────────────────────────────────────────

interface BrowserState {
  activeTarget: string | null;
  activeProfile: string;
  connected: boolean;
}

let browserState: BrowserState = { activeTarget: null, activeProfile: "default", connected: false };

function portFilePath(profile: string): string {
  return resolve(PROFILES_DIR, profile, IS_WIN ? "DevToolsActivePort" : "DevToolsActivePort");
}

// ─── Security ─────────────────────────────────────────────────────────────────

function sanitizeProfile(name: string): string {
  return (name || "default").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "default";
}

function isValidUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) || url === "about:blank";
}

function sanitizeSelector(sel: string): string {
  return sel.replace(/[\\'"`]/g, "");
}

// ─── Truncation ───────────────────────────────────────────────────────────────

function truncate(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n\n[...truncated ${text.length - max} chars]`;
}

// ─── Browser Binary Resolution (cross-platform) ──────────────────────────────

interface BrowserDef {
  /** Human name */
  label: string;
  /** Binary names to search in PATH */
  commands: string[];
  /** Absolute paths to try per platform */
  paths: { linux: string[]; darwin: string[]; win32: string[] };
}

const BROWSERS: Record<string, BrowserDef> = {
  brave: {
    label: "Brave",
    commands: ["brave-browser", "brave"],
    paths: {
      linux: ["/usr/bin/brave", "/usr/bin/brave-browser", "/opt/brave-bin/brave", "/opt/brave.com/brave/brave"],
      darwin: ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
      win32: [
        join(process.env.PROGRAMFILES || "C:\\Program Files", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        join(process.env.LOCALAPPDATA || "", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      ],
    },
  },
  chrome: {
    label: "Google Chrome",
    commands: ["google-chrome-stable", "google-chrome", "chrome"],
    paths: {
      linux: ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"],
      darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
      win32: [
        join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
        join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
        join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
      ],
    },
  },
  chromium: {
    label: "Chromium",
    commands: ["chromium-browser", "chromium"],
    paths: {
      linux: ["/usr/bin/chromium-browser", "/usr/bin/chromium", "/snap/bin/chromium"],
      darwin: ["/Applications/Chromium.app/Contents/MacOS/Chromium"],
      win32: [
        join(process.env.LOCALAPPDATA || "", "Chromium", "Application", "chrome.exe"),
        join(process.env.PROGRAMFILES || "C:\\Program Files", "Chromium", "Application", "chrome.exe"),
      ],
    },
  },
  edge: {
    label: "Microsoft Edge",
    commands: ["microsoft-edge", "microsoft-edge-stable", "msedge"],
    paths: {
      linux: ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable", "/usr/bin/msedge"],
      darwin: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
      win32: [
        join(process.env.PROGRAMFILES || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
        join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
      ],
    },
  },
  vivaldi: {
    label: "Vivaldi",
    commands: ["vivaldi"],
    paths: {
      linux: ["/usr/bin/vivaldi", "/usr/bin/vivaldi-stable", "/opt/vivaldi/vivaldi"],
      darwin: ["/Applications/Vivaldi.app/Contents/MacOS/Vivaldi"],
      win32: [
        join(process.env.LOCALAPPDATA || "", "Vivaldi", "Application", "vivaldi.exe"),
        join(process.env.PROGRAMFILES || "C:\\Program Files", "Vivaldi", "Application", "vivaldi.exe"),
      ],
    },
  },
  opera: {
    label: "Opera",
    commands: ["opera"],
    paths: {
      linux: ["/usr/bin/opera", "/usr/lib/x86_64-linux-gnu/opera/opera"],
      darwin: ["/Applications/Opera.app/Contents/MacOS/Opera"],
      win32: [
        join(process.env.LOCALAPPDATA || "", "Programs", "Opera", "opera.exe"),
        join(process.env.PROGRAMFILES || "C:\\Program Files", "Opera", "opera.exe"),
      ],
    },
  },
  arc: {
    label: "Arc",
    commands: ["arc"],
    paths: {
      linux: [],
      darwin: ["/Applications/Arc.app/Contents/MacOS/Arc"],
      win32: [
        join(process.env.LOCALAPPDATA || "", "Arc", "Application", "arc.exe"),
      ],
    },
  },
};

const BROWSER_NAMES = Object.keys(BROWSERS) as [string, ...string[]];

/** Resolve browser binary across platforms */
function resolveBrowserBin(name: string): string | null {
  if (!name || name === "undefined" || !BROWSERS[name]) name = "brave";
  const def = BROWSERS[name];

  // 1. Try platform-specific absolute paths
  const platPaths = def.paths[platform() as "linux" | "darwin" | "win32"] ?? [];
  for (const p of platPaths) {
    if (existsSync(p)) return p;
  }

  // 2. Try commands in PATH via which/where
  const whichCmd = IS_WIN ? "where" : "which";
  for (const cmd of def.commands) {
    try {
      const result = execSync(`${whichCmd} ${cmd} 2>nul`, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
      if (result) {
        // where returns multiple lines on Windows — take first
        return result.split(/\r?\n/)[0].trim();
      }
    } catch { /* not found */ }
  }

  return null;
}

/** Detect all available browsers on this system */
function detectBrowsers(): string[] {
  return BROWSER_NAMES.filter((name) => resolveBrowserBin(name) !== null);
}

// ─── CLI Runner ───────────────────────────────────────────────────────────────

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

function resolvePortFileCandidates(): Array<{ profile: string; path: string; mtimeMs: number }> {
  const candidates: Array<{ profile: string; path: string; mtimeMs: number }> = [];

  const activePortFile = portFilePath(browserState.activeProfile);
  if (existsSync(activePortFile)) {
    candidates.push({ profile: browserState.activeProfile, path: activePortFile, mtimeMs: statSync(activePortFile).mtimeMs });
  }

  if (!existsSync(PROFILES_DIR)) return candidates;
  const profileDirs = readdirSync(PROFILES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const profile of profileDirs) {
    if (profile === browserState.activeProfile) continue;
    const candidate = portFilePath(profile);
    if (existsSync(candidate)) {
      candidates.push({ profile, path: candidate, mtimeMs: statSync(candidate).mtimeMs });
    }
  }

  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function runChromexOnce(args: string[], timeout: number, env: NodeJS.ProcessEnv): Promise<ExecResult> {
  return new Promise((resolve) => {
    const cmd = IS_WIN ? CHROMEX_BIN : CHROMEX_BIN;
    const proc = spawn(cmd, args, {
      timeout,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // Windows needs shell for .cmd wrappers
      ...(IS_WIN ? { shell: true } : {}),
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1, killed: false }));
    proc.on("error", (err) => resolve({ stdout: "", stderr: err.message, code: 1, killed: false }));
    proc.on("timeout", () => {
      proc.kill(IS_WIN ? undefined : "SIGKILL");
      resolve({ stdout, stderr, code: -1, killed: true });
    });
  });
}

function runChromex(args: string[], timeout = DEFAULT_TIMEOUT): Promise<ExecResult> {
  const baseEnv = { ...process.env };
  const candidates = resolvePortFileCandidates();
  const shouldProbe = args[0] === "list";

  if (!shouldProbe) {
    const primary = candidates[0];
    const env = primary ? { ...baseEnv, CDP_PORT_FILE: primary.path } : baseEnv;
    if (primary) browserState.activeProfile = primary.profile;
    return runChromexOnce(args, timeout, env);
  }

  if (candidates.length === 0) {
    return runChromexOnce(args, timeout, baseEnv);
  }

  return candidates.reduce<Promise<ExecResult>>(async (prev, candidate, idx) => {
    const res = idx === 0 ? await prev : prev;
    if (idx > 0 && res.code === 0) return res;
    const env = { ...baseEnv, CDP_PORT_FILE: candidate.path };
    const attempt = await runChromexOnce(args, timeout, env);
    if (attempt.code === 0) browserState.activeProfile = candidate.profile;
    return attempt;
  }, Promise.resolve({ stdout: "", stderr: "", code: 1, killed: false }));
}

function targetArg(target: string | undefined): string {
  const t = target ?? browserState.activeTarget;
  if (!t) throw new Error("No active tab. Use browser_list then browser_select, or browser_launch.");
  return t;
}

// ─── Output Parsing ───────────────────────────────────────────────────────────

interface TabInfo {
  targetId: string;
  title: string;
  url: string;
}

function parseList(output: string): TabInfo[] {
  return output
    .trim()
    .split("\n")
    .filter((l) => l.trim())
    .map((line) => {
      const parts = line.trim().split(/\s{2,}|\t/);
      return {
        targetId: parts[0] ?? "",
        title: parts.slice(1, -1).join("  ") || "",
        url: parts[parts.length - 1] ?? "",
      };
    })
    .filter((t) => t.targetId && t.url);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ensureProfileDir(name: string): string {
  const dir = resolve(PROFILES_DIR, sanitizeProfile(name));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function fmtError(tool: string, res: ExecResult): string {
  const err = (res.stderr || res.stdout || "").trim().slice(0, 500);
  return res.killed ? `${tool}: timed out` : `${tool} failed: ${err}`;
}

// ─── Extension Entry ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  browserState = { activeTarget: null, activeProfile: "default", connected: false };

  pi.on("session_start", async (_event, ctx) => {
    try {
      const res = await runChromex(["list"], 5000);
      if (res.code === 0 && res.stdout.trim()) {
        const tabs = parseList(res.stdout);
        if (tabs.length > 0) {
          browserState.activeTarget = tabs[0].targetId;
          browserState.connected = true;
          ctx.ui.setStatus("pi-browser", `🌐 ${tabs[0].title.slice(0, 30)}`);
          return;
        }
      }
    } catch { /* no browser */ }
    ctx.ui.setStatus("pi-browser", "🌐 idle");
  });

  pi.on("session_shutdown", async () => { browserState.connected = false; });

  // ═══════════════════════════════════════════════════════════════════════════
  // TOOLS
  // ═══════════════════════════════════════════════════════════════════════════

  // --- browser_launch ---
  pi.registerTool({
    name: "browser_launch",
    label: "Launch Browser",
    description: `Launch a Chromium-based browser. Supported: ${BROWSER_NAMES.join(", ")}. Creates profile if needed.`,
    promptSnippet: "Launch browser to start browsing",
    promptGuidelines: ["Use browser_launch when no browser is running or you need a fresh browser instance."],
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "URL to open on launch" })),
      profile: Type.Optional(Type.String({ description: "Profile name (default: 'default')" })),
      browser: Type.Optional(StringEnum(BROWSER_NAMES, { description: "Browser binary (default: auto-detect first available)" })),
      headless: Type.Optional(Type.Boolean({ description: "Run headless (no GUI)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Cancelled");

      const profileName = sanitizeProfile(params.profile ?? "default");
      browserState.activeProfile = profileName;
      const profileDir = ensureProfileDir(profileName);

      // Resolve browser — auto-detect if not specified
      const browserKey = (!params.browser || params.browser === "undefined") ? null : params.browser;
      let browserBin: string | null = null;
      let browserName: string = browserKey ?? "auto";

      if (browserKey) {
        browserBin = resolveBrowserBin(browserKey);
      } else {
        // Auto-detect: try all browsers, pick first available
        for (const name of BROWSER_NAMES) {
          const bin = resolveBrowserBin(name);
          if (bin) { browserBin = bin; browserName = name; break; }
        }
      }

      if (!browserBin) {
        const detected = detectBrowsers();
        return {
          content: [{
            type: "text",
            text: detected.length === 0
              ? "No Chromium-based browser found. Install one of: " + BROWSER_NAMES.join(", ")
              : `Browser '${browserName}' not found. Available: ${detected.join(", ")}`,
          }],
          isError: true,
        };
      }

      if (params.url && !isValidUrl(params.url)) {
        return { content: [{ type: "text", text: `Invalid URL: ${params.url}` }], isError: true };
      }

      const spawnArgs = [
        "--remote-debugging-port=0",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${profileDir}`,
      ];
      if (params.headless) spawnArgs.push("--headless=new");
      if (params.url) spawnArgs.push(params.url);

      try {
        const child = spawn(browserBin, spawnArgs, {
          detached: !IS_WIN,
          stdio: "ignore",
          ...(IS_WIN ? { shell: true } : {}),
        });
        child.unref();
        await new Promise<void>((resolve, reject) => {
          child.on("error", reject);
          setTimeout(() => resolve(), 100);
        });
      } catch (err: any) {
        return { content: [{ type: "text", text: `Failed to spawn: ${err.message}` }], isError: true };
      }

      // Wait for DevToolsActivePort
      const portFile = portFilePath(profileName);
      let found = false;
      for (let i = 0; i < 20; i++) {
        if (signal?.aborted) throw new Error("Cancelled");
        await new Promise((r) => setTimeout(r, 500));
        if (existsSync(portFile)) { found = true; break; }
      }

      if (!found) {
        return {
          content: [{ type: "text", text: `Browser launched (${browserName}) but DevToolsActivePort not found after 10s. Use browser_list.` }],
        };
      }

      await new Promise((r) => setTimeout(r, 1000));
      try {
        const listRes = await runChromex(["list"], 5000);
        if (listRes.code === 0 && listRes.stdout.trim()) {
          const tabs = parseList(listRes.stdout);
          if (tabs.length > 0) {
            browserState.activeTarget = tabs[0].targetId;
            browserState.connected = true;
            ctx.ui.setStatus("pi-browser", `🌐 ${tabs[0].title.slice(0, 30)}`);
          }
          return {
            content: [{ type: "text", text: `Browser launched (${browserName}, profile: ${profileName}).\n\n${truncate(listRes.stdout.trim())}` }],
            details: { profile: profileName, browser: browserName, tabs },
          };
        }
      } catch { /* */ }

      browserState.connected = true;
      return {
        content: [{ type: "text", text: `Browser launched (${browserName}, profile: ${profileName}). Use browser_list to see tabs.` }],
        details: { profile: profileName, browser: browserName },
      };
    },
  });

  // --- browser_detect ---
  pi.registerTool({
    name: "browser_detect",
    label: "Detect Available Browsers",
    description: "Scan the system for installed Chromium-based browsers. Returns list of available browser names.",
    promptSnippet: "Detect installed browsers",
    promptGuidelines: ["Use browser_detect to see which browsers are available before launching."],
    parameters: Type.Object({}),
    async execute() {
      const detected = detectBrowsers();
      const lines = detected.map((name) => {
        const bin = resolveBrowserBin(name);
        return `  ${BROWSERS[name].label}: ${name} (${bin})`;
      });
      return {
        content: [{ type: "text", text: detected.length === 0 ? "No browsers found." : `Available browsers:\n${lines.join("\n")}` }],
        details: { browsers: detected },
      };
    },
  });

  // --- browser_init ---
  pi.registerTool({
    name: "browser_init",
    label: "Attach to Browser",
    description: "Attach to an already running browser using an existing DevTools port.",
    promptSnippet: "Attach to already running browser",
    promptGuidelines: ["Use browser_init to connect without launching a new browser."],
    parameters: Type.Object({
      profile: Type.Optional(Type.String({ description: "Profile name (optional). If set, only this profile is used." })),
    }),
    async execute(_id, params) {
      if (params.profile) {
        const profileName = sanitizeProfile(params.profile);
        browserState.activeProfile = profileName;
        const portFile = portFilePath(profileName);
        if (!existsSync(portFile)) {
          return {
            content: [{ type: "text", text: `No DevToolsActivePort for profile '${profileName}'. Launch browser with that profile first.` }],
            isError: true,
          };
        }
      }

      const res = await runChromex(["list"], 5000);
      if (res.code !== 0 || !res.stdout.trim()) {
        return { content: [{ type: "text", text: "No browser connected. Start a browser with remote debugging or use browser_launch." }], isError: true };
      }

      const tabs = parseList(res.stdout);
      if (tabs.length > 0) {
        browserState.activeTarget = tabs[0].targetId;
        browserState.connected = true;
        return {
          content: [{ type: "text", text: `Browser connected (profile: ${browserState.activeProfile}).\n\n${truncate(res.stdout.trim())}` }],
          details: { tabs, activeTarget: browserState.activeTarget, profile: browserState.activeProfile },
        };
      }

      browserState.connected = true;
      return {
        content: [{ type: "text", text: `Browser connected (profile: ${browserState.activeProfile}), but no tabs found.` }],
        details: { tabs, activeTarget: browserState.activeTarget, profile: browserState.activeProfile },
      };
    },
  });

  // Helper: register a simple chromex-wrapper tool (reduces boilerplate)
  function registerSimpleTool(def: {
    name: string; label: string; description: string; snippet?: string;
    guidelines?: string[];
    params: Record<string, any>;
    buildArgs: (params: any, target: string) => string[];
    timeout?: number;
  }) {
    pi.registerTool({
      name: def.name,
      label: def.label,
      description: def.description,
      ...(def.snippet ? { promptSnippet: def.snippet } : {}),
      ...(def.guidelines ? { promptGuidelines: def.guidelines } : {}),
      parameters: Type.Object(def.params),
      async execute(_id, params) {
        const target = targetArg(params.target);
        const args = def.buildArgs(params, target);
        const res = await runChromex(args, def.timeout);
        if (res.code !== 0) return { content: [{ type: "text", text: fmtError(def.name, res) }], isError: true };
        return { content: [{ type: "text", text: truncate(res.stdout.trim()) || "Done" }] };
      },
    });
  }

  // --- browser_list ---
  pi.registerTool({
    name: "browser_list",
    label: "List Tabs",
    description: "List all open browser tabs with target IDs, titles, and URLs.",
    promptSnippet: "List open browser tabs",
    promptGuidelines: ["Use browser_list to discover tab target IDs before interacting with pages."],
    parameters: Type.Object({}),
    async execute() {
      const res = await runChromex(["list"]);
      if (res.code !== 0) return { content: [{ type: "text", text: "No browser connected. Run browser_launch first." }], isError: true };
      const tabs = parseList(res.stdout);
      if (!browserState.activeTarget && tabs.length > 0) {
        browserState.activeTarget = tabs[0].targetId;
        browserState.connected = true;
      }
      return { content: [{ type: "text", text: tabs.length === 0 ? "No tabs open." : truncate(res.stdout.trim()) }], details: { tabs, activeTarget: browserState.activeTarget } };
    },
  });

  // --- browser_open ---
  registerSimpleTool({
    name: "browser_open", label: "Open Tab",
    description: "Open a new tab with a URL.", snippet: "Open new tab",
    params: { url: Type.String({ description: "URL to open" }) },
    buildArgs: (p) => ["open", p.url],
  });

  // --- browser_navigate ---
  pi.registerTool({
    name: "browser_navigate", label: "Navigate",
    description: "Navigate tab to URL, or back/forward/reload.",
    promptSnippet: "Navigate to URL",
    promptGuidelines: ["Use browser_navigate to go to a URL."],
    parameters: Type.Object({
      url: Type.String({ description: "URL or: back, forward, reload, reload-hard" }),
      target: Type.Optional(Type.String({ description: "Tab target ID" })),
    }),
    async execute(_id, params) {
      const target = targetArg(params.target);
      const isAction = ["back", "forward", "reload", "reload-hard"].includes(params.url);
      if (!isAction && !isValidUrl(params.url)) return { content: [{ type: "text", text: `Invalid URL: ${params.url}` }], isError: true };
      const res = await runChromex(["nav", target, params.url]);
      if (res.code !== 0) return { content: [{ type: "text", text: fmtError("Navigate", res) }], isError: true };
      browserState.activeTarget = target;
      return { content: [{ type: "text", text: truncate(res.stdout.trim()) || `Navigated to ${params.url}` }] };
    },
  });

  // --- browser_snap ---
  pi.registerTool({
    name: "browser_snap", label: "Snapshot",
    description: "Accessibility tree snapshot. refs for @eN labels, query to filter, depth to limit.",
    promptSnippet: "Snapshot page accessibility tree",
    promptGuidelines: ["Always use refs when you plan to click or fill.", "query saves 95-99% tokens on large pages."],
    parameters: Type.Object({
      refs: Type.Optional(Type.Boolean({ description: "Include @eN refs" })),
      query: Type.Optional(Type.String({ description: "Filter nodes (e.g. 'login')" })),
      depth: Type.Optional(Type.Number({ description: "Max depth" })),
      full: Type.Optional(Type.Boolean({ description: "Skip diff" })),
      target: Type.Optional(Type.String({ description: "Tab target ID" })),
    }),
    async execute(_id, params) {
      const target = targetArg(params.target);
      const args = ["snap", target];
      if (params.refs) args.push("--refs");
      if (params.query) args.push(`--query=${params.query}`);
      if (params.depth) args.push(`--depth=${params.depth}`);
      if (params.full) args.push("--full");
      const res = await runChromex(args, 15000);
      if (res.code !== 0) return { content: [{ type: "text", text: fmtError("Snap", res) }], isError: true };
      return { content: [{ type: "text", text: truncate(res.stdout.trim()) || "Empty page" }] };
    },
  });

  // --- browser_click ---
  registerSimpleTool({
    name: "browser_click", label: "Click",
    description: "Click by @ref or CSS selector.", snippet: "Click element",
    guidelines: ["Use @eN refs from browser_snap --refs."],
    params: {
      ref: Type.String({ description: "@eN ref or CSS selector" }),
      double: Type.Optional(Type.Boolean({ description: "Double-click" })),
      target: Type.Optional(Type.String({ description: "Tab target ID" })),
    },
    buildArgs: (p, t) => { const a = ["click", t, p.ref]; if (p.double) a.push("--dbl"); return a; },
  });

  // --- browser_fill ---
  registerSimpleTool({
    name: "browser_fill", label: "Fill",
    description: "Fill input by @ref or selector.", snippet: "Fill input",
    params: {
      ref: Type.String({ description: "@eN ref or selector" }),
      value: Type.String({ description: "Value" }),
      target: Type.Optional(Type.String({ description: "Tab target ID" })),
    },
    buildArgs: (p, t) => ["fill", t, p.ref, p.value],
  });

  // --- browser_type ---
  registerSimpleTool({
    name: "browser_type", label: "Type",
    description: "Type text at current focus.", snippet: "Type text",
    params: {
      text: Type.String({ description: "Text" }),
      target: Type.Optional(Type.String({ description: "Tab target ID" })),
    },
    buildArgs: (p, t) => ["type", t, p.text],
  });

  // --- browser_key ---
  registerSimpleTool({
    name: "browser_key", label: "Key",
    description: "Press key combo (Enter, Control+A, etc.).", snippet: "Press key",
    params: {
      key: Type.String({ description: "Key combo" }),
      target: Type.Optional(Type.String({ description: "Tab target ID" })),
    },
    buildArgs: (p, t) => ["key", t, p.key],
  });

  // --- browser_screenshot ---
  pi.registerTool({
    name: "browser_screenshot", label: "Screenshot",
    description: "Capture viewport or full page to file.", snippet: "Take screenshot",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Save path" })),
      full: Type.Optional(Type.Boolean({ description: "Full page" })),
      format: Type.Optional(StringEnum(["png", "jpeg", "webp"] as const)),
      target: Type.Optional(Type.String({ description: "Tab target ID" })),
    }),
    async execute(_id, params) {
      const target = targetArg(params.target);
      const ext = params.format ?? "png";
      const outPath = params.path ?? tmpPath(`pi-browser-shot.${ext}`);
      const args = ["shot", target, outPath];
      if (params.full) args.push("--full");
      if (params.format && params.format !== "png") args.push(`--format=${params.format}`);
      const res = await runChromex(args, 15000);
      if (res.code !== 0) return { content: [{ type: "text", text: fmtError("Screenshot", res) }], isError: true };
      return { content: [{ type: "text", text: `Screenshot saved to ${outPath}` }], details: { path: outPath } };
    },
  });

  // --- browser_eval ---
  pi.registerTool({
    name: "browser_eval", label: "Eval JS",
    description: "Evaluate JS in page context. Truncated at 20KB.",
    promptSnippet: "Run JavaScript",
    guidelines: ["Use browser_eval for data extraction or custom logic."],
    parameters: Type.Object({
      expression: Type.String({ description: "JS expression" }),
      target: Type.Optional(Type.String({ description: "Tab target ID" })),
    }),
    async execute(_id, params) {
      const target = targetArg(params.target);
      const res = await runChromex(["eval", target, params.expression]);
      if (res.code !== 0) return { content: [{ type: "text", text: fmtError("Eval", res) }], isError: true };
      return { content: [{ type: "text", text: truncate(res.stdout.trim() || "undefined", MAX_EVAL_OUTPUT) }] };
    },
  });

  // --- browser_html ---
  registerSimpleTool({
    name: "browser_html", label: "HTML",
    description: "Get element or page HTML.", snippet: "Get HTML",
    params: {
      selector: Type.Optional(Type.String({ description: "CSS selector" })),
      target: Type.Optional(Type.String({ description: "Tab target ID" })),
    },
    buildArgs: (p, t) => p.selector ? ["html", t, p.selector] : ["html", t],
  });

  // --- browser_scroll ---
  registerSimpleTool({
    name: "browser_scroll", label: "Scroll",
    description: "Scroll up/down/top/bottom.", snippet: "Scroll page",
    params: {
      direction: StringEnum(["up", "down", "top", "bottom"] as const),
      amount: Type.Optional(Type.Number({ description: "Pixels (for up/down)" })),
      target: Type.Optional(Type.String({ description: "Tab target ID" })),
    },
    buildArgs: (p, t) => { const a = ["scroll", t, p.direction]; if (p.amount && (p.direction === "up" || p.direction === "down")) a.push(String(p.amount)); return a; },
  });

  // --- browser_select ---
  pi.registerTool({
    name: "browser_select", label: "Select Tab",
    description: "Set active tab by target ID.", snippet: "Select tab",
    parameters: Type.Object({ target: Type.String({ description: "Tab target ID" }) }),
    async execute(_id, params) {
      const res = await runChromex(["focus", params.target]);
      if (res.code !== 0) return { content: [{ type: "text", text: fmtError("Focus", res) }], isError: true };
      browserState.activeTarget = params.target;
      browserState.connected = true;
      return { content: [{ type: "text", text: `Active tab: ${params.target}` }] };
    },
  });

  // --- browser_close ---
  pi.registerTool({
    name: "browser_close", label: "Close Tab",
    description: "Close tab. Falls back to next available.", snippet: "Close tab",
    parameters: Type.Object({ target: Type.Optional(Type.String({ description: "Tab target ID" })) }),
    async execute(_id, params) {
      const target = targetArg(params.target);
      const res = await runChromex(["close", target]);
      if (res.code !== 0) return { content: [{ type: "text", text: fmtError("Close", res) }], isError: true };
      if (browserState.activeTarget?.startsWith(target)) {
        browserState.activeTarget = null;
        try {
          const lr = await runChromex(["list"], 3000);
          if (lr.code === 0) { const rem = parseList(lr.stdout); if (rem.length > 0) browserState.activeTarget = rem[0].targetId; }
        } catch { /* */ }
      }
      return { content: [{ type: "text", text: `Closed ${target}` }] };
    },
  });

  // --- browser_extract ---
  pi.registerTool({
    name: "browser_extract", label: "Extract Text",
    description: "Extract visible text content.", snippet: "Extract text",
    parameters: Type.Object({
      selector: Type.Optional(Type.String({ description: "CSS selector (default: body)" })),
      target: Type.Optional(Type.String({ description: "Tab target ID" })),
    }),
    async execute(_id, params) {
      const target = targetArg(params.target);
      const sel = sanitizeSelector(params.selector ?? "body");
      const res = await runChromex(["eval", target, `document.querySelector('${sel}')?.innerText ?? ''`]);
      if (res.code !== 0) return { content: [{ type: "text", text: fmtError("Extract", res) }], isError: true };
      const text = res.stdout.trim();
      if (!text) return { content: [{ type: "text", text: "No text found." }] };
      return { content: [{ type: "text", text: truncate(text) }], details: { chars: text.length } };
    },
  });

  // --- browser_wait ---
  registerSimpleTool({
    name: "browser_wait", label: "Wait",
    description: "Wait for CSS selector or event (networkidle, load, domready).",
    snippet: "Wait for element",
    params: {
      condition: Type.String({ description: "CSS selector or event" }),
      timeout: Type.Optional(Type.Number({ description: "Max ms (default 10000)" })),
      target: Type.Optional(Type.String({ description: "Tab target ID" })),
    },
    buildArgs: (p, t) => {
      const ms = p.timeout ?? 10000;
      const isEvent = ["networkidle", "load", "domready", "fcp"].includes(p.condition);
      return isEvent ? ["wait", t, p.condition, String(ms)] : ["waitfor", t, p.condition, String(ms)];
    },
  });

  // --- browser_form ---
  pi.registerTool({
    name: "browser_form", label: "Fill Form",
    description: "Batch fill form: {\"@e1\":\"val\",\"@e2\":true}",
    snippet: "Fill form",
    parameters: Type.Object({
      fields: Type.String({ description: "JSON object" }),
      target: Type.Optional(Type.String({ description: "Tab target ID" })),
    }),
    async execute(_id, params) {
      try { JSON.parse(params.fields); } catch { throw new Error("fields must be valid JSON"); }
      const target = targetArg(params.target);
      const res = await runChromex(["form", target, params.fields]);
      if (res.code !== 0) return { content: [{ type: "text", text: fmtError("Form", res) }], isError: true };
      return { content: [{ type: "text", text: truncate(res.stdout.trim()) || "Form filled" }] };
    },
  });

  // ─── DevTools ───────────────────────────────────────────────────────────────

  registerSimpleTool({ name: "browser_net", label: "Network", description: "List network requests or get request detail.", snippet: "Network requests", params: { requestId: Type.Optional(Type.String({ description: "Request ID for detail" })), target: Type.Optional(Type.String()) }, buildArgs: (p, t) => p.requestId ? ["net", t, p.requestId] : ["net", t] });

  registerSimpleTool({ name: "browser_console", label: "Console", description: "Read browser console.", snippet: "Console output", params: { mode: Type.Optional(StringEnum(["capture", "list", "detail"] as const)), id: Type.Optional(Type.String()), duration: Type.Optional(Type.Number()), target: Type.Optional(Type.String()) }, buildArgs: (p, t) => { if (p.mode === "list") return ["console", t, "list"]; if (p.mode === "detail" && p.id) return ["console", t, "detail", p.id]; return ["console", t, String(p.duration ?? 5000)]; }, timeout: 15000 });

  registerSimpleTool({ name: "browser_perf", label: "Perf", description: "Core Web Vitals + metrics.", snippet: "Performance metrics", params: { target: Type.Optional(Type.String()) }, buildArgs: (_p, t) => ["perf", t] });

  registerSimpleTool({ name: "browser_throttle", label: "Throttle", description: "Throttle: 3g/4g/offline/reset.", snippet: "Network throttle", params: { preset: StringEnum(["3g", "slow-3g", "4g", "offline", "reset"] as const), target: Type.Optional(Type.String()) }, buildArgs: (p, t) => ["throttle", t, p.preset] });

  registerSimpleTool({ name: "browser_intercept", label: "Intercept", description: "Block/mock network requests.", snippet: "Network intercept", params: { action: StringEnum(["block", "mock", "rules", "off"] as const), pattern: Type.Optional(Type.String()), response: Type.Optional(Type.String()), target: Type.Optional(Type.String()) }, buildArgs: (p, t) => { const a = ["intercept", t, p.action]; if (p.action === "block" && p.pattern) a.push(p.pattern); else if (p.action === "mock" && p.pattern && p.response) a.push(p.pattern, p.response); return a; } });

  registerSimpleTool({ name: "browser_har", label: "HAR", description: "Record HAR.", snippet: "HAR recording", params: { action: StringEnum(["start", "stop"] as const), file: Type.Optional(Type.String()), target: Type.Optional(Type.String()) }, buildArgs: (p, t) => { const a = ["har", t, p.action]; if (p.action === "stop") a.push(p.file ?? tmpPath("pi-browser.har")); return a; } });

  registerSimpleTool({ name: "browser_domsnapshot", label: "DOM Snapshot", description: "DOM with bounding rects.", snippet: "DOM snapshot", params: { styles: Type.Optional(Type.Boolean()), target: Type.Optional(Type.String()) }, buildArgs: (p, t) => p.styles ? ["domsnapshot", t, "--styles"] : ["domsnapshot", t] });

  registerSimpleTool({ name: "browser_cookies", label: "Cookies", description: "List/set/clear cookies.", snippet: "Cookies", params: { action: Type.Optional(StringEnum(["list", "set", "clear"] as const)), cookie: Type.Optional(Type.String()), target: Type.Optional(Type.String()) }, buildArgs: (p, t) => p.action === "set" && p.cookie ? ["cookies", t, "set", p.cookie] : p.action === "clear" ? ["cookies", t, "clear"] : ["cookies", t] });

  registerSimpleTool({ name: "browser_storage", label: "Storage", description: "localStorage/sessionStorage.", snippet: "Storage", params: { type: StringEnum(["local", "session", "clear"] as const), target: Type.Optional(Type.String()) }, buildArgs: (p, t) => ["storage", t, p.type] });

  registerSimpleTool({ name: "browser_coverage", label: "Coverage", description: "CSS/JS code coverage.", snippet: "Code coverage", params: { action: StringEnum(["start", "stop"] as const), target: Type.Optional(Type.String()) }, buildArgs: (p, t) => ["coverage", t, p.action] });

  registerSimpleTool({ name: "browser_audit", label: "Audit", description: "Lighthouse audit.", snippet: "Lighthouse audit", params: { categories: Type.Optional(Type.String()), device: Type.Optional(StringEnum(["mobile", "desktop"] as const)), target: Type.Optional(Type.String()) }, buildArgs: (p, t) => { const a = ["audit", t]; if (p.categories) a.push(p.categories); if (p.device) a.push(p.device); return a; }, timeout: 60000 });

  // ═══════════════════════════════════════════════════════════════════════════
  // COMMANDS
  // ═══════════════════════════════════════════════════════════════════════════

  pi.registerCommand("browser", {
    description: "Browser manager",
    getArgumentCompletions(prefix: string) {
      return ["detect", "list", "launch", "stop", "status"]
        .filter((c) => c.startsWith(prefix))
        .map((c) => ({ value: c, label: c }));
    },
    handler: async (args, ctx) => {
      const sub = args.trim();

      if (sub === "detect") {
        const detected = detectBrowsers();
        if (detected.length === 0) { ctx.ui.notify("No browsers found", "warning"); return; }
        for (const name of detected) {
          const bin = resolveBrowserBin(name);
          ctx.ui.notify(`  ${BROWSERS[name].label}: ${bin}`, "info");
        }
        return;
      }

      if (sub === "status" || sub === "") {
        const info = [
          browserState.connected ? "Connected" : "Not connected",
          `Profile: ${browserState.activeProfile}`,
          browserState.activeTarget ? `Tab: ${browserState.activeTarget}` : "No tab",
        ].join(" | ");
        try {
          const res = await runChromex(["list"], 5000);
          if (res.code === 0 && res.stdout.trim()) {
            ctx.ui.notify(`${info}\n${parseList(res.stdout).length} tab(s)`, "info");
            return;
          }
        } catch { /* */ }
        ctx.ui.notify(`${info}\nNo browser`, "info");
        return;
      }

      if (sub === "list") {
        try {
          const res = await runChromex(["list"]);
          if (res.code === 0 && res.stdout.trim()) {
            const tabs = parseList(res.stdout);
            const choice = await ctx.ui.select("Tabs:", tabs.map((t) => `${t.targetId}  ${t.title}  ${t.url}`));
            if (choice !== undefined && tabs[choice]) {
              browserState.activeTarget = tabs[choice].targetId;
              await runChromex(["focus", tabs[choice].targetId]);
              ctx.ui.notify(`→ ${tabs[choice].title}`, "info");
            }
          } else { ctx.ui.notify("No browser. /browser launch", "warning"); }
        } catch { ctx.ui.notify("No browser", "warning"); }
        return;
      }

      if (sub === "launch" || sub.startsWith("launch ")) {
        const url = sub.startsWith("launch ") ? sub.slice(7).trim() : undefined;
        const detected = detectBrowsers();
        if (detected.length === 0) { ctx.ui.notify("No browsers found", "error"); return; }
        const idx = await ctx.ui.select("Browser:", detected.map((n) => BROWSERS[n].label));
        if (idx === undefined || idx === null) return;
        const name = detected[idx];
        const bin = resolveBrowserBin(name);
        if (!bin) return;

        const profileDir = ensureProfileDir(browserState.activeProfile);
        ctx.ui.notify("Launching...", "info");
        const sa = ["--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profileDir}`];
        if (url) sa.push(url);
        spawn(bin, sa, { detached: !IS_WIN, stdio: "ignore", ...(IS_WIN ? { shell: true } : {}) }).unref();

        const pf = portFilePath(browserState.activeProfile);
        for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 500)); if (existsSync(pf)) break; }
        await new Promise((r) => setTimeout(r, 1000));
        try {
          const lr = await runChromex(["list"], 5000);
          if (lr.code === 0 && lr.stdout.trim()) {
            const tabs = parseList(lr.stdout);
            if (tabs.length > 0) { browserState.activeTarget = tabs[0].targetId; browserState.connected = true; ctx.ui.notify(`→ ${tabs[0].title}`, "success"); return; }
          }
        } catch { /* */ }
        browserState.connected = true;
        ctx.ui.notify("Launched. /browser list", "info");
        return;
      }

      if (sub === "stop") {
        await runChromex(["stop"]);
        browserState.activeTarget = null;
        browserState.connected = false;
        ctx.ui.notify("Daemons stopped", "info");
        return;
      }

      ctx.ui.notify("/browser [detect|status|list|launch|stop]", "info");
    },
  });

  // ─── Widget ─────────────────────────────────────────────────────────────────

  pi.on("turn_end", async (_event, ctx) => {
    if (!browserState.connected || !browserState.activeTarget) return;
    try {
      const res = await runChromex(["list"], 3000);
      if (res.code === 0 && res.stdout.trim()) {
        const tabs = parseList(res.stdout);
        const active = tabs.find((t) => browserState.activeTarget?.startsWith(t.targetId));
        if (active) ctx.ui.setWidget("pi-browser", [`🌐 ${active.title.slice(0, 50)} — ${active.url.slice(0, 60)}`, `Target: ${active.targetId} | Profile: ${browserState.activeProfile} | Tabs: ${tabs.length}`]);
      }
    } catch { /* */ }
  });
}
