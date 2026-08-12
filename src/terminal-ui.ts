export const BRAND = "渋み  shis (shibumi-server)";

export type StageTone = "neutral" | "confirmed" | "action" | "info" | "success";

const RESET = "\u001b[0m";
const LABEL_WIDTH = 10;
const COLORS: Record<StageTone, { foreground: string; background: string }> = {
  neutral: { foreground: "255;136;51", background: "50;44;39" },
  confirmed: { foreground: "116;199;122", background: "50;44;39" },
  action: { foreground: "30;21;16", background: "255;136;51" },
  info: { foreground: "176;168;152", background: "50;44;39" },
  success: { foreground: "23;51;31", background: "100;180;100" },
};

export function supportsTerminalColor(
  env: NodeJS.ProcessEnv = process.env,
  isTTY = Boolean(process.stdout.isTTY),
): boolean {
  if ("NO_COLOR" in env || env.TERM === "dumb" || env.FORCE_COLOR === "0") return false;
  return isTTY || Boolean(env.FORCE_COLOR);
}

export function stage(
  label: string,
  message: string,
  tone: StageTone = "neutral",
  color = supportsTerminalColor(),
): string {
  const badge = ` ${label.padEnd(LABEL_WIDTH)} `;
  if (!color) return `${badge} ${message}`;
  const { foreground, background } = COLORS[tone];
  return `\u001b[38;2;${foreground};48;2;${background}m${badge}${RESET} ${message}`;
}
