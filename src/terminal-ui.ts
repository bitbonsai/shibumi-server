export const BRAND = "渋み  shis (shibumi-server)";

const ORANGE = "\u001b[38;2;255;102;0m";
const RESET = "\u001b[0m";

export function supportsTerminalColor(
  env: NodeJS.ProcessEnv = process.env,
  isTTY = Boolean(process.stdout.isTTY),
): boolean {
  if ("NO_COLOR" in env || env.TERM === "dumb" || env.FORCE_COLOR === "0") return false;
  return isTTY || Boolean(env.FORCE_COLOR);
}

export function brand(color = supportsTerminalColor()): string {
  return color ? `${ORANGE}${BRAND}${RESET}` : BRAND;
}
