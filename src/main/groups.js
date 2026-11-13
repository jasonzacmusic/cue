// Which sidebar group a tab belongs to, decided by its address.
// Order matters: the first matching rule wins, so Gemini lands in AI before Google.
// A starting setup (presets.js) may add its own groups in front, and hosts to these.
const presets = require('./presets');

const GROUPS = [
  {
    id: 'ai', name: 'AI & Subscriptions',
    hosts: [
      'claude.ai', 'anthropic.com', 'chatgpt.com', 'openai.com', 'gemini.google.com',
      'aistudio.google.com', 'notebooklm.google.com', 'perplexity.ai', 'grok.com', 'x.ai',
      'elevenlabs.io', 'replicate.com', 'midjourney.com', 'cursor.com', 'suno.com',
      'vercel.com', 'neon.tech', 'bunny.net', 'brevo.com', 'render.com', 'name.com',
      'paddle.com', 'stripe.com', 'vidiq.com', 'wisprflow.ai', 'canva.com',
    ],
    paths: [['github.com', '/settings/billing'], ['console.cloud.google.com', '/billing']],
  },
  {
    id: 'google', name: 'Google',
    hosts: ['google.com', 'youtube.com', 'youtu.be', 'gmail.com', 'googleusercontent.com', 'withgoogle.com'],
  },
  {
    id: 'social', name: 'Social',
    hosts: ['instagram.com', 'facebook.com', 'threads.net', 'threads.com', 'linkedin.com', 'x.com', 'twitter.com', 'pinterest.com', 'whatsapp.com', 'patreon.com'],
  },
  { id: 'code', name: 'Code', hosts: ['github.com', 'gitlab.com', 'npmjs.com', 'stackoverflow.com'] },
  {
    // Shops and the parcels they send. A cart and its tracking page belong
    // together: both are "the thing I ordered", and neither is Social.
    id: 'shop', name: 'Shopping',
    hosts: [
      'amazon.in', 'amazon.com', 'flipkart.com', 'robu.in', 'robocraze.com', 'silverlineelectronics.in',
      'element14.com', 'mouser.in', 'thingbits.in', 'zepto.com', 'zeptonow.com', 'swiggy.com', 'zomato.com',
      'blinkit.com', 'bigbasket.com', 'myntra.com', 'ajio.com', 'croma.com', 'reliancedigital.in',
      'store.apple.com', 'bambulab.com', 'makerbazar.in', 'thomann.de', 'bhphotovideo.com', 'sweetwater.com',
      'bluedart.com', 'trackon.in', 'delhivery.com', 'dtdc.in', 'indiapost.gov.in', 'fedex.com', 'dhl.com',
    ],
  },
  {
    // Money: the bank, the card, the rewards site. Never mixed with Social,
    // where a rewards page used to land because a link opened beside Facebook.
    id: 'money', name: 'Money',
    hosts: [
      'axisbank.com', 'axis.bank.in', 'hdfcbank.com', 'icicibank.com', 'sbi.co.in', 'kotak.com',
      'reward360.in', 'paytm.com', 'phonepe.com', 'razorpay.com', 'payu.in', 'onlinesbi.sbi',
      'incometax.gov.in', 'gst.gov.in', 'cleartax.in', 'zerodha.com', 'groww.in', 'paypal.com',
    ],
  },
  {
    // Films and music, so an evening's viewing is not filed under "Tabs".
    id: 'watch', name: 'Watch & listen',
    hosts: [
      'netflix.com', 'primevideo.com', 'hotstar.com', 'jiohotstar.com', 'sonyliv.com', 'zee5.com',
      'jiocinema.com', 'tv.apple.com', 'spotify.com', 'open.spotify.com', 'soundcloud.com',
      'cricinfo.com', 'espncricinfo.com', 'hoichoi.tv', 'mubi.com',
    ],
  },
];

const OTHER = { id: 'other', name: 'Tabs' }; // "Tabs" in the sidebar; History calls the same group "Everything else"

function hostMatches(host, rule) {
  return host === rule || host.endsWith('.' + rule);
}

// The groups in force: the preset's own first, then these, with any hosts the preset adds.
function groups() {
  const p = presets.active();
  if (!p) return GROUPS;
  const extra = p.groupHosts || {};
  return [...(p.groups || []), ...GROUPS.map((g) => (extra[g.id] ? { ...g, hosts: [...g.hosts, ...extra[g.id]] } : g))];
}

function groupFor(url) {
  let u;
  try { u = new URL(url); } catch { return OTHER.id; }
  if (!/^https?:$/.test(u.protocol)) return OTHER.id;
  const host = u.hostname.replace(/^www\./, '');
  for (const g of groups()) {
    if (g.paths && g.paths.some(([h, p]) => hostMatches(host, h) && u.pathname.startsWith(p))) return g.id;
    if (g.hosts.some((h) => hostMatches(host, h))) return g.id;
  }
  return OTHER.id;
}

const groupList = () => [...groups().map(({ id, name }) => ({ id, name })), OTHER];

module.exports = { groupFor, groupList };
