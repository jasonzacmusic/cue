// Which files may an agent put on a page, on every system? Run it with: node test/attach-paths.js
// No Electron needed. The Windows and Linux rules are checked on any computer by handing
// src/main/attach.js the other system's name, home folder and settings; nothing on disk is read.
// test/attach.js (Electron) covers the real files, the links and the refusals on this Mac.
const path = require('path');
const os = require('os');
const fs = require('fs');
const { vetFiles, pathRefusal } = require('../src/main/attach');

let pass = 0, fail = 0;
const check = (name, ok, info) => {
  if (ok) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${info === undefined ? '' : ` -> ${JSON.stringify(info)}`}`); }
};
const allowed = (p, opts) => pathRefusal(p, opts) === '';

// ---- Windows
const win = {
  platform: 'win32',
  home: 'C:\\Users\\asha',
  env: { APPDATA: 'C:\\Users\\asha\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\asha\\AppData\\Local', TEMP: 'C:\\Users\\asha\\AppData\\Local\\Temp' },
};
check('Windows: AppData\\Roaming is refused', /own settings/.test(pathRefusal('C:\\Users\\asha\\AppData\\Roaming\\Cue\\agent-port.json', win)));
check('Windows: AppData\\Local is refused', /own settings/.test(pathRefusal('C:\\Users\\asha\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cookies', win)));
check('Windows: the APPDATA setting is refused even outside the home folder',
  /own settings/.test(pathRefusal('E:\\Roaming\\x.txt', { ...win, env: { ...win.env, APPDATA: 'E:\\Roaming' } })));
check('Windows: the temp folder (inside AppData\\Local) stays allowed', allowed('C:\\Users\\asha\\AppData\\Local\\Temp\\invoice.pdf', win));
check('Windows: D:\\Projects\\song.wav is allowed', allowed('D:\\Projects\\song.wav', win));
check('Windows: z:\\clip.mp4 (lower-case drive) is allowed', allowed('z:\\clip.mp4', win));
check('Windows: the home folder is allowed', allowed('C:\\Users\\asha\\Documents\\Invoice.pdf', win));
check('Windows: C:\\Windows\\System32\\cmd.exe is refused', /part of Windows/.test(pathRefusal('C:\\Windows\\System32\\cmd.exe', win)));
check('Windows: C:\\Program Files is refused', /part of Windows/.test(pathRefusal('C:\\Program Files\\App\\app.exe', win)));
check('Windows: C:\\Program Files (x86) is refused', /part of Windows/.test(pathRefusal('C:\\Program Files (x86)\\App\\a.dll', win)));
check('Windows: C:\\ProgramData is refused', /part of Windows/.test(pathRefusal('C:\\ProgramData\\x.txt', win)));
check('Windows: another person\'s folder is refused', /outside/.test(pathRefusal('C:\\Users\\ravi\\Documents\\x.pdf', win)));
check('Windows: the bare C: drive is refused', /outside/.test(pathRefusal('C:\\notes.txt', win)));
check('Windows: ~\\.ssh is refused', /private keys/.test(pathRefusal('C:\\Users\\asha\\.ssh\\id_ed25519', win)));
check('Windows: a drive root alone is not a file', /outside/.test(pathRefusal('D:\\', win)));

// ---- Linux
const lin = { platform: 'linux', home: '/home/asha', env: {} };
check('Linux: ~/snap/chromium/x is refused', /own settings/.test(pathRefusal('/home/asha/snap/chromium/x', lin)));
check('Linux: ~/.config is refused', /own settings/.test(pathRefusal('/home/asha/.config/Cue/agent-port.json', lin)));
check('Linux: ~/.local is refused', /own settings/.test(pathRefusal('/home/asha/.local/share/keyrings/login.keyring', lin)));
check('Linux: /run/media/u/usb/clip.mp4 is allowed', allowed('/run/media/u/usb/clip.mp4', lin));
check('Linux: /run/media/<user>/ with no drive is refused', !allowed('/run/media/u', lin));
check('Linux: /media/usb/clip.mp4 is allowed', allowed('/media/usb/clip.mp4', lin));
check('Linux: /etc/passwd is refused', /outside/.test(pathRefusal('/etc/passwd', lin)));
check('Linux: home and /tmp are allowed', allowed('/home/asha/Music/a.wav', lin) && allowed('/tmp/a.pdf', lin));

// ---- this Mac's rules, unchanged
const mac = { platform: 'darwin', home: '/Users/asha', env: {} };
check('Mac: ~/Library is refused', /own settings/.test(pathRefusal('/Users/asha/Library/Preferences/x.plist', mac)));
check('Mac: ~/.ssh is refused', /private keys/.test(pathRefusal('/Users/asha/.ssh/id_ed25519', mac)));
check('Mac: a keychain is refused', /keychain/.test(pathRefusal('/tmp/login.keychain-db', mac)));
check('Mac: /Volumes/SSD/clip.mov is allowed', allowed('/Volumes/SSD/clip.mov', mac));
check('Mac: /etc/hosts is refused', /outside/.test(pathRefusal('/etc/hosts', mac)));
check('Mac: /run/media is not a Mac drive', !allowed('/run/media/u/usb/clip.mp4', mac));
check('Mac: D:\\ means nothing on a Mac', !allowed('D:\\Projects\\song.wav', mac));
check('Cue\'s own data folder is refused, its Downloads exemption is not',
  /Cue's own data/.test(pathRefusal('/Users/asha/Cue/agent-port.json', { ...mac, protectedDirs: ['/Users/asha/Cue'], exempt: ['/Users/asha/Cue/Downloads'] }))
  && allowed('/Users/asha/Cue/Downloads/a.pdf', { ...mac, protectedDirs: ['/Users/asha/Cue'], exempt: ['/Users/asha/Cue/Downloads'] }));

// ---- vetFiles itself, with a real file on this computer (control: the rules let real files through)
const dir = fs.mkdtempSync(path.join('/tmp', 'cue-attach-paths-'));
try {
  const f = path.join(dir, 'Invoice.pdf');
  fs.writeFileSync(f, '%PDF-1.4\n');
  const got = vetFiles([f]);
  check('control: a real file in /tmp passes vetFiles', got.length === 1 && got[0].name === 'Invoice.pdf' && got[0].type === 'application/pdf', got);
  let msg = '';
  try { vetFiles(['/etc/hosts']); } catch (e) { msg = e.message; }
  check('vetFiles still refuses /etc/hosts in plain words', /only attaches files from your home folder/.test(msg), msg);
  msg = '';
  try { vetFiles([path.join(os.homedir(), '.config', 'nothing.txt')]); } catch (e) { msg = e.message; }
  check('vetFiles refuses ~/.config by name, before looking on disk', /own settings/.test(msg), msg);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
