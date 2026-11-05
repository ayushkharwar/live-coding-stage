#!/usr/bin/env python3
"""Hacker glitch binary rain: a decorative background for a terminal panel.

Design
------
* Geometry is re-read from ``os.get_terminal_size()`` every frame; a change
  rebuilds the column state. A frame is cursor-home (``ESC[H``) plus exactly
  ``rows`` newline-separated lines and *no* trailing newline, so the viewport
  is repainted in place and never scrolls.
* The frame is a list of precomputed strings joined once and pushed with a
  single ``sys.stdout.write`` + ``flush``. Every colour escape and glyph is a
  module constant; a cell packs ``(level << 3) | glyph_index`` in one byte and
  an escape is emitted only when the level changes, so background runs cost one
  escape rather than one per cell. No f-strings or escape building in the loop.
* Glitches are injected before rendering (block bursts into the grid, a tear as
  an index offset for one row, a flash replacing one row), so rendering stays
  one uniform loop.
* ``--no-color``: zero ESC bytes, ASCII glyphs, newline split frames (scrolls
  by design, homing needs escapes).
"""

from __future__ import annotations

import argparse, math, os, random, signal, sys, time

# Level 0 is empty, 1..7 fade from dim tail to bright tail, 8 is the head,
# 9 marks corruption, 10 is the rare flash text.
SGR = (
    "\x1b[38;5;235m", "\x1b[38;5;22m", "\x1b[38;5;28m", "\x1b[38;5;34m",
    "\x1b[38;5;40m", "\x1b[38;5;46m", "\x1b[38;5;82m", "\x1b[38;5;118m",
    "\x1b[38;2;156;255;156m", "\x1b[38;5;190m", "\x1b[38;5;59m",
)
GLYPHS = (" ", "0", "1", "\u2593", "\u2591", "\u2592", "\u2588", "\u2584")
SGR_PLAIN, GLYPHS_PLAIN = ("",) * len(SGR), (" ", "0", "1", "#", "-", "+", "@", "%")
# Brightest next to the head, fading with distance; index == cells behind head.
TAILEV = (7, 7, 6, 6, 5, 5, 4, 4, 3, 3, 2, 2, 1, 1, 1, 1)
MAXTRAIL, TEAR_SHIFTS = len(TAILEV), (-6, -4, -3, -2, 2, 3, 4, 6)
FLASH_PAT = "".join(random.Random(1).choices("0123456789abcdef", k=512))
BITS = bytes(random.Random(5).choices((1, 2), k=256))  # glyph index per (row, col)
HOME, NL = "\x1b[H", "\n"
P_TEAR, P_CORRUPT, P_FLASH = 0.08, 0.07, 0.008  # per frame; flash ~ once/6 s


def term_size() -> tuple[int, int]:
    """(rows, cols) from the tty, with a sane fallback for pipes."""
    try:
        s = os.get_terminal_size()
        if s.lines and s.columns:
            return s.lines, s.columns
    except OSError:
        pass
    return 24, 80


class Rain:
    def __init__(self, density: float, glitch: bool, plain: bool, seed) -> None:
        self.density, self.glitch, self.plain = density, glitch, plain
        self.sgr = SGR_PLAIN if plain else SGR
        self.glyphs = GLYPHS_PLAIN if plain else GLYPHS
        self.home = "" if plain else HOME
        self.rng = random.Random(seed)
        self.frame = self.rows = self.cols = 0
        self.stop = False
        self.geom(*term_size())

    def geom(self, rows: int, cols: int) -> None:
        """(Re)build column state for a viewport of rows x cols."""
        self.rows, self.cols = rows, cols
        rng, density = self.rng, self.density
        self.grid = bytearray(rows * cols)
        self.active = [rng.random() < density for _ in range(cols)]
        self.head = [rng.uniform(-rows, rows) for _ in range(cols)]
        self.speed = [rng.uniform(0.7, 2.2) for _ in range(cols)]
        self.trail = [rng.randrange(6, MAXTRAIL + 1) for _ in range(cols)]
        self.phase = [rng.uniform(0.0, 6.2832) for _ in range(cols)]

    def step(self) -> str:
        rows, cols = self.rows, self.cols
        grid = self.grid = bytearray(rows * cols)  # fresh, all zero
        rng = self.rng
        head, speed, trail, active = self.head, self.speed, self.trail, self.active
        t = self.frame * 0.09
        wave = [int(1.2 + 1.2 * math.sin(p + t)) for p in self.phase]  # 0..2

        for c in range(cols):
            if not active[c]:
                continue
            h = head[c] + speed[c]
            tr = trail[c]
            if h - tr >= rows:  # column fully below the viewport: respawn
                tr = trail[c] = rng.randrange(6, MAXTRAIL + 1)
                speed[c] = rng.uniform(0.7, 2.2)
                h = head[c] = -rng.uniform(0.0, rows * 1.2)
            else:
                head[c] = h
            hi, w = int(h), wave[c]
            for i in range(tr):
                y = hi - i
                if 0 <= y < rows:
                    lv = TAILEV[i] + w
                    grid[y * cols + c] = ((7 if lv > 7 else lv) << 3) | BITS[(y * 17 + c) & 255]
            if 0 <= hi < rows:
                grid[hi * cols + c] = 64 | BITS[(hi * 17 + c) & 255]  # level 8 = head

        torn: dict[int, int] = {}
        flash = -1
        if self.glitch:
            if rng.random() < P_TEAR:
                torn[rng.randrange(rows)] = rng.choice(TEAR_SHIFTS)
            if rng.random() < P_CORRUPT:
                for _ in range(rng.randrange(1, 4)):
                    y, x0 = rng.randrange(rows), rng.randrange(cols)
                    for x in range(x0, min(cols, x0 + rng.randrange(4, 14))):
                        grid[y * cols + x] = 72 | rng.randrange(3, 8)
            if rng.random() < P_FLASH:
                flash = rng.randrange(rows)

        sgr, glyphs, out = self.sgr, self.glyphs, [self.home]
        ap = out.append
        pat = FLASH_PAT[:cols]
        for y in range(rows):
            if y == flash:
                ap(sgr[10])  # one dim full-width line, no per-cell work
                ap(pat)
            else:
                base = y * cols
                off = torn.get(y)
                idxs = range(base, base + cols) if off is None else [
                    base + (x + off) % cols for x in range(cols)]
                cur = -1
                for i in idxs:
                    cell = grid[i]
                    lv = cell >> 3
                    if lv != cur:
                        ap(sgr[lv])
                        cur = lv
                    ap(glyphs[cell & 7])
            if y + 1 < rows:
                ap(NL)
        self.frame += 1
        return "".join(out) + (NL if self.plain else "")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Glitch binary rain terminal background.")
    p.add_argument("--fps", type=float, default=22.0, help="frames per second (22)")
    p.add_argument("--density", type=float, default=0.55, help="active column fraction (0.55)")
    p.add_argument("--no-glitch", action="store_true", help="disable tear/corrupt/flash")
    p.add_argument("--no-color", action="store_true", help="plain ASCII, zero ESC bytes")
    p.add_argument("--duration", type=float, default=None, help="exit after N seconds")
    p.add_argument("--seed", type=int, default=None, help="RNG seed for repeatable runs")
    args = p.parse_args(argv)
    if args.fps <= 0:
        p.error("--fps must be > 0")
    if not 0.0 <= args.density <= 1.0:
        p.error("--density must be within 0..1")

    rain = Rain(args.density, not args.no_glitch, args.no_color, args.seed)
    write, flush = sys.stdout.write, sys.stdout.flush

    def on_signal(_signum, _frame):
        rain.stop = True

    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, on_signal)  # SIGHUP: panel closed while running
    if not args.no_color:
        write("\x1b[?25l\x1b[2J")  # hide cursor, clear once
        flush()

    period = 1.0 / args.fps
    t0 = nxt = time.monotonic()
    try:
        while not rain.stop:
            size = term_size()
            if size != (rain.rows, rain.cols):
                rain.geom(*size)
            write(rain.step())
            flush()
            if args.duration is not None and time.monotonic() - t0 >= args.duration:
                break
            nxt += period
            now = time.monotonic()
            if nxt > now:
                time.sleep(nxt - now)
            else:
                nxt = now  # behind schedule: drop the debt, never burst
    except BrokenPipeError:
        pass
    finally:
        if not args.no_color:
            write("\x1b[0m\x1b[?25h")  # reset colours, restore cursor
            try:
                flush()
            except BrokenPipeError:
                pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
