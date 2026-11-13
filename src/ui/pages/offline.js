'use strict';
// The page Cue shows when a site could not be loaded. Its address carries ?code=, ?why= and
// ?site=: Chromium's error number, its error name, and the address that failed. Every string
// from the address is written with textContent, never innerHTML.
(() => {
  const $ = (id) => document.getElementById(id);
  const q = new URLSearchParams(location.search);
  const code = Number(q.get('code')) || 0;
  const why = String(q.get('why') || '').toUpperCase();
  const site = q.get('site') || '';
  const web = /^https?:\/\//i.test(site);
  let host = '';
  try { host = web ? new URL(site).hostname.replace(/^www\./, '') : ''; } catch {}
  const name = host || 'this site';

  // Chromium's certificate errors are -200 to -299. Cue never lets a page past one.
  const cert = (code <= -200 && code >= -299) || /CERT|SSL/.test(why);

  // Everything else, in a few plain reasons. The number first, then the name, if the number is missing.
  const has = (codes, words) => codes.includes(code) || words.test(why);
  const reason =
    has([-106, -21], /INTERNET_DISCONNECTED|NETWORK_CHANGED/) ? ['This computer is not connected to the internet.', 'Check the Wi-Fi or the cable, then try again.']
      : has([-105, -137, -800], /NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED/) ? [`The address ${name} could not be found.`, 'Check the spelling. If it is right, the site may have moved or closed, or the internet here may be having trouble.']
        : has([-102, -104], /CONNECTION_REFUSED|CONNECTION_FAILED/) ? [`${name} refused the connection.`, 'The site may be down for a while. Try again in a few minutes.']
          : has([-7, -118], /TIMED_OUT/) ? [`${name} took too long to answer.`, 'The site may be busy, or the internet here may be slow. Try again in a moment.']
            : has([-100, -101, -324], /CONNECTION_CLOSED|CONNECTION_RESET|EMPTY_RESPONSE/) ? [`${name} stopped answering part-way.`, 'Try again. If it keeps happening, the site may be having trouble.']
              : has([-109, -130], /ADDRESS_UNREACHABLE|PROXY/) ? [`Cue could not find a way through to ${name}.`, 'The network here may be blocking it. Try again, or try another network.']
                : [`Something stopped ${name} on its way here.`, 'Try again in a moment.'];

  if (cert) {
    $('wrap').classList.add('cert');
    $('ic-net').hidden = true; $('ic-cert').hidden = false;
    $('head').textContent = `Cue refused an unsafe connection to ${name}`;
    $('why').textContent = `The connection to ${name} could not be proved safe, so Cue did not open it. Someone could be reading or changing what passes between this computer and the site.`;
    $('advice').textContent = 'There is no way past this in Cue, on purpose. If it is a site you know, try again later or from another network; the site itself may need fixing.';
    document.title = `${host || 'This site'}: unsafe connection refused`;
  } else {
    $('head').textContent = `Cue couldn't reach ${name}`;
    $('why').textContent = reason[0];
    $('advice').textContent = reason[1];
    document.title = `${host || 'This site'}: couldn't reach it`;
    // Only an ordinary web address is ever opened from here.
    if (web) { $('again').hidden = false; $('again').onclick = () => { location.href = site; }; }
  }
  $('site').textContent = site;
  if (history.length > 1) { $('back').hidden = false; $('back').onclick = () => history.back(); }
})();
