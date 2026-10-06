#!/usr/bin/env node
// Drive a website as the person signed in to their real Google Chrome.
//
// How: copy one Chrome profile's cookie store (and its Local Storage) into a
// throwaway --user-data-dir, launch the REAL Google Chrome binary on it (so
// Chrome itself decrypts the cookies with the "Chrome Safe Storage" Keychain
// key — nothing is ever decrypted or written out in plaintext by us), and leave
// it running as a session that the verbs below drive over the Chrome DevTools
// Protocol. `stop` kills that Chrome and deletes the throwaway profile.
//
// Nothing here knows about any particular website.
//
// Usage: node browser.mjs <verb> [args]   (run `help` for the list)

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHROME_ROOT = path.join(os.homedir(), "Library/Application Support/Google/Chrome");
const STATE_DIR = path.join(os.tmpdir(), "use-my-browser");
const SESSION_FILE = path.join(STATE_DIR, "session.json");

const HELP = `use-my-browser — drive any website as the person signed in to this Mac's Google Chrome

  profiles                          list Chrome profiles (dir, name, account)
  start [--profile DIR] [--headful] launch a session on a throwaway copy of that profile's
                                    cookies (default: Chrome's last-used profile)
  status                            is a session running, and what page is it on
  goto <url>                        navigate and wait for the load; prints url + title
  text [selector] [--max N]         the page's (or element's) visible text, default 20000 chars
  eval <js>                         evaluate an expression in the page (awaits promises); prints JSON
  click <selector> [--text STR]     real mouse click on the first match (optionally whose text
                                    contains STR)
  type <text>|--file PATH [--into SELECTOR]
                                    type into the focused element (or click SELECTOR first);
                                    newlines become Enter
  press <key>                       Enter, Tab, Escape, Backspace, ArrowDown, ArrowUp
  wait <js> [--timeout MS]          poll until the expression is truthy (default 20000ms)
  screenshot <file.png>             capture the viewport
  stop                              kill the session's Chrome and delete the throwaway profile`;

const KEYS = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  ArrowDown: 40,
  ArrowUp: 38,
};

function fail(msg) {
  console.error(`use-my-browser: ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Splits argv into positionals and --flags. A flag listed in `bools` takes no value.
function parseArgs(argv, bools = []) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith("--")) pos.push(k);
    else if (bools.includes(k.slice(2))) flags[k.slice(2)] = true;
    else if (i + 1 < argv.length) flags[k.slice(2)] = argv[++i];
    else fail(`${k} needs a value`);
  }
  return { pos, flags };
}

function readLocalState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(CHROME_ROOT, "Local State"), "utf8"));
  } catch {
    return {};
  }
}

function listProfiles() {
  if (!fs.existsSync(CHROME_ROOT)) fail(`no Chrome data at ${CHROME_ROOT}`);
  const info = readLocalState().profile?.info_cache ?? {};
  return fs
    .readdirSync(CHROME_ROOT)
    .filter((d) => d === "Default" || d.startsWith("Profile "))
    .map((dir) => ({ dir, name: info[dir]?.name ?? "", account: info[dir]?.user_name ?? "" }));
}

function cookieFile(profileDir) {
  for (const rel of ["Network/Cookies", "Cookies"]) {
    if (fs.existsSync(path.join(profileDir, rel))) return rel;
  }
  return null;
}

function readSession() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanup(session) {
  if (alive(session.pid)) {
    try {
      process.kill(session.pid, "SIGTERM");
    } catch {}
  }
  fs.rmSync(session.tmpRoot, { recursive: true, force: true });
  fs.rmSync(SESSION_FILE, { force: true });
}

function requireSession() {
  const s = readSession();
  if (!s) fail("no session — run `start` first");
  if (!alive(s.pid)) {
    cleanup(s);
    fail("the session's Chrome is gone (cleaned up) — run `start` again");
  }
  return s;
}

async function cdpConnect(port) {
  let wsUrl;
  for (let i = 0; i < 50 && !wsUrl; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      wsUrl = targets.find((t) => t.type === "page")?.webSocketDebuggerUrl;
    } catch {}
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) fail("Chrome did not expose a DevTools page target");
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    } else if (msg.method && listeners.has(msg.method)) {
      for (const fn of listeners.get(msg.method)) fn(msg.params);
      listeners.delete(msg.method);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const n = ++id;
      pending.set(n, { res, rej });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const once = (method, timeoutMs) =>
    new Promise((res) => {
      const t = setTimeout(() => res(false), timeoutMs);
      listeners.set(method, [
        ...(listeners.get(method) ?? []),
        () => {
          clearTimeout(t);
          res(true);
        },
      ]);
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description ?? "evaluate failed");
    return r.result.value;
  };
  return { ws, send, once, evaluate };
}

async function waitFor(cdp, expression, what, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const v = await cdp.evaluate(expression);
      if (v) return v;
    } catch {}
    await sleep(300);
  }
  fail(`timed out waiting for ${what}`);
}

async function clickAt(cdp, x, y) {
  for (const type of ["mousePressed", "mouseReleased"])
    await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
}

async function pressKey(cdp, key) {
  const code = KEYS[key];
  if (!code) fail(`unknown key "${key}" — one of ${Object.keys(KEYS).join(", ")}`);
  for (const type of ["keyDown", "keyUp"])
    await cdp.send("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: code });
}

// Scrolls the first match into view and returns its centre, or null.
function locate(selector, text) {
  return `(() => { const want = ${JSON.stringify(text ?? null)};
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((e) => want === null || (e.innerText || e.value || e.getAttribute('aria-label') || '').includes(want));
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`;
}

async function start(flags) {
  const existing = readSession();
  if (existing) {
    if (alive(existing.pid))
      fail(`a session is already running (profile "${existing.profile}") — \`stop\` it first`);
    cleanup(existing);
  }
  if (!fs.existsSync(CHROME_BIN)) fail(`Google Chrome not found at ${CHROME_BIN}`);

  const profiles = listProfiles();
  const wanted = flags.profile ?? readLocalState().profile?.last_used ?? "Default";
  const profile = profiles.find((p) => p.dir === wanted || (flags.profile && p.name === wanted));
  if (!profile)
    fail(`no Chrome profile "${wanted}" — have: ${profiles.map((p) => p.dir).join(", ")}`);
  const src = path.join(CHROME_ROOT, profile.dir);
  const rel = cookieFile(src);
  if (!rel) fail(`Chrome profile "${profile.dir}" has no cookie store`);

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "use-my-browser-"));
  const dest = path.join(tmpRoot, "Default", rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(src, rel), dest);
  fs.chmodSync(dest, 0o600);
  // Sites that keep a session token in localStorage need it too. Best effort: the
  // live LevelDB may be mid-write, and a partial copy only costs that site's login.
  try {
    fs.cpSync(path.join(src, "Local Storage"), path.join(tmpRoot, "Default", "Local Storage"), {
      recursive: true,
    });
  } catch {}

  const port = 9300 + Math.floor(Math.random() * 500);
  const chrome = spawn(
    CHROME_BIN,
    [
      `--user-data-dir=${tmpRoot}`,
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      ...(flags.headful ? [] : ["--headless=new", "--window-size=1280,900"]),
      "about:blank",
    ],
    { stdio: "ignore", detached: true },
  );
  chrome.unref();
  const session = { pid: chrome.pid, port, tmpRoot, profile: profile.dir };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session), { mode: 0o600 });
  try {
    const cdp = await cdpConnect(port);
    cdp.ws.close();
  } catch (e) {
    cleanup(session);
    throw e;
  }
  const who = [profile.name, profile.account].filter(Boolean).join(", ");
  console.log(`session started on Chrome profile "${profile.dir}"${who ? ` (${who})` : ""}`);
}

async function run(verb, argv) {
  if (verb === "help" || verb === "--help" || !verb) return console.log(HELP);
  if (verb === "profiles") {
    for (const p of listProfiles()) console.log(`${p.dir}\t${p.name}\t${p.account}`);
    console.log(`last used: ${readLocalState().profile?.last_used ?? "Default"}`);
    return;
  }
  if (verb === "start") return start(parseArgs(argv, ["headful"]).flags);
  if (verb === "stop") {
    const s = readSession();
    if (!s) return console.log("no session running");
    cleanup(s);
    return console.log("session stopped; throwaway profile deleted");
  }

  const VERBS = ["status", "goto", "text", "eval", "click", "type", "press", "wait", "screenshot"];
  if (!VERBS.includes(verb)) fail(`unknown verb "${verb}" — run \`help\``);
  const { pos, flags } = parseArgs(argv);
  const session = requireSession();
  const cdp = await cdpConnect(session.port);
  try {
    switch (verb) {
      case "status": {
        const page = await cdp.evaluate("({ url: location.href, title: document.title })");
        console.log(`profile "${session.profile}" — ${page.url} — ${page.title}`);
        break;
      }
      case "goto": {
        if (!pos[0]) fail("goto needs a url");
        await cdp.send("Page.enable");
        const loaded = cdp.once("Page.loadEventFired", 30000);
        const r = await cdp.send("Page.navigate", { url: pos[0] });
        if (r.errorText) fail(`navigation failed: ${r.errorText}`);
        if (!(await loaded))
          console.error("use-my-browser: load event not seen in 30s; continuing");
        const page = await cdp.evaluate("({ url: location.href, title: document.title })");
        console.log(`${page.url} — ${page.title}`);
        break;
      }
      case "text": {
        const max = Number(flags.max ?? 20000);
        const sel = JSON.stringify(pos[0] ?? "body");
        const t = await cdp.evaluate(`document.querySelector(${sel})?.innerText ?? null`);
        if (t === null) fail(`no element matches ${pos[0]}`);
        console.log(t.length > max ? `${t.slice(0, max)}\n… [${t.length - max} more chars]` : t);
        break;
      }
      case "eval": {
        if (!pos[0]) fail("eval needs an expression");
        console.log(JSON.stringify(await cdp.evaluate(pos[0]), null, 2) ?? "undefined");
        break;
      }
      case "click": {
        if (!pos[0]) fail("click needs a selector");
        const at = await cdp.evaluate(locate(pos[0], flags.text));
        if (!at)
          fail(`no element matches ${pos[0]}${flags.text ? ` with text "${flags.text}"` : ""}`);
        await sleep(150);
        await clickAt(cdp, at.x, at.y);
        console.log("clicked");
        break;
      }
      case "type": {
        const text = flags.file ? fs.readFileSync(flags.file, "utf8").trim() : pos[0];
        if (text === undefined) fail("type needs text or --file PATH");
        if (flags.into) {
          const at = await cdp.evaluate(locate(flags.into));
          if (!at) fail(`no element matches ${flags.into}`);
          await clickAt(cdp, at.x, at.y);
          await sleep(300);
        }
        // insertText goes through the editor's real input pipeline; line breaks need Enter.
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i]) await cdp.send("Input.insertText", { text: lines[i] });
          if (i < lines.length - 1) await pressKey(cdp, "Enter");
        }
        console.log("typed");
        break;
      }
      case "press": {
        if (!pos[0]) fail("press needs a key");
        await pressKey(cdp, pos[0]);
        console.log(`pressed ${pos[0]}`);
        break;
      }
      case "wait": {
        if (!pos[0]) fail("wait needs an expression");
        const v = await waitFor(cdp, pos[0], pos[0], Number(flags.timeout ?? 20000));
        console.log(JSON.stringify(v));
        break;
      }
      case "screenshot": {
        if (!pos[0]) fail("screenshot needs an output path");
        const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(pos[0], Buffer.from(data, "base64"));
        console.log(`saved ${pos[0]}`);
        break;
      }
    }
  } finally {
    cdp.ws.close();
  }
}

const [verb, ...rest] = process.argv.slice(2);
run(verb, rest).catch((e) => {
  if (!process.exitCode) console.error(`use-my-browser: ${e.message}`);
  process.exitCode = 1;
});
