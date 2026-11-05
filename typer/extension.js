// Live Coding Stage: types a payload into a file, visibly, then runs it, with a
// glitch binary rain in the terminal panel.
//
// Mission comes from <workspace>/.live-typer/mission.json, NOT from env vars,
// because a second `code` invocation forwards the open request to the already
// running instance and the new window never sees that process's environment.
//
// Window hygiene: every staged window watches <workspace>/.live-typer/control.json
// and closes itself when asked, so stage.sh keeps exactly one staged window.
//
// Typing engine, and why it looks like this:
//  - text is inserted at an explicit end-of-document position through
//    editor.edit(). The `type` command writes at the cursor and the cursor
//    drifts, which once wrote a whole file onto a single line. `type` remains as
//    a fallback with the cursor forced first, and the log counts both paths.
//  - characters are inserted in small batches (see SPEEDS) because a round trip
//    per character, not the sleep, is what makes typing slow.
//  - newlines are always their own insert, so auto-indent never applies and the
//    payload keeps its own indentation.
//  - VS Code auto-closes quotes and brackets on the typing path, which adds
//    stray characters, so the buffer is compared with the payload prefix every
//    RESYNC_EVERY characters and repaired on the spot.
//  - document edits do not move the caret, and VS Code scrolls to follow the
//    caret, so the caret is moved to the insertion point and revealed after
//    every batch. Without that the typing runs off screen.
//  - the target file is truncated to 0 bytes first, and a fresh window restores
//    the previous tab, so all editors are closed before opening it.
//  - /tmp is a private tmpfs for sandboxed readers: logs live in the workspace.
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const SKILL_DIR = path.resolve(__dirname, "..");
const STATE = path.join(SKILL_DIR, "state");
const RAIN = path.join(SKILL_DIR, "assets", "rain.py");
const FALLBACK_LOG = path.join(STATE, "no-workspace.log");
const RESYNC_EVERY = 8;

// batch size, per-batch delay range, newline delay range (milliseconds)
const SPEEDS = {
  turbo: { batch: 10, min: 0, spread: 1, nlMin: 3, nlSpread: 3 },
  fast: { batch: 4, min: 1, spread: 2, nlMin: 4, nlSpread: 4 },
  normal: { batch: 1, min: 7, spread: 12, nlMin: 26, nlSpread: 30 },
  slow: { batch: 1, min: 22, spread: 22, nlMin: 60, nlSpread: 50 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ran = false;

function fallbackLog(line) {
  try {
    fs.mkdirSync(STATE, { recursive: true });
    fs.appendFileSync(FALLBACK_LOG, `${new Date().toISOString()} [pid ${process.pid}] ${line}\n`);
  } catch (_) {}
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return null;
  }
}

function makeLog(root) {
  const dir = path.join(root, ".live-typer");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "run.log");
  return (line) => {
    try {
      fs.appendFileSync(p, `${new Date().toISOString()} ${line}\n`);
    } catch (_) {}
  };
}

// Self-close on request. A cheap poll: no watcher resources, and it keeps
// working while the window sits unfocused in the background.
function watchControl(root, log) {
  const control = path.join(root, ".live-typer", "control.json");
  let seen = "";
  const timer = setInterval(() => {
    let raw = "";
    try {
      raw = fs.readFileSync(control, "utf8");
    } catch (e) {
      return;
    }
    if (raw === seen) return;
    seen = raw;
    const cmd = readJson(control);
    if (cmd && cmd.action === "close") {
      log(`control: close requested (${cmd.at || "no timestamp"})`);
      clearInterval(timer);
      // marker first: stage.sh waits on it, and it must survive the window dying
      try {
        fs.writeFileSync(path.join(root, ".live-typer", "closed.marker"), new Date().toISOString());
      } catch (_) {}
      vscode.commands.executeCommand("workbench.action.closeWindow");
    }
  }, 700);
}

// Insert text at an absolute position. editor.edit is the reliable path; the
// `type` command is the fallback, with the cursor and selection forced to the
// insertion point because that is where `type` writes.
async function insertAt(editor, pos, text, tally) {
  const ok = await editor.edit((b) => b.insert(pos, text), {
    undoStopBefore: false,
    undoStopAfter: false,
  });
  if (ok) {
    tally.edit += 1;
    return true;
  }
  tally.type += 1;
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos));
  try {
    await vscode.commands.executeCommand("type", { text });
    return true;
  } catch (e) {
    return false;
  }
}

// Document edits made through the API do not move the caret, and VS Code only
// scrolls to follow the caret, so a long file would be typed off screen while
// the view sat still. Put the caret at the insertion point and reveal it, which
// is also what real typing looks like: the caret rides along with the text.
function followCaret(editor, doc) {
  const end = doc.positionAt(doc.getText().length);
  if (!editor.selection.active.isEqual(end)) {
    editor.selection = new vscode.Selection(end, end);
  }
  editor.revealRange(new vscode.Range(end, end), vscode.TextEditorRevealType.Default);
}

// Force the buffer back to the payload prefix. Auto-closing pairs and any failed
// insert are invisible in the final file, but they are visible on screen, and
// the point of the exercise is what is on screen.
async function resync(editor, doc, target, want, log) {
  if (doc.getText() === want) return true;
  const before = doc.getText().length;
  const full = new vscode.Range(doc.positionAt(0), doc.positionAt(before));
  const we = new vscode.WorkspaceEdit();
  we.replace(target, full, want);
  const ok = await vscode.workspace.applyEdit(we);
  log(`resync want ${want.length}: ${before} -> ${doc.getText().length} chars (${ok ? "ok" : "failed"})`);
  return ok;
}

async function activate() {
  if (ran) return;
  ran = true;

  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length === 0) {
    fallbackLog("activated with NO workspace folder, nothing to stage");
    vscode.window.showWarningMessage(
      "live-coding-stage: this window has no folder open, so nothing was staged."
    );
    return;
  }

  const root = folders[0].uri.fsPath;
  const log = makeLog(root);
  watchControl(root, log);

  const missionPath = path.join(root, ".live-typer", "mission.json");
  const mission = readJson(missionPath);
  if (!mission) {
    log("no mission.json, window registered for close control only");
    return;
  }

  log(`mission: ${JSON.stringify(mission)}`);
  if (mission.runs && mission.runs.length > 0) {
    log(`already ran ${mission.runs.length}x, skipping (delete .live-typer/mission.json to replay)`);
    return;
  }
  mission.runs = [Date.now()];
  fs.writeFileSync(missionPath, JSON.stringify(mission, null, 2));

  const payloadPath = mission.payload;
  if (!payloadPath || !fs.existsSync(payloadPath)) return log(`missing payload ${payloadPath}`);
  const SRC = fs.readFileSync(payloadPath, "utf8");
  const targetName = mission.name || path.basename(payloadPath);
  const target = vscode.Uri.file(path.join(root, targetName));
  const speed = SPEEDS[mission.speed] || SPEEDS.fast;
  log(`speed: ${mission.speed || "fast"} (batch ${speed.batch})`);

  await sleep(mission.warmupMs || 700);

  // 1. rain first, so it is already raining behind the editor
  let rainTerm = null;
  if (mission.rain !== false && fs.existsSync(RAIN)) {
    try {
      const cmd = ["python3", JSON.stringify(RAIN), "--fps", String(mission.fps || 22)].join(" ");
      rainTerm = vscode.window.createTerminal({
        name: "rain",
        cwd: root,
        iconPath: new vscode.ThemeIcon("pulse"),
      });
      rainTerm.show(true);
      rainTerm.sendText(cmd);
      log("rain terminal started");
      await sleep(400);
    } catch (e) {
      log(`rain failed: ${e && e.message}`);
    }
  }

  // 2. fresh empty buffer, then type it in
  let typed = 0;
  try {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.workspace.fs.writeFile(target, Buffer.alloc(0));
    const doc = await vscode.workspace.openTextDocument(target);
    let editor = await vscode.window.showTextDocument(doc, {
      preview: false,
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
    });
    log(`typing ${SRC.length} chars into ${targetName} (buffer ${doc.getText().length})`);

    // let the freshly opened document settle: editing in the same tick as the
    // open can drop the first insert
    await sleep(250);
    if (doc.getText().length !== 0) log(`buffer was not empty: ${doc.getText().length} chars`);

    const tally = { edit: 0, type: 0 };
    const started = Date.now();
    const flush = (chunk) => {
      if (!chunk) return Promise.resolve(true);
      const end = doc.positionAt(doc.getText().length);
      return insertAt(editor, end, chunk, tally);
    };

    let buffer = "";
    for (let i = 0; i < SRC.length; i += 1) {
      const ch = SRC[i];
      if (vscode.window.activeTextEditor !== editor) {
        editor = await vscode.window.showTextDocument(doc, {
          preview: false,
          preserveFocus: false,
        });
      }

      if (ch === "\n") {
        if (!(await flush(buffer))) {
          log(`insert rejected at ${typed}`);
          break;
        }
        typed += buffer.length;
        buffer = "";
        if (!(await flush("\n"))) {
          log(`newline rejected at ${typed}`);
          break;
        }
        typed += 1;
      } else {
        buffer += ch;
        if (buffer.length < speed.batch) continue;
        if (!(await flush(buffer))) {
          log(`insert rejected at ${typed}`);
          break;
        }
        typed += buffer.length;
        buffer = "";
      }

      if (mission.autoScroll !== false) followCaret(editor, doc);
      if (typed % RESYNC_EVERY === 0) {
        await resync(editor, doc, target, SRC.slice(0, typed), log);
      }
      const quarter = Math.floor(SRC.length / 4) || 1;
      if (typed % quarter === 0) log(`typed ${typed}/${SRC.length}`);

      const d =
        ch === "\n"
          ? speed.nlMin + Math.random() * speed.nlSpread
          : speed.min + Math.random() * speed.spread;
      await sleep(d);
    }
    if (buffer && (await flush(buffer))) typed += buffer.length;

    await resync(editor, doc, target, SRC.slice(0, typed), log);
    await doc.save();
    const seconds = Math.max((Date.now() - started) / 1000, 0.001);
    log(
      `typed ${typed}/${SRC.length}, buffer ${doc.getText().length} chars in ` +
        `${seconds.toFixed(1)}s (${Math.round(typed / seconds)} chars/s), ` +
        `path: editor.edit ${tally.edit}x, type ${tally.type}x`
    );

    // proof that the view followed the typing instead of leaving it off screen
    const vis = editor.visibleRanges && editor.visibleRanges[0];
    const lastLine = doc.lineCount - 1;
    const firstShown = vis ? vis.start.line + 1 : 0;
    const lastShown = vis ? vis.end.line + 1 : 0;
    log(
      `view: lines ${firstShown}-${lastShown} of ${doc.lineCount}, ` +
        `end on screen: ${Boolean(vis && vis.end.line >= lastLine)}`
    );

    if (doc.getText() !== SRC) {
      await vscode.workspace.fs.writeFile(target, Buffer.from(SRC, "utf8"));
      log("final mismatch, rewrote from payload");
      try {
        await vscode.commands.executeCommand("workbench.action.files.revert");
      } catch (e) {
        log(`revert failed: ${e && e.message}`);
      }
    }
  } catch (e) {
    log(`typing threw: ${e && e.message}`);
  }

  // 3. run it
  if (mission.run) {
    try {
      await sleep(300);
      const term = vscode.window.createTerminal({
        name: "run",
        cwd: root,
        location: rainTerm ? { parentTerminal: rainTerm } : undefined,
      });
      term.show(true);
      term.sendText(mission.run);
      log(`ran: ${mission.run}`);
    } catch (e) {
      log(`run failed: ${e && e.message}`);
    }
  }

  log("done");
}

function deactivate() {}

module.exports = { activate, deactivate };
