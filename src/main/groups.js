// Which sidebar group a tab belongs to, decided by its address.
// Order matters: the first matching rule wins, so Gemini lands in AI before Google.

const GROUPS = [
  { id: 'nsm', name: 'Nathaniel School', hosts: ['nathanielschool.com'] },
  {
    id: 'ai', name: 'AI & Subscriptions',
    hosts: [
      'claude.ai', 'anthropic.com', 'chatgpt.com', 'openai.com', 'gemini.google.com',
      'aistudio.google.com', 'notebooklm.google.com', 'perplexity.ai', 'grok.com', 'x.ai',
      'elevenlabs.io', 'replicate.com', 'midjourney.com', 'cursor.com', 'suno.com',
      'vercel.com', 'neon.tech', 'bunny.net', 'brevo.com', 'render.com', 'name.com',
      'paddle.com', 'stripe.com', 'vidiq.com', 'wisprflow.ai', 'canva.com', 'finance.jasonzacmusic.com',
    ],
    paths: [['github.com', '/settings/billing'], ['console.cloud.google.com', '/billing']],
  },
  {
    id: 'google', name: 'Google',
    hosts: ['google.com', 'youtube.com', 'youtu.be', 'gmail.com', 'googleusercontent.com', 'withgoogle.com'],
  },
  {
    id: 'social', name: 'Social',
    hosts: ['instagram.com', 'facebook.com', 'threads.net', 'linkedin.com', 'x.com', 'twitter.com', 'pinterest.com', 'whatsapp.com', 'patreon.com'],
  },
  { id: 'code', name: 'Code', hosts: ['github.com', 'gitlab.com', 'npmjs.com', 'stackoverflow.com'] },
];

const OTHER = { id: 'other', name: 'Tabs' }; // "Tabs" in the sidebar; History calls the same group "Everything else"

function hostMatches(host, rule) {
  return host === rule || host.endsWith('.' + rule);
}

function groupFor(url) {
  let u;
  try { u = new URL(url); } catch { return OTHER.id; }
  if (!/^https?:$/.test(u.protocol)) return OTHER.id;
  const host = u.hostname.replace(/^www\./, '');
  for (const g of GROUPS) {
    if (g.paths && g.paths.some(([h, p]) => hostMatches(host, h) && u.pathname.startsWith(p))) return g.id;
    if (g.hosts.some((h) => hostMatches(host, h))) return g.id;
  }
  return OTHER.id;
}

const GROUP_LIST = [...GROUPS.map(({ id, name }) => ({ id, name })), OTHER];

module.exports = { groupFor, GROUP_LIST };
