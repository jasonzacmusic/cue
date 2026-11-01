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

module.exports = { PICTURE_IN_PICTURE, protectedSite };
