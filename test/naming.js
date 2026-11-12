// Naming test: CUE_TEST=naming CUE_USER_DATA=<tmp> electron .
//
// Proves two things Jason asked for on 2-Nov-2026: that a tab is called something a person would
// call it, with the right logo, and that Cmd+1..9 go where he said they should and stay his to
// change.
//
// The names are checked against his OWN history, not invented examples: these titles are the ones
// sitting in cue-library.db for the sites he actually uses.
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`[cue-naming] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`); };

// url, page title as his history recorded it, what the sidebar should say
const REAL = [
  ['https://web.whatsapp.com/', '(1) WhatsApp Business', 'WhatsApp'],
  ['https://mail.google.com/mail/u/0/', 'Inbox (1) - music@nathanielschool.com - Nathaniel School of Music Mail', 'Gmail'],
  ['https://www.facebook.com/', '(20+) Facebook', 'Facebook'],
  ['https://www.instagram.com/', '(1) Instagram', 'Instagram'],
  ['https://studio.youtube.com/channel/x', 'Channel content - YouTube Studio', 'YouTube Studio'],
  ['https://www.linkedin.com/feed/', 'Jason Zac | LinkedIn', 'LinkedIn'],
  ['https://pitara.nathanielschool.com', 'Pitara: piano, tuner, metronome, tanpura and music theory on one desk | Nathaniel School of Music', 'Pitara'],
  ['https://sightsinging.nathanielschool.com', 'Sight Singing Practice Online | Nathaniel School of Music', 'Prima Vista'],
  ['https://lipi.nathanielschool.com', 'Lipi', 'Lipi'],
  ['https://learning-portal.nathanielschool.com', 'Learning Portal', 'Learning Portal'],
  ['https://github.com/jasonzacmusic', 'jasonzacmusic (Jason Zac) · GitHub', 'GitHub'],
];

module.exports = async (h) => {
  const { app, openTab, setSetting, store, siteName, siteLogo } = h;
  require('./world').asOwner(h); // the school's app names and logos come from its starting setup
  try {
    // siteName and siteLogo are the very functions the sidebar's state is built from, so these
    // checks run against the shipped code rather than a copy of its rules.
    for (const [url, title, want] of REAL) {
      const t = { url, title, name: null, identity: 'school' };
      const got = siteName(t);
      check(`a ${want} tab is called \u201c${want}\u201d`, got === want, { title, got });
    }

    // A name he typed himself is never overruled.
    check('his own name for a tab still wins', siteName({ url: 'https://web.whatsapp.com/', title: '(1) WhatsApp Business', name: 'Mum' }) === 'Mum');

    // Logos, for the sites whose own favicon never arrives.
    check('an NSM app with no favicon still gets a logo', !!siteLogo({ url: 'https://pitara.nathanielschool.com', identity: 'school' }), siteLogo({ url: 'https://pitara.nathanielschool.com', identity: 'school' }));
    check('the Learning Portal gets its own, not the generic NSM one', siteLogo({ url: 'https://learning-portal.nathanielschool.com', identity: 'school' }) === 'learning-portal.png');
    check('GitHub carries its own mark', siteLogo({ url: 'https://github.com/jasonzacmusic', identity: 'school' }) === 'github.svg');
    check('a Vanish tab is given no logo of ours', siteLogo({ url: 'https://www.instagram.com/', identity: 'vanish' }) === null);

    // The number keys: his list, in his order.
    const want = ['WhatsApp', 'Email', 'Instagram', 'Codex', 'Pitara', 'Prima Vista', 'Lipi', 'Learning Portal', 'New tab'];
    const keys = store.data.settings.quickKeys;
    check('there are nine number keys', Array.isArray(keys) && keys.length === 9, keys && keys.length);
    check('they are the nine he asked for, in order', JSON.stringify((keys || []).map((k) => k.name)) === JSON.stringify(want), (keys || []).map((k) => k.name));
    check('the ninth one opens a new tab, not a site', !!(keys && keys[8] && !keys[8].url), keys && keys[8]);

    // And they are programmable, which was the point of the word he used.
    setSetting('quick.5.url', 'https://chord-trees.nathanielschool.com');
    setSetting('quick.5.name', 'Chord Trees');
    const after = h.quickKeys()[4]; // the folder that is open (the nine are per folder)
    check('a number key can be re-pointed', after.name === 'Chord Trees' && /chord-trees/.test(after.url), after);
    check('re-pointing one leaves the others alone', h.quickKeys()[0].name === 'WhatsApp', h.quickKeys()[0]);

    check('control: a failing check is visible (expected FAIL below)', false, 'this one is meant to fail');
  } catch (e) {
    check('the test itself ran', false, e.message);
  }
  const pass = results.filter((r) => r.ok).length;
  console.log(`[cue-naming] DONE ${pass}/${results.length} passed (1 deliberate failure expected)`);
  setTimeout(() => app.quit(), 300);
};
