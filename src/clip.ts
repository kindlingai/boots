// Cutting long output to fit, by whole lines: each line costs a row per
// 100 characters (at least one), the head and the tail are kept whole, and
// only the line that runs past the end of the room is cut. Cutting at a
// character count instead splits lines, and a model that sees lines break
// off mid-way concludes long lines are being lost and starts working
// around it (folding files, re-reading).

/** Characters per row in the accounting. */
export const ROW = 100;

const rows = (l: string) => Math.max(1, Math.ceil(l.length / ROW));

/**
 * `text` in at most about `max` characters: whole lines from the start
 * (`headShare` of the room) and from the end, and a note of what was left
 * out between. Unchanged when it fits.
 */
export function clipLines(text: string, max: number, headShare = 0.5, note = "cut"): string {
  if (text.length <= max) return text;
  const lines = text.split("\n");
  const budget = Math.max(2, Math.floor(max / ROW));
  let headRoom = Math.max(1, Math.floor(budget * headShare));
  let tailRoom = Math.max(1, budget - headRoom);
  const head: string[] = [];
  let i = 0;
  while (i < lines.length && headRoom > 0) {
    const l = lines[i];
    if (rows(l) <= headRoom) {
      head.push(l);
      headRoom -= rows(l);
      i++;
    } else {
      // The long line that runs past the room: its start, and how much is left out.
      head.push(`${l.slice(0, headRoom * ROW)} …[+${l.length - headRoom * ROW} chars]`);
      i++;
      headRoom = 0;
    }
  }
  const tail: string[] = [];
  let j = lines.length - 1;
  while (j >= i && tailRoom > 0) {
    const l = lines[j];
    if (rows(l) <= tailRoom) {
      tail.unshift(l);
      tailRoom -= rows(l);
      j--;
    } else {
      tail.unshift(`[${l.length - tailRoom * ROW} chars]… ${l.slice(-tailRoom * ROW)}`);
      j--;
      tailRoom = 0;
    }
  }
  const left = j - i + 1;
  if (left <= 0) return [...head, ...tail].join("\n");
  const chars = lines.slice(i, j + 1).reduce((n, l) => n + l.length + 1, 0);
  return [
    ...head,
    `...[${left} line${left === 1 ? "" : "s"} (${chars} chars) ${note}]...`,
    ...tail,
  ].join("\n");
}
