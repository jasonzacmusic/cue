// Designer tools that run on top of a page: colour pick point, font finder and ruler.
// They draw inside a shadow root with plain DOM calls, so strict sites still allow them.
// Each resolves a promise with its result when the person clicks or presses Esc.

const shell = `
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair';
  const root = host.attachShadow({ mode: 'closed' });
  document.documentElement.append(host);
  const tip = document.createElement('div');
  tip.style.cssText = 'position:fixed;padding:6px 9px;border-radius:6px;background:#14171A;color:#fff;font:12px/1.4 -apple-system,system-ui,sans-serif;pointer-events:none;white-space:pre;box-shadow:0 2px 10px rgba(0,0,0,.4)';
  root.append(tip);
  const finish = (v) => { host.remove(); removeEventListener('keydown', onKey, true); resolve(v); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); } };
  addEventListener('keydown', onKey, true);
  const place = (e) => { tip.style.left = Math.min(e.clientX + 14, innerWidth - 260) + 'px'; tip.style.top = Math.min(e.clientY + 14, innerHeight - 90) + 'px'; };
`;

const PICK_POINT = `new Promise((resolve) => {${shell}
  tip.textContent = 'Click a colour · Esc to cancel';
  host.addEventListener('mousemove', place);
  host.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); finish({ x: e.clientX, y: e.clientY, w: innerWidth, h: innerHeight }); }, true);
})`;

const FONT_FINDER = `new Promise((resolve) => {${shell}
  host.style.background = 'transparent';
  tip.textContent = 'Point at text · click to copy · Esc to stop';
  let last = null;
  host.addEventListener('mousemove', (e) => {
    place(e);
    host.style.pointerEvents = 'none';
    const el = document.elementFromPoint(e.clientX, e.clientY);
    host.style.pointerEvents = '';
    if (!el) return;
    const s = getComputedStyle(el);
    last = s.fontFamily.split(',')[0].replace(/["']/g, '').trim() + ' · ' + s.fontWeight + ' · ' + s.fontSize + ' / ' + s.lineHeight;
    tip.textContent = last + '\\n' + s.color;
  });
  host.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); finish(last); }, true);
})`;

const RULER = `new Promise((resolve) => {${shell}
  tip.textContent = 'Drag to measure · Esc to stop';
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;border:1px solid #FF3D7F;background:rgba(255,61,127,.12);pointer-events:none;display:none';
  root.append(box);
  let a = null;
  host.addEventListener('mousedown', (e) => { e.preventDefault(); a = { x: e.clientX, y: e.clientY }; box.style.display = 'block'; });
  host.addEventListener('mousemove', (e) => {
    place(e);
    if (!a) return;
    const x = Math.min(a.x, e.clientX), y = Math.min(a.y, e.clientY), w = Math.abs(e.clientX - a.x), h = Math.abs(e.clientY - a.y);
    Object.assign(box.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
    tip.textContent = w + ' × ' + h + ' px';
  });
  host.addEventListener('mouseup', () => { a = null; });
})`;

// The image's box on screen, so we can read its colours from a picture of the page.
const rectAt = (x, y) => `(() => {
  const el = document.elementFromPoint(${Number(x)}, ${Number(y)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.max(0, Math.round(r.left)), y: Math.max(0, Math.round(r.top)), width: Math.round(Math.min(r.width, innerWidth)), height: Math.round(Math.min(r.height, innerHeight)) };
})()`;

// Full-size frame from a playing video. Falls back to its box on screen if the site forbids reading it.
const GRAB_FRAME = `(() => {
  const v = [...document.querySelectorAll('video')].sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight))[0];
  if (!v) return null;
  const r = v.getBoundingClientRect();
  const rect = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  try {
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    return { png: c.toDataURL('image/png'), time: v.currentTime, rect };
  } catch { return { rect, time: v.currentTime }; }
})()`;

const VIDEO_TIME = `(() => {
  const v = [...document.querySelectorAll('video')].sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight))[0];
  return v ? v.currentTime : null;
})()`;

const stamp = (s) => { s = Math.floor(s); const h = Math.floor(s / 3600); const m = Math.floor(s / 60) % 60; const x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };

// Six main colours from a picture, by k-means on a small copy.
function palette(image, count = 6) {
  const small = image.resize({ width: 72 });
  const { width, height } = small.getSize();
  const bmp = small.toBitmap();
  const px = [];
  for (let i = 0; i + 3 < width * height * 4; i += 4) { if (bmp[i + 3] > 200) px.push([bmp[i + 2], bmp[i + 1], bmp[i]]); }
  if (!px.length) return [];
  // Start from colours as far apart as possible, so two strong colours can't blur into their mix.
  const dist = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  let centres = [px[0].slice()];
  while (centres.length < count) {
    let far = px[0]; let fd = -1;
    for (const p of px) { const d = Math.min(...centres.map((c) => dist(c, p))); if (d > fd) { fd = d; far = p; } }
    if (fd <= 0) break;
    centres.push(far.slice());
  }
  for (let round = 0; round < 10; round++) {
    const sum = centres.map(() => [0, 0, 0, 0]);
    for (const p of px) {
      let best = 0; let bd = Infinity;
      centres.forEach((c, i) => { const d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2; if (d < bd) { bd = d; best = i; } });
      const s = sum[best]; s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++;
    }
    centres = centres.map((c, i) => (sum[i][3] ? [sum[i][0] / sum[i][3], sum[i][1] / sum[i][3], sum[i][2] / sum[i][3]] : c));
  }
  const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
  return [...new Set(centres.map(hex))];
}

function pixelHex(image, x, y) {
  const { width, height } = image.getSize();
  const px = Math.max(0, Math.min(width - 1, Math.round(x))); const py = Math.max(0, Math.min(height - 1, Math.round(y)));
  const b = image.toBitmap(); const i = (py * width + px) * 4;
  return '#' + [b[i + 2], b[i + 1], b[i]].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

module.exports = { PICK_POINT, FONT_FINDER, RULER, rectAt, GRAB_FRAME, VIDEO_TIME, stamp, palette, pixelHex };
