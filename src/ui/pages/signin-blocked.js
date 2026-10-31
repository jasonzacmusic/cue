'use strict';
// Shown instead of Google's dead end when Google refuses to sign you in inside Cue. The one button
// asks Cue's main side to carry the Google sign-in over from Chrome; this page never sees a cookie.
(() => {
  const $ = (id) => document.getElementById(id);
  const said = $('said');
  const bring = $('bring');
  if (!window.cueInternal) { bring.hidden = true; $('close').hidden = true; return; }
  $('close').onclick = () => window.cueInternal.invoke('signin.close', {});
  bring.onclick = async () => {
    bring.disabled = true;
    said.className = 'said';
    said.textContent = 'Reading Chrome’s sign-ins… say yes if your Mac asks for the key.';
    try {
      const r = await window.cueInternal.invoke('signin.from-chrome', {});
      if (r && r.error) { said.className = 'said bad'; said.textContent = r.error; bring.disabled = false; return; }
      if (!r || !r.count) {
        said.className = 'said bad';
        said.textContent = 'Chrome had no Google sign-in to bring over. Sign in to Google in Chrome first, then try this again.';
        bring.disabled = false;
        return;
      }
      said.textContent = `Brought over from ${r.from}. Opening Gmail…`;
    } catch {
      said.className = 'said bad';
      said.textContent = 'Cue could not read Chrome just now. Try again in a moment.';
      bring.disabled = false;
    }
  };
})();
