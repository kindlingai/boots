// Tool calls in rapid succession are paced: exponential, capped, cooling off.
import { assert, assertEquals } from "@std/assert";
import { Backoff } from "../src/backoff.ts";

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

Deno.test("a burst goes through, then waits double up to 10 s", () => {
  const c = clock();
  const b = new Backoff(c.now);
  const waits: number[] = [];
  for (let i = 0; i < 10; i++) {
    const w = b.next();
    waits.push(w);
    c.advance(w + 100); // the call itself is quick
    b.done();
  }
  assertEquals(waits.slice(0, 3), [0, 0, 0], "the first few are free");
  assert(waits[3] > 0, waits.join(","));
  for (let i = 4; i < waits.length; i++) assert(waits[i] >= waits[i - 1], waits.join(","));
  assertEquals(Math.max(...waits), 10_000, "capped at 10 s");
});

Deno.test("it cools off: a minute of quiet clears it, a pause eases it", () => {
  const c = clock();
  const b = new Backoff(c.now);
  for (let i = 0; i < 12; i++) {
    c.advance(b.next() + 50);
    b.done();
  }
  c.advance(20_000);
  const eased = b.next();
  b.done();
  assert(eased > 0 && eased < 10_000, `partly cooled: ${eased}`);
  c.advance(60_000);
  assertEquals(b.next(), 0, "a quiet minute resets it");
});

Deno.test("calls at a calm pace never wait", () => {
  const c = clock();
  const b = new Backoff(c.now);
  for (let i = 0; i < 50; i++) {
    assertEquals(b.next(), 0);
    c.advance(200); // the call
    b.done();
    c.advance(8_000); // the model thinks before the next one
  }
});

Deno.test("AIBOOT_BACKOFF=0 turns it off", () => {
  Deno.env.set("AIBOOT_BACKOFF", "0");
  try {
    const b = new Backoff(() => 0);
    for (let i = 0; i < 20; i++) assertEquals(b.next(), 0);
  } finally {
    Deno.env.delete("AIBOOT_BACKOFF");
  }
});
