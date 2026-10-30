// Decides where a page's "open a new window" goes. A site's "Sign in with..." popup has to stay
// a popup, or the site that opened it never hears back. A plain sign-in link is a normal page.
const AUTH_PAGE = /^https:\/\/(accounts\.google\.com|appleid\.apple\.com|login\.microsoftonline\.com|github\.com\/login|www\.facebook\.com\/(v[\d.]+\/)?dialog)/;
const REPORTS_BACK = /[?&](client_id|redirect_uri|response_type|app_id)=|\/oauth|\/dialog\//i;
const GOOGLE_FRONT_PAGE = /^https:\/\/(workspace|www)\.google\.[^/]+\//; // where a signed-out Gmail tab lands

// 'popup' keeps a small sign-in window, 'here' stays in the same tab, 'tab' opens a new tab.
function whereToOpen(url, disposition, from = '') {
  if (disposition === 'new-window') return 'popup';
  if (!AUTH_PAGE.test(url)) return 'tab';
  if (REPORTS_BACK.test(url)) return 'popup';
  return GOOGLE_FRONT_PAGE.test(from) ? 'here' : 'tab';
}

module.exports = { whereToOpen };
