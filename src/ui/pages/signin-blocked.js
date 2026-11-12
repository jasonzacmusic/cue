'use strict';
// Shown when Google stops a sign-in in this folder a second time within ten minutes (Cue has
// already cleared the folder's Google state and retried once on its own). Both buttons ask Cue's
// main side to clear THIS folder's Google state and open Google's own form again; this page never
// sees a cookie.
(() => {
  const $ = (id) => document.getElementById(id);
  const said = $('said');
  const buttons = [$('bring'), $('other')];
  if (!window.cueInternal) { buttons.forEach((b) => { b.hidden = true; }); $('close').hidden = true; return; }
  $('close').onclick = () => window.cueInternal.invoke('signin.close', {});
  const go = async (cmd) => {
    buttons.forEach((b) => { b.disabled = true; });
    said.className = 'said';
    said.textContent = 'Clearing this folder’s old Google sign-in…';
    try {
      const r = await window.cueInternal.invoke(cmd, {});
      if (r && r.error) { said.className = 'said bad'; said.textContent = r.error; buttons.forEach((b) => { b.disabled = false; }); return; }
      said.textContent = 'Done. Google’s sign-in is opening.';
    } catch {
      said.className = 'said bad';
      said.textContent = 'That did not work just now. Wait a moment, then try again.';
      buttons.forEach((b) => { b.disabled = false; });
    }
  };
  $('bring').onclick = () => go('signin.from-chrome');
  $('other').onclick = () => go('signin.other-account');
})();
