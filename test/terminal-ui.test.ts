import { expect, test } from "bun:test";
import { BRAND, stage, supportsTerminalColor } from "../src/terminal-ui";

test("terminal stages match website label language with a plain-text fallback", () => {
  expect(BRAND).toBe("渋み  shis (shibumi-server)");
  expect(stage("checked", "Git ✓", "neutral", false)).toBe(" checked     Git ✓");
  expect(stage("done", "Ready", "success", true)).toContain("\u001b[38;2;23;51;31;48;2;100;180;100m done");
});

test("terminal color respects TTY and standard overrides", () => {
  expect(supportsTerminalColor({}, true)).toBe(true);
  expect(supportsTerminalColor({}, false)).toBe(false);
  expect(supportsTerminalColor({ FORCE_COLOR: "1" }, false)).toBe(true);
  expect(supportsTerminalColor({ NO_COLOR: "1", FORCE_COLOR: "1" }, true)).toBe(false);
});
