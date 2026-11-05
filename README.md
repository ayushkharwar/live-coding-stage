# live-coding-stage

A skill for agents that need to work in front of a human. It opens a folder in
VS Code, types a file into the editor one character at a time, runs the file in
a split terminal, and keeps binary rain falling in the panel the whole time.

Built for watching an agent code on a real desktop instead of reading a diff.

```
    110  1                       1 1  1                      1                 1 10
     10  0                      1  1  0               1      0                   00
     11  0 0                    0  1  1               0      0                   11
     10  1 0                    1  1  1               1      1      0      1     0
01   10  1 1                    1     0               0      1      1      1     1
00 1 00  0 0  1                 0     0               0      1      1      1     0
11 0  11 1 11 0                       1 1             1      0      0      0
01 1  11 0 01 1             1           0        0           1             00
```

One captured frame, escapes stripped. The rain fades toward the tail, the head
glyph is bright, and rows occasionally tear or corrupt on purpose.

## What a run prints

Real log from a 904 character payload:

```
closing previously staged windows:
  closed : /home/zen/projects/testing-purposes-only
target  : access_granted.py
rain    : true (fps 22)
speed   : fast

20:16:29  speed: fast (batch 3)
20:16:30  rain terminal started
20:22:01  typing 7438 chars into solar_system.html (buffer 0)
20:22:07  typed 1859/7438
20:22:16  typed 7438/7438, buffer 7438 chars in 14.7s (505 chars/s),
          path: editor.edit 2111x, type 0x
20:22:16  view: lines 202-231 of 231, end on screen: true
20:22:17  ran: xdg-open solar_system.html
20:22:17  done

RESULT  : IDENTICAL (7438 bytes, byte-for-byte)
```

The caret line is the scroll proof: the view was showing the end of the file,
so the typing did not run off screen.

## Quick start

```sh
git clone https://github.com/ayushkharwar/live-coding-stage
cp -r live-coding-stage ~/.dsh/skills/

sh ~/.dsh/skills/live-coding-stage/stage.sh ~/projects/demo \
  --payload ~/work/hello.py \
  --run "python3 hello.py"
```

The command closes any window staged earlier, opens one new window, types the
payload, waits for typing to end, and compares the result against the payload
byte for byte before it returns. `assets/demos/solar_system.html` is a good
first payload: a 3D solar system with drag, zoom, click to inspect, and pause,
written with no dependencies so it runs from `file://`.

```sh
# read a run's log
sh ~/.dsh/skills/live-coding-stage/stage.sh --verify ~/projects/demo

# close every staged window, open nothing
sh ~/.dsh/skills/live-coding-stage/stage.sh --close-all
```

Flags: `--name` for the filename inside the project, `--no-rain`, `--fps`,
`--keep` to leave the previous window open, `--wait` for the log timeout, and
`--speed` for the typing pace:

| Speed | Batch | Measured | Use it when |
| --- | --- | --- | --- |
| `turbo` | 10 chars | unmeasured, faster than `fast` | the file is long and the point is the result |
| `fast` (default) | 4 chars | 505 chars/s, 14.7 s for 7,438 chars | normal showing off |
| `normal` | 1 char | 45 chars/s | the audience wants to read every line as it appears |
| `slow` | 1 char | 22 chars/s | teaching, or a very short payload |

## How it works

| Piece | Job |
| --- | --- |
| `stage.sh` | closes the last staged window, writes the mission file, opens one window, streams the run log, verifies the result |
| `typer/` | a VS Code extension loaded as a dev host. Reads the mission, types the payload, runs the command |
| `assets/rain.py` | the background animation, standard library only |
| `assets/demos/` | payloads to stage: `access_granted.py`, `solar_system.html` |
| `.live-typer/` | per project runtime folder: mission, log, close marker |

The extension watches a control file in each staged window. When `stage.sh`
wants that window gone, it writes a close request and the window closes itself,
which is how the skill keeps one window instead of a pile. A marker file is
written before the window dies, so the wait is on a fact rather than a timeout.

## Why the code looks paranoid

Each oddity below cost a debugging round on Ubuntu 26.04 with GNOME Wayland and
VS Code 1.144.0.

| Failure | Cause | Fix in the code |
| --- | --- | --- |
| `code <dir>` exits 0 and no window appears | the harness sandbox runs `bwrap --unshare-pid --die-with-parent`, so the GUI dies with the call | stage.sh must run with full host access |
| logs written by the extension are empty when read back | `/tmp` inside the sandbox is a private tmpfs | logs go to the project, not `/tmp` |
| the extension never sees its environment | a second `code` call forwards to the running instance, which keeps its own environment | the mission travels in a JSON file |
| the view sits still while typing runs past the bottom | document edits do not move the caret, and VS Code scrolls to follow the caret | the caret is moved to the insertion point and revealed after every batch, and the log prints which lines were on screen |
| stray quotes appear as they are typed | VS Code auto-closes quotes and brackets on the typing path | the buffer is compared with the payload every 8 characters and repaired |
| the typed text ignores its position | the `type` command writes at the cursor, and the cursor drifts, so a whole file landed on one line | insert at an explicit end position through `editor.edit`, force the cursor before any fallback `type` |
| indentation doubles | `type` applies auto-indent to newlines | newlines are inserted as document edits, which skip auto-indent |
| the buffer starts with the last run's text | a new window restores the previously open tab | close all editors, truncate the file, then open it |
| two windows pile up fast | nothing closed the old one | the control-file watcher above |
| the editor is left dirty after a repair | the file was rewritten underneath an open buffer | revert the editor after writing |

Typing also self-heals: every 25 characters the buffer is compared with that
prefix of the payload, and a mismatch is repaired on the spot. The final file is
compared once more and rewritten if it drifted at all.

## Numbers

Measured on a Lenovo LOQ 15IRX9, i7-13650HX, 120x40 terminal:

| Measurement | Value |
| --- | --- |
| rain frame rate | 22.0 fps |
| rain CPU, one core | 2.9 percent |
| bytes per frame | 13.8 KB |
| typing speed, `fast` | 505 characters per second, 14.7 s for 7,438 characters |
| typing speed, `normal` | 45 characters per second, about 20 s for 900 characters |
| drift between typed buffer and payload | 0 bytes |

## Requirements

- VS Code with the `code` command on PATH
- Python 3, standard library only
- Linux. Tested on GNOME Wayland, where `xdotool`, `wtype` and `ydotool` do not
  exist or do not work, which is why typing happens inside VS Code instead
- an agent harness that can run the launch command outside its own sandbox

## Install

```sh
cp -r live-coding-stage ~/.dsh/skills/
```

The skill is a `SKILL.md` plus three files that do the work. Point an agent at
it and it can stage a session on request.

## Limits

- One staged window at a time by design. `--keep` overrides it.
- Pacing is human, so long payloads take a while. Keep the payload under about
  1200 characters and explain the rest in chat.
- Screenshots are not part of this. GNOME denies the shell screenshot API to
  unattended processes, so verification runs on the log and on byte comparison.
- The rain is decoration. `--no-rain` removes it.

## License

MIT. See `LICENSE`.
