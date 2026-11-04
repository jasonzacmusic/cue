// Things about video that the main window and the Vanish window share.

// The biggest video on the page goes into its own small floating window. Pressed again, it comes back.
const PICTURE_IN_PICTURE = `(async () => {
  if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return true; }
  const v = [...document.querySelectorAll('video')].filter((x) => x.videoWidth).sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight))[0];
  if (!v) return false;
  v.disablePictureInPicture = false;
  await v.requestPictureInPicture();
  return true;
})().catch(() => false)`;

// These play protected video. Cue has no player for that yet, so their shows won't start.
// Plain video sites, YouTube included, are not on this list.
const PROTECTED = [
  [/(^|\.)netflix\.com$/, 'Netflix'], [/(^|\.)primevideo\.com$/, 'Prime Video'], [/(^|\.)hotstar\.com$/, 'JioHotstar'], [/(^|\.)disneyplus\.com$/, 'Disney+'],
  [/(^|\.)hulu\.com$/, 'Hulu'], [/(^|\.)max\.com$/, 'Max'], [/(^|\.)sonyliv\.com$/, 'SonyLIV'], [/(^|\.)zee5\.com$/, 'ZEE5'], [/^tv\.apple\.com$/, 'Apple TV'], [/^open\.spotify\.com$/, 'Spotify'],
];
function protectedSite(url) {
  let u; try { u = new URL(url); } catch { return ''; }
  if (/(^|\.)amazon\.[a-z.]+$/.test(u.hostname) && /^\/(gp\/video|Amazon-Video)/i.test(u.pathname)) return 'Prime Video';
  const hit = PROTECTED.find(([re]) => re.test(u.hostname));
  return hit ? hit[1] : '';
}


// Mini mode. In a 480-wide window the page itself is useless, so the video it
// is playing takes the whole window and everything else gets out of the way.
// Undone the moment the tab comes back into Cue.
const MINI_FILL = `(() => {
  const v = [...document.querySelectorAll('video')].filter((x) => x.videoWidth).sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight))[0];
  if (!v) return false;
  document.querySelectorAll('style[data-cue-mini]').forEach((n) => n.remove());
  const s = document.createElement('style');
  s.setAttribute('data-cue-mini', '');
  s.textContent = 'html,body{overflow:hidden!important;background:#000!important}video[data-cue-mini]{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;margin:0!important;object-fit:contain!important;background:#000!important;z-index:2147483647!important;transform:none!important;clip-path:none!important}';
  document.documentElement.append(s);
  v.setAttribute('data-cue-mini', '');
  return true;
})()`;

const MINI_UNFILL = `(() => {
  document.querySelectorAll('style[data-cue-mini]').forEach((n) => n.remove());
  document.querySelectorAll('video[data-cue-mini]').forEach((v) => v.removeAttribute('data-cue-mini'));
  return true;
})()`;

module.exports = { PICTURE_IN_PICTURE, MINI_FILL, MINI_UNFILL, protectedSite };
