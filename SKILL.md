---
name: live-coding-stage
description: >
  Open a folder in VS Code on the user's screen and write code into it live,
  character by character, so the user can watch the work happen, with a glitch
  binary rain running in the terminal panel and the result executed in a split
  terminal. Use when asked to "open this folder in VS Code", "live code",
  "code in front of me", "let me watch you code", "hacker mode", or "make it
  rain binary", and the request needs the user's real desktop, not a report.
whenToUse: >
  Use whenever the deliverable should appear on screen as it is being written,
  or whenever the user wants the binary-rain / hacker visual while an agent
  works in an editor.
---

# Live coding stage

Source: https://github.com/ayushkharwar/live-coding-stage

One window, one payload, typed live. Read the constraints before changing
anything, each one cost a debugging round.

## Run it: one escalated call

```sh
sh ~/.dsh/skills/live-coding-stage/stage.sh <project-dir> \
  --payload /path/to/finished-file.py \
  --name demo.py \
  --run "python3 demo.py"
```

Flags: `--name` (filename inside the project, default = payload basename),
`--run` (command for the second terminal, omit to skip), `--no-rain`,
`--fps N`, `--keep` (leave the previous window open), `--wait SECONDS`,
`--speed turbo|fast|normal|slow` (default `fast`: 505 chars/s, so a 7,438
character file takes 14.7 s. `normal` is 45 chars/s for showing every line,
`turbo` is faster still and unmeasured).

The command does the whole cycle and prints the result, so it needs no second
step: it closes the previous staged window, opens one new window, streams the
run log, and ends with `RESULT : IDENTICAL` or `RESULT : MISMATCH`.

Other entry points:

```sh
sh ~/.dsh/skills/live-coding-stage/stage.sh --verify <project-dir>   # read the log
sh ~/.dsh/skills/live-coding-stage/stage.sh --close-all              # close staged windows
```

A clean log has no `resync`, no `insert rejected`, no `final mismatch`, and
`typed N/N, buffer N chars` with both numbers equal.

## Workflow

1. Write the payload first, fully working, and run it yourself. The stage only
   replays a file that already passes. Never type code you have not run.
2. Keep the payload outside the project. `stage.sh` copies it to
   `state/payload-<name>` and the extension types from that copy, so a window
   closed mid-run cannot destroy the original.
3. Stage it with the single escalated `stage.sh` call.
4. If the result says MISMATCH, read `.live-typer/run.log` before touching
   anything; the log names the step that failed.
5. Replay: delete `<project>/.live-typer/mission.json` and relaunch.

## Why each piece is shaped this way

| Constraint | Consequence |
| --- | --- |
| bash runs inside `bwrap --unshare-pid --die-with-parent` | a GUI launched from a sandboxed call dies with the sandbox: `code` exits 0 and no window appears. The launch needs `sandbox_permissions=danger-full-access` |
| `/tmp` is a private tmpfs inside the sandbox | logs written to `/tmp` by the extension are invisible to sandboxed reads. All logs live in `<project>/.live-typer/run.log` and `state/` |
| a second `code` call forwards to the running instance | the new window inherits the main process env, not the caller's. Mission state goes in a JSON file, never env vars |
| `xdotool`, `wtype`, `ydotool` absent, session is pure Wayland | no OS-level keystroke injection. Typing happens inside VS Code |
| the `type` command writes at the cursor | the cursor drifts, and a whole file once landed on one line. Characters are inserted at an explicit end position through `editor.edit`; `type` is a fallback with the cursor forced first |
| `type` applies auto-indent to newlines | newlines go through document edits, which skip auto-indent, so the payload keeps its own indentation |
| a new window restores the previously open tab | close all editors, truncate the target to 0 bytes, then open it, otherwise the last run's buffer comes back |
| `applyEdit` clearing a just-written buffer returns `false` silently | never clear a buffer; truncate the file on disk first |
| writing under an open buffer leaves the editor dirty | revert the editor after any repair |
| document edits do not move the caret, so the view never scrolls | the caret is moved to the insertion point and revealed after every batch; the log prints `view: lines A-B of N` as proof |
| VS Code auto-closes quotes and brackets while typing | the buffer is compared with the payload prefix every 8 characters and repaired, so what is on screen stays correct |
| a round trip per character caps typing at about 45 chars/s | characters are inserted in batches (`--speed`), which reaches 505 chars/s |
| dev-host windows close, taking the run with them | the payload is copied to `state/` first, and every step logs before it acts |
| nothing closed the old window | each staged window watches `.live-typer/control.json` and closes itself on request, writing `closed.marker` first so `stage.sh` waits on a fact |

## Measured, for reference

Rain at 22 fps in a 120x40 panel costs 2.9 percent of one core, 13.8 KB a
frame. Typing at `fast` runs 505 characters a second, so a 7,438 character
payload takes 14.7 seconds, the view ends on the last line of 231, and the
buffer ends byte-identical to the payload with zero repair passes.

## Layout

```
~/.dsh/skills/live-coding-stage/
  SKILL.md            this file
  stage.sh            close previous, stage mission, open window, verify
  typer/              the dev-host extension that types and runs
  assets/rain.py      glitch binary rain, stdlib only
  assets/demos/       ready-made payloads, e.g. access_granted.py
  state/              payload copies, window registry, launcher log
```

## Do not

- Do not run `stage.sh` sandboxed: it will look successful and open nothing.
- Do not `rm -rf` a project to reset it; delete `.live-typer/mission.json`.
- Do not type very long payloads. Under 1200 characters keeps the wait sane.
- Do not leave rain orphans behind: `pkill -f live-coding-stage/assets/rain.py`
  clears them, and `--close-all` does it for staged windows.
- Do not stack windows with `--keep` unless the user asked for it.
