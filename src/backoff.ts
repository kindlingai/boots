// Paces tool calls when the model fires them in rapid succession: the first
// few go straight through, then each waits twice as long as the one before,
// up to 10 s. The pressure drains with quiet time, all of it in a minute.

/** Calls that go through without waiting, before backing off. */
const FREE = 3;
const FIRST_MS = 500;
const MAX_MS = 10_000;
const COOL_MS = 60_000;

/** Pressure at which the wait reaches its maximum: FREE + 0.5, 1, 2, 4, 8, 10 s. */
const TOP = FREE + Math.ceil(Math.log2(MAX_MS / FIRST_MS)) + 1;

export class Backoff {
  private level = 0;
  private last = -Infinity;

  constructor(private now: () => number = () => performance.now()) {}

  /** How long to wait before the next tool call (ms), counting it as made. */
  next(): number {
    const t = this.now();
    // Quiet time since the last call finished drains the pressure: from the
    // top to nothing in COOL_MS.
    if (Number.isFinite(this.last)) {
      this.level = Math.max(0, this.level - ((t - this.last) / COOL_MS) * TOP);
    }
    this.level = Math.min(TOP, this.level + 1);
    this.last = t;
    if (Deno.env.get("AIBOOT_BACKOFF") === "0" || this.level <= FREE) return 0;
    return Math.min(MAX_MS, FIRST_MS * 2 ** Math.ceil(this.level - FREE - 1));
  }

  /** The call (and any wait before it) is over: quiet time counts from here. */
  done(): void {
    this.last = this.now();
  }
}
