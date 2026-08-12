export const BRAND = "渋み  shis (shibumi-server)";

const ORANGE = "\u001b[38;2;255;102;0m";
const BLUE = "\u001b[34m";
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

export function next(value: string, color = supportsTerminalColor()): string {
  return color ? `${ORANGE}Next:${RESET} ${value}` : `Next: ${value}`;
}

export function link(value: string, color = supportsTerminalColor()): string {
  return color ? `${BLUE}${value}${RESET}` : value;
}
