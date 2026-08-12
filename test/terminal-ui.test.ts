import { expect, test } from "bun:test";
import { BRAND, brand, command, link, next, supportsTerminalColor } from "../src/terminal-ui";

test("colors only Clack branding orange with a plain-text fallback", () => {
  expect(BRAND).toBe("渋み  shis (shibumi-server)");
  expect(brand(false)).toBe(BRAND);
  expect(brand(true)).toBe(`\u001b[38;2;255;102;0m${BRAND}\u001b[0m`);
});

test("colors next actions orange and links blue with plain fallbacks", () => {
  expect(next("deploy", false)).toBe("Next: deploy");
  expect(next("deploy", true)).toBe("\u001b[38;2;255;102;0mNext:\u001b[0m deploy");
  expect(link("https://shibumistack.dev/ship", false)).toBe("https://shibumistack.dev/ship");
  expect(link("https://shibumistack.dev/ship", true)).toBe("\u001b[34mhttps://shibumistack.dev/ship\u001b[0m");
  expect(command("bun run ship:setup", false)).toBe("bun run ship:setup");
  expect(command("bun run ship:setup", true)).toBe("\u001b[36mbun run ship:setup\u001b[0m");
});

test("terminal color respects TTY and standard overrides", () => {
  expect(supportsTerminalColor({}, true)).toBe(true);
  expect(supportsTerminalColor({}, false)).toBe(false);
  expect(supportsTerminalColor({ FORCE_COLOR: "1" }, false)).toBe(true);
  expect(supportsTerminalColor({ NO_COLOR: "1", FORCE_COLOR: "1" }, true)).toBe(false);
});
