// Test worlds. From 0.7 a fresh profile is a stranger's: one plain folder, no starting setup, no AI
// door. A test about the owner's own setup says so by starting with asOwner(h), which turns the
// fresh profile into what an upgraded 0.6.18 install looks like after the freeze: his two folders
// (Personal and School, sign-ins shared), the school's starting setup, and every value 0.6.18 took
// from its code - four Spaces, the school's number keys, the four apps kept in the strip, every
// kit on, WhatsApp silent and quiet, bills in rupees, the AI port listening.
// h is the harness object main.js hands to every test.

function asOwner(h) {
  const legacy = h.legacyFolders();
  const labels = (h.store.data.settings && h.store.data.settings.identityLabels) || {};
  h.store.data.folders = ['personal', 'school'].map((id) => ({ id, ...legacy[id], email: String(labels[id] || ''), lock: null, agents: true }));
  h.freezeLegacy(h.store.data, {}, { overwrite: true });
  const sp = h.spaces();
  for (const t of h.tabs) if (!sp.includes(t.space)) t.space = sp[0];
  h.setSetting('sharedPairs', [['personal', 'school']]); // wires the sharing and pushes state
  h.seedEveryday();
  const shield = h.shield && h.shield();
  if (shield) shield.setPresetHosts(h.presets.field('adblockHosts', []));
  h.buildMenu();
  h.setFolder('school');
  h.layout(); h.persist(); h.store.save();
  return h;
}

// The fresh profile as it comes: nothing to do, said out loud so a test's world is never implied.
function asStranger(h) {
  if (h.store.data.settings.preset) h.removePreset();
  return h;
}

module.exports = { asOwner, asStranger };
