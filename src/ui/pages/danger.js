'use strict';
// The page Cue shows instead of a site that is on today's list of sites handing
// out malware or phishing for passwords. Every string from the address is
// written with textContent, never innerHTML.
(() => {
  const $ = (id) => document.getElementById(id);
  const q = new URLSearchParams(location.search);
  const kind = q.get('kind') === 'malware' ? 'malware' : 'phishing';
  const site = q.get('site') || '';
  let host = site;
  try { host = new URL(site).hostname.replace(/^www\./, ''); } catch {}

  const WORDS = {
    phishing: {
      head: 'This page is pretending to be someone else',
      why: `${host} was reported today for copying a real sign-in page — a bank, an email service, a shop — to collect the password you type into it. The page may look exactly right.`,
      advice: 'If you were going to sign in here, close this and reach that site the way you normally do, by typing its name yourself.',
    },
    malware: {
      head: 'This page hands out viruses',
      why: `${host} was reported today for serving files that install themselves on the machine that downloads them. Cue stopped the page before it loaded.`,
      advice: 'If you came here for a download, get it from the maker\'s own site instead. If something already downloaded, delete it without opening it.',
    },
  };

  const w = WORDS[kind];
  $('head').textContent = w.head;
  $('why').textContent = w.why;
  $('advice').textContent = w.advice;
  $('site').textContent = site;
  document.title = `${host || 'This site'} — stopped by Cue`;
  $('when').textContent = 'On a list checked every few days. ';

  const back = $('back');
  if (history.length > 1) back.onclick = () => history.back();
  else back.hidden = true;
  $('home').onclick = () => window.cueInternal && window.cueInternal.invoke('shield.close', {});
  $('anyway').onclick = () => window.cueInternal && window.cueInternal.invoke('shield.proceed', { site });
  if (!window.cueInternal) { $('anyway').hidden = true; $('home').hidden = true; }
})();
