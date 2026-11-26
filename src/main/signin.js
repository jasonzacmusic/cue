// Decides where a page's "open a new window" goes. A site's "Sign in with..." popup has to stay
// a popup, or the site that opened it never hears back. A plain sign-in link is a normal page.
const AUTH_PAGE = /^https:\/\/(accounts\.google\.com|appleid\.apple\.com|login\.microsoftonline\.com|login\.live\.com|github\.com\/login|www\.facebook\.com\/(v[\d.]+\/)?dialog|[^/]+\.auth0\.com\/|[^/]+\.okta\.com\/|[^/]+\.oktapreview\.com\/|[^/]+\.clerk\.accounts\.dev\/|clerk\.[^/]+\/|[^/]+\.amazoncognito\.com\/|slack\.com\/oauth|discord\.com\/oauth2|twitter\.com\/i\/oauth|x\.com\/i\/oauth|www\.linkedin\.com\/oauth|www\.paypal\.com\/(signin|checkoutnow|connect)|checkout\.stripe\.com\/|id\.atlassian\.com\/|accounts\.spotify\.com\/|id\.twitch\.tv\/|accounts\.shopify\.com\/)/;
const REPORTS_BACK = /[?&](client_id|redirect_uri|response_type|app_id)=|\/oauth|\/dialog\//i;
const GOOGLE_FRONT_PAGE = /^https:\/\/(workspace|www)\.google\.[^/]+\//; // where a signed-out Gmail tab lands

// 'popup' keeps a small sign-in window, 'here' stays in the same tab, 'tab' opens a new tab.
function whereToOpen(url, disposition, from = '') {
  if (disposition === 'new-window') return 'popup';
  if (!AUTH_PAGE.test(url)) return 'tab';
  if (REPORTS_BACK.test(url)) return 'popup';
  return GOOGLE_FRONT_PAGE.test(from) ? 'here' : 'tab';
}

// A page may ask Cue to open a new window, and Cue does the opening with more rights than the page
// has, so local files and Cue's own pages are refused here. Only Cue's own pages may open each other.
const NOT_FOR_PAGES = /^(file|data|cue|chrome|devtools|view-source|javascript|filesystem):/i;
const refuseOpen = (url, from = '') => NOT_FOR_PAGES.test(url) && !/^cue:/i.test(from); // an extension's page included

// Start a new sign-in at the site. OAuth codes and account hints stay in the originating browser.
async function openSiteInChrome(address) {
  const url = new URL(address);
  if (url.protocol !== 'https:') throw new Error('Choose an HTTPS site.');
  const site = url.origin + '/';
  const fs = require('fs');
  const path = require('path');
  const { spawn } = require('child_process');
  let program;
  let args = [site];
  if (process.platform === 'darwin') {
    program = '/usr/bin/open';
    args = ['-b', 'com.google.Chrome', site];
  } else if (process.platform === 'win32') {
    program = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
      .filter(Boolean).map((root) => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')).find((p) => fs.existsSync(p));
  } else {
    program = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/opt/google/chrome/chrome'].find((p) => fs.existsSync(p));
  }
  if (!program) throw new Error('Chrome is unavailable.');
  await new Promise((resolve, reject) => {
    const child = spawn(program, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    if (process.platform === 'darwin') child.once('exit', (status) => status === 0 ? resolve() : reject(new Error('Chrome could not open.')));
    else child.once('spawn', () => { child.unref(); resolve(); });
  });
}

module.exports = { openSiteInChrome, refuseOpen, whereToOpen };
