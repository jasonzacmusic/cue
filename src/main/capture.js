// Capture tools: whole-page pictures, short GIFs and saving tab recordings.
const fs = require('fs');
const path = require('path');
const { app, shell } = require('electron');

function capturesDir() {
  const d = path.join(app.getPath('downloads'), 'Cue Captures');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function nameFor(title, ext) {
  const safe = String(title || 'Cue').replace(/[^\w\- ]+/g, '').trim().slice(0, 50) || 'Cue';
  // Local time, not UTC: a take made at 4:21 pm in Bangalore was being filed as
  // 10:51, which makes the day's captures impossible to tell apart.
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const when = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
  return path.join(capturesDir(), `${safe} ${when}.${ext}`);
}

// Chromium draws the whole page in one go, however long it is (up to its 16,000 px picture limit).
async function fullPage(wc, title) {
  const dbg = wc.debugger; const mine = !dbg.isAttached();
  if (mine) dbg.attach('1.3');
  try {
    const m = await dbg.sendCommand('Page.getLayoutMetrics');
    const size = m.cssContentSize || m.contentSize;
    const width = Math.ceil(size.width); const height = Math.min(Math.ceil(size.height), 16000);
    const r = await dbg.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
    const file = nameFor(title, 'png');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return { file, width, height };
  } finally { if (mine) { try { dbg.detach(); } catch {} } }
}

async function gif(wc, title, { seconds = 6, fps = 10, width = 480, onDone } = {}) {
  const { GIFEncoder, quantize, applyPalette } = require('gifenc');
  const frames = []; const gap = 1000 / fps; const end = Date.now() + seconds * 1000;
  let w = 0; let h = 0;
  while (Date.now() < end) {
    const t0 = Date.now();
    const img = await wc.capturePage();
    if (!img.isEmpty()) {
      const small = img.resize({ width });
      const s = small.getSize(); w = s.width; h = s.height;
      const bgra = small.toBitmap(); const rgba = new Uint8Array(bgra.length);
      for (let i = 0; i < bgra.length; i += 4) { rgba[i] = bgra[i + 2]; rgba[i + 1] = bgra[i + 1]; rgba[i + 2] = bgra[i]; rgba[i + 3] = 255; }
      frames.push(rgba);
    }
    await new Promise((r) => setTimeout(r, Math.max(0, gap - (Date.now() - t0))));
  }
  if (!frames.length) throw new Error('no frames');
  const enc = GIFEncoder();
  for (const f of frames) {
    const pal = quantize(f, 256);
    enc.writeFrame(applyPalette(f, pal), w, h, { palette: pal, delay: gap });
  }
  enc.finish();
  const file = nameFor(title, 'gif');
  fs.writeFileSync(file, Buffer.from(enc.bytes()));
  if (onDone) onDone(file);
  return { file, frames: frames.length };
}

function saveRecording(title, buffer, ext) {
  const file = nameFor(title, ext);
  fs.writeFileSync(file, Buffer.from(buffer));
  return file;
}

const reveal = (file) => { if (!process.env.CUE_TEST) shell.showItemInFolder(file); };

module.exports = { fullPage, gif, saveRecording, reveal, nameFor };
