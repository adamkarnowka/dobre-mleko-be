import { invalidInput } from './errors.js';

/** Icon ids: like category ids. */
export const ICON_ID = /^[a-z][a-z0-9_]{1,31}$/;

/** Numbers each SVG path command takes (per repetition). */
const ARGS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
const TOKEN = /([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|([\s,]+)|(.)/g;

/**
 * Checks SVG path data (the `d` attribute) for an icon: path commands and numbers only — no markup, no other
 * attributes — starting with a moveto, each command with a whole number of argument groups, absolute coordinates
 * within the 24×24 grid (with a small margin). Returns it with whitespace collapsed.
 */
export function checkIconPath(raw: string): string {
  const d = raw.trim().replace(/\s+/g, ' ');
  if (!d) throw invalidInput('The icon path is empty');
  if (d.length > 8000) throw invalidInput('The icon path is too long (8000 characters at most)');
  const commands: { cmd: string; args: number[] }[] = [];
  for (const [, cmd, num, , other] of d.matchAll(TOKEN)) {
    if (other !== undefined) throw invalidInput(`Unexpected character in the icon path: ${other}`);
    if (cmd) commands.push({ cmd, args: [] });
    else if (num !== undefined) {
      const last = commands.at(-1);
      if (!last) throw invalidInput('The icon path must start with a command (M)');
      last.args.push(Number(num));
    }
  }
  if (commands[0]?.cmd.toLowerCase() !== 'm') throw invalidInput('The icon path must start with M');
  for (const { cmd, args } of commands) {
    const n = ARGS[cmd.toLowerCase()]!;
    const ok = n === 0 ? args.length === 0 : args.length > 0 && args.length % n === 0;
    if (!ok) throw invalidInput(`Wrong number of values after ${cmd} in the icon path`);
    if (!args.every(Number.isFinite)) throw invalidInput('The icon path has a number out of range');
    if (cmd === cmd.toUpperCase() && cmd !== 'Z' && !absoluteInGrid(cmd, args)) {
      throw invalidInput('The icon path must stay within the 24×24 grid');
    }
  }
  return d;
}

/** Coordinates of absolute commands within −1…25 (arcs: only the end point; radii and flags are not coordinates). */
function absoluteInGrid(cmd: string, args: number[]): boolean {
  const inGrid = (v: number) => v >= -1 && v <= 25;
  if (cmd === 'A') return args.every((v, i) => i % 7 < 5 || inGrid(v));
  return args.every(inGrid);
}
