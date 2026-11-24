// A homepage may redirect to www or to Drive's account-specific home.
// Keep content, meaningful query strings, other accounts and origins distinct.
function homepageKey(address) {
  let u;
  try { u = new URL(address); } catch { return ''; }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash) return '';
  const host = u.hostname.replace(/^www\./, '');
  let account = '';
  if (host === 'drive.google.com') {
    const match = /^\/drive(?:\/u\/(\d+))?(?:\/home)?\/?$/.exec(u.pathname);
    if (u.pathname !== '/' && !match) return '';
    account = match?.[1] || '0';
  } else if (u.pathname !== '/') return '';
  if ((host === 'drive.google.com' || host === 'youtube.com') && u.searchParams.has('authuser')) {
    if (u.searchParams.getAll('authuser').length !== 1) return '';
    const hint = u.searchParams.get('authuser');
    if (/\/u\/\d+/.test(u.pathname) && hint !== account) return '';
    account = hint;
    u.searchParams.delete('authuser');
  }
  if ([...u.searchParams.keys()].some(k => !/^utm_(source|medium|campaign|term|content)$/.test(k))) return '';
  return JSON.stringify([u.protocol, host, u.port, account]);
}
module.exports = { homepageKey };
