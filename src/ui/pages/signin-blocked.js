'use strict';
// Shown instead of Google's dead end when Google refuses to sign you in inside Cue. The one button
// asks Cue's main side to empty this folder's Google cookies and reopen Google's own sign-in; this
// page never sees a cookie itself.
(() => {
  const $ = (id) => document.getElementById(id);
  const said = $('said');
  const bring = $('bring');
  if (!window.cueInternal) { bring.hidden = true; $('close').hidden = true; return; }
  $('close').onclick = () => window.cueInternal.invoke('signin.close', {});
  bring.onclick = async () => {
    bring.disabled = true;
    said.className = 'said';
    said.textContent = 'Clearing this folder\u2019s old Google cookies\u2026';
    try {
      const r = await window.cueInternal.invoke('signin.from-chrome', {});
      if (r && r.error) { said.className = 'said bad'; said.textContent = r.error; bring.disabled = false; return; }
      said.textContent = 'Cleared. Google\u2019s sign-in is opening \u2014 enter this folder\u2019s password there.';
    } catch {
      said.className = 'said bad';
      said.textContent = 'Cue could not do that just now. Try again in a moment.';
      bring.disabled = false;
    }
  };
})();
