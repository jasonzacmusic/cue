// Windows and Linux Cue arrive as a zip or a tarball that people unzip
// wherever their browser saved it, usually Downloads. Updating in place needs a
// home that Cue owns, so the first time it runs from anywhere else it copies
// itself to that home, adds itself to the Start menu (Windows) or the apps menu
// (Linux), opens again from there and says so once.
//
//   Windows  %LOCALAPPDATA%\Programs\Cue\          Start menu: Cue.lnk
//   Linux    ~/.local/share/cue/                  ~/.local/share/applications/cue.desktop,
//                                                 ~/.local/share/icons/cue.png, ~/.local/bin/cue
//
// Never on a Mac, never in development, never under CUE_TEST or CUE_SMOKE, and
// never for a Linux copy installed by the system (/opt, /usr, an AppImage).
// Safe to run on every launch: from the home it only makes sure the menu
// entries are there.
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('./update-core');

const MOVED = {
  win32: 'Cue has moved itself to a permanent place and added itself to your Start menu. You can delete the folder you unzipped.',
  linux: 'Cue has moved itself to a permanent place and added itself to your apps menu. You can delete the folder you unzipped.',
};
const FLAG = '--cue-settled';

const same = (a, b, platform) => {
  const n = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  return platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

// The home folder goes into the shell script inside single quotes, where nothing is special
// except the single quote itself, which is closed, escaped and reopened: ' becomes '\''.
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Chromium's sandbox needs unprivileged user namespaces. Ubuntu 23.10 and later
// (AppArmor `apparmor_restrict_unprivileged_userns=1`) refuse them to any app
// without its own AppArmor profile, and a copy in a home folder cannot install
// one; nor can it make chrome-sandbox setuid root. Only on such a system does
// the launcher switch the sandbox off, and it says why in its own text.
function linuxLauncher(home) {
  return `#!/bin/sh
# Cue's launcher, written by Cue (src/main/settle.js).
# Chromium's sandbox needs unprivileged user namespaces. Where the system
# refuses them (Ubuntu 23.10+ AppArmor restriction, or the sysctls below set to
# 0), Cue starts with --no-sandbox; everywhere else the sandbox stays on.
CUE_HOME=${shQuote(home)}
NOSANDBOX=""
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = "1" ] \\
  || [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" = "0" ] \\
  || [ "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null)" = "0" ]; then
  NOSANDBOX="--no-sandbox"
  # Cue reads this and tells the person the sandbox is off on this computer.
  CUE_LINUX_UNSANDBOXED=1
  export CUE_LINUX_UNSANDBOXED
fi
exec "$CUE_HOME/Cue" $NOSANDBOX "$@"
`;
}

// A .desktop file has two layers of escaping (freedesktop Desktop Entry spec, "The Exec key").
// First a quoted argument: inside "...", the characters " ` $ and \ each take a backslash.
// Then the whole value is a string, where every backslash is written twice. A % is doubled
// too, since %U and friends are Exec's own codes. Icon= is a plain string: only that second layer.
const deskString = (s) => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r').replace(/^ /, '\\s');
const execArg = (s) => deskString(`"${String(s).replace(/["`$\\]/g, (c) => `\\${c}`)}"`).replace(/%/g, '%%');
function desktopEntry(launcher, icon) {
  return `[Desktop Entry]
Type=Application
Name=Cue
Comment=The Nathaniel School of Music browser
Exec=${execArg(launcher)} %U
Icon=${deskString(icon)}
Terminal=false
Categories=Network;WebBrowser;
StartupWMClass=Cue
`;
}

const writeIfChanged = (file, text, mode) => {
  let was = null; try { was = fs.readFileSync(file, 'utf8'); } catch {}
  if (was === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, mode ? { mode } : undefined);
  if (mode) fs.chmodSync(file, mode);
  return true;
};

// The menu entries for a Cue living in `home`. Idempotent.
function ensureEntries({ platform, home, env = process.env, homedir = os.homedir(), shell, iconFrom }) {
  if (platform === 'win32') {
    const lnk = path.join(env.APPDATA || path.join(homedir, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Cue.lnk');
    const target = path.join(home, 'Cue.exe');
    let now = null; try { now = shell.readShortcutLink(lnk); } catch {}
    if (now && same(now.target, target, platform)) return { lnk };
    fs.mkdirSync(path.dirname(lnk), { recursive: true });
    shell.writeShortcutLink(lnk, now ? 'replace' : 'create', { target, cwd: home, description: 'Cue', icon: target, iconIndex: 0 });
    return { lnk };
  }
  const data = env.XDG_DATA_HOME || path.join(homedir, '.local', 'share');
  const launcher = path.join(homedir, '.local', 'bin', 'cue');
  const icon = path.join(data, 'icons', 'cue.png');
  const desktop = path.join(data, 'applications', 'cue.desktop');
  writeIfChanged(launcher, linuxLauncher(home), 0o755);
  try {
    const png = fs.readFileSync(iconFrom || path.join(home, 'resources', 'app.asar', 'assets', 'icon.png'));
    let was = null; try { was = fs.readFileSync(icon); } catch {}
    if (!was || !was.equals(png)) { fs.mkdirSync(path.dirname(icon), { recursive: true }); fs.writeFileSync(icon, png); }
  } catch {}
  writeIfChanged(desktop, desktopEntry(launcher, icon));
  return { launcher, icon, desktop };
}

// Returns { relaunch: { execPath, args } } when Cue has to open again from its
// new home, otherwise {}. The caller does the relaunch and exits.
async function settle({ app, shell, platform = process.platform, execPath = process.execPath, env = process.env, homedir = os.homedir(), argv = process.argv, log = () => {}, force = false } = {}) {
  if (platform !== 'win32' && platform !== 'linux') return {};
  if (!force && (!app.isPackaged || env.CUE_TEST || env.CUE_SMOKE)) return {};
  const here = path.dirname(execPath);
  const home = core.perUserHome(platform, env, homedir);
  if (!home) return {};
  if (platform === 'linux' && (env.APPIMAGE || /^\/(opt|usr|snap)\//.test(here))) return {};
  if (same(here, home, platform)) {
    try { ensureEntries({ platform, home, env, homedir, shell }); } catch (e) { log(e); }
    return {};
  }
  const exe = path.join(home, core.exeName(platform));
  const extra = argv.slice(1).filter((a) => a !== FLAG);
  const relaunchFrom = (dir) => (platform === 'linux'
    // Through the launcher, which decides about the sandbox. A --no-sandbox the
    // person started this copy with is kept: this copy is proof it was needed.
    ? { execPath: path.join(homedir, '.local', 'bin', 'cue'), args: [...extra, FLAG] }
    : { execPath: path.join(dir, 'Cue.exe'), args: [...extra, FLAG] });

  // A newer Cue already lives at home (this is an old download opened again):
  // open that one instead and leave it be.
  const theirs = (() => { try { return String(JSON.parse(fs.readFileSync(path.join(home, 'resources', 'app.asar', 'package.json'), 'utf8')).version || ''); } catch { return ''; } })();
  const mine = app.getVersion();
  if (theirs && fs.existsSync(exe) && core.newer(theirs, mine)) {
    try { ensureEntries({ platform, home, env, homedir, shell }); } catch (e) { log(e); }
    const r = relaunchFrom(home); r.args = r.args.filter((a) => a !== FLAG);
    return { relaunch: r };
  }

  const incoming = `${home}.incoming`;
  const old = `${home}.old`;
  try {
    fs.mkdirSync(path.dirname(home), { recursive: true });
    await fs.promises.rm(incoming, { recursive: true, force: true });
    await fs.promises.rm(old, { recursive: true, force: true });
    // Electron's own fs treats app.asar as a folder; the copy has to see a file.
    process.noAsar = true;
    try { await fs.promises.cp(here, incoming, { recursive: true, verbatimSymlinks: true, force: true }); } finally { process.noAsar = false; }
    if (fs.existsSync(home)) fs.renameSync(home, old);
    try { fs.renameSync(incoming, home); } catch (e) { if (fs.existsSync(old)) fs.renameSync(old, home); throw e; }
    fs.rmSync(old, { recursive: true, force: true });
  } catch (e) {
    log(e);
    try { fs.rmSync(incoming, { recursive: true, force: true }); } catch {}
    return {}; // stay where we are; this is tried again next launch
  }
  try { ensureEntries({ platform, home, env, homedir, shell }); } catch (e) { log(e); }
  return { relaunch: relaunchFrom(home) };
}

const settledMessage = (platform = process.platform, argv = process.argv) => (argv.includes(FLAG) ? (MOVED[platform] || '') : '');

module.exports = { settle, settledMessage, ensureEntries, linuxLauncher, desktopEntry, MOVED, FLAG };
