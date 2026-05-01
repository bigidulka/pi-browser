import { describe, expect, it } from "vitest";
import { verifySandboxInstall } from "@marcfargas/pi-test-harness";

const EXPECTED_TOOLS = [
  "browser_launch",
  "browser_detect",
  "browser_list",
  "browser_open",
  "browser_navigate",
  "browser_snap",
  "browser_click",
  "browser_fill",
  "browser_type",
  "browser_key",
  "browser_screenshot",
  "browser_eval",
  "browser_html",
  "browser_scroll",
  "browser_select",
  "browser_close",
  "browser_extract",
  "browser_wait",
  "browser_form",
  "browser_net",
  "browser_console",
  "browser_perf",
  "browser_throttle",
  "browser_intercept",
  "browser_har",
  "browser_domsnapshot",
  "browser_cookies",
  "browser_storage",
  "browser_coverage",
  "browser_audit",
];

describe("pi-browser package", () => {
  it("packs, installs, and registers all browser tools", async () => {
    const result = await verifySandboxInstall({
      packageDir: ".",
      expect: {
        extensions: 1,
        tools: EXPECTED_TOOLS,
        skills: 0,
      },
    });

    expect(result.loaded.extensionErrors).toEqual([]);
    for (const tool of EXPECTED_TOOLS) {
      expect(result.loaded.tools).toContain(tool);
    }
  }, 120_000);
});
