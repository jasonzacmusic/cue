// Every Vanish shortcut, in one table. The Vanish window's key handler, the Window > Vanish
// menu and the list in Settings all read this, so the three can never say different things.
//
// "Mod" is Command on a Mac and Ctrl on Windows and Linux; "Ctrl" is Ctrl everywhere. The first
// key in a row is the one shown; the rest are aliases that keep older keys working.
//
// Picked against the main menu (main.js buildMenu). Cmd+Shift+P is Pop Out Tab, Cmd+Shift+M the
// Music Bar and Cmd+Shift+F Grab Video Frame there, so Vanish uses the nearest free ones:
// play/pause Cmd+Shift+K (K is YouTube's own play key), mute Cmd+Shift+A, full screen Cmd+Alt+F.
// Cmd+Alt+Left/Right already moved a Vanish tab, so next/previous tab stay on Ctrl+Tab and
// Cmd+Shift+] / Cmd+Shift+[.
const VANISH_KEYS = [
  { id: 'open', label: 'Open Vanish, or a new Vanish tab', keys: ['Mod+Shift+N', 'Mod+Alt+N'] },
  { id: 'new', label: 'New tab', keys: ['Mod+T', 'Mod+N'] },
  { id: 'close', label: 'Close tab', keys: ['Mod+W'] },
  { id: 'next', label: 'Next tab', keys: ['Ctrl+Tab', 'Mod+Shift+]'] },
  { id: 'prev', label: 'Previous tab', keys: ['Ctrl+Shift+Tab', 'Mod+Shift+['] },
  { id: 'goto', label: 'Go to a tab (9 is the last)', keys: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `Mod+${n}`), show: 'Mod+1-9' },
  { id: 'play', label: 'Play or pause', keys: ['Mod+Shift+K'] },
  { id: 'mute', label: 'Mute or unmute this tab', keys: ['Mod+Shift+A'] },
  { id: 'find', label: 'Find on this page', keys: ['Mod+F'] },
  { id: 'full', label: 'Full screen on or off', keys: ['Mod+Alt+F'] },
  { id: 'leave', label: 'Leave full screen', keys: ['Escape'] },
  { id: 'forget', label: 'Close Vanish and forget everything', keys: ['Mod+Shift+W'] },
  { id: 'address', label: 'Type an address', keys: ['Mod+L'] },
  { id: 'reload', label: 'Reload', keys: ['Mod+R'] },
  { id: 'back', label: 'Back', keys: ['Mod+['] },
  { id: 'forward', label: 'Forward', keys: ['Mod+]'] },
  { id: 'moveLeft', label: 'Move tab left', keys: ['Mod+Alt+Left'] },
  { id: 'moveRight', label: 'Move tab right', keys: ['Mod+Alt+Right'] },
  { id: 'zoomIn', label: 'Zoom in', keys: ['Mod+=', 'Mod+Shift+='] },
  { id: 'zoomOut', label: 'Zoom out', keys: ['Mod+-', 'Mod+Shift+-'] },
  { id: 'zoomReset', label: 'Actual size', keys: ['Mod+0'] },
  { id: 'pip', label: 'Picture in Picture', keys: ['Mod+Alt+P'] },
];

const NAMES = { left: 'arrowleft', right: 'arrowright', up: 'arrowup', down: 'arrowdown', esc: 'escape' };
const SHIFTED = { '{': '[', '}': ']', '+': '=', '_': '-', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0' };
const CODES = { BracketLeft: '[', BracketRight: ']', Equal: '=', Minus: '-', Tab: 'tab', Escape: 'escape' };

function parse(spec) {
  const parts = spec.split('+');
  const key = parts.pop().toLowerCase();
  return { mod: parts.includes('Mod') || parts.includes('Ctrl'), shift: parts.includes('Shift'), alt: parts.includes('Alt'), key: NAMES[key] || key };
}
const PARSED = VANISH_KEYS.flatMap((row) => row.keys.map((spec) => ({ row, spec, ...parse(spec) })));

// The key an input event means, whatever Shift or Option did to the character. Option+F on a Mac
// arrives as "ƒ" and Shift+] as "}", so the physical key is used when one of those is held.
function keyOf(input) {
  const code = String(input.code || '');
  let fromCode = '';
  if (/^Key[A-Z]$/.test(code)) fromCode = code.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(code)) fromCode = code.slice(5);
  else if (/^Arrow/.test(code)) fromCode = code.toLowerCase();
  else if (CODES[code]) fromCode = CODES[code];
  const k = String(input.key || '').toLowerCase();
  if (fromCode && (input.alt || input.shift || !k)) return fromCode;
  return SHIFTED[k] || k;
}

// Ctrl and Command both count as the modifier, as they always have in Vanish (Ctrl+T works on a Mac).
function match(input) {
  if (!input || input.type !== 'keyDown') return null;
  const mod = !!(input.meta || input.control); const shift = !!input.shift; const alt = !!input.alt;
  const key = keyOf(input);
  const hit = PARSED.find((p) => p.key === key && p.mod === mod && p.shift === shift && p.alt === alt);
  return hit ? { id: hit.row.id, spec: hit.spec, n: hit.row.id === 'goto' ? Number(hit.key) : undefined } : null;
}

// How a key is written for people: the Mac's symbols there, words everywhere else.
function display(spec, mac = process.platform === 'darwin') {
  const parts = spec.split('+'); const key = parts.pop();
  const word = { Left: mac ? '←' : 'Left', Right: mac ? '→' : 'Right', Escape: 'Esc', Tab: 'Tab' }[key] || key.toUpperCase();
  const sym = mac ? { Mod: '⌘', Ctrl: '⌃', Shift: '⇧', Alt: '⌥' } : { Mod: 'Ctrl', Ctrl: 'Ctrl', Shift: 'Shift', Alt: 'Alt' };
  const order = ['Ctrl', 'Alt', 'Shift', 'Mod'];
  const mods = mac ? order.filter((m) => parts.includes(m)) : ['Mod', 'Ctrl', 'Alt', 'Shift'].filter((m) => parts.includes(m));
  const names = [...new Set(mods.map((m) => sym[m]))];
  return mac ? names.join('') + word : [...names, word].join('+');
}

// The list Settings and the menu show: one line per job, the first key only.
function shown(mac) { return VANISH_KEYS.map((r) => ({ id: r.id, label: r.label, keys: display(r.show || r.keys[0], mac) })); }

module.exports = { VANISH_KEYS, match, display, shown };
