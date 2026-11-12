// Writes and signs cue-feed.json for the Windows and Linux builds. Run by CI
// (.github/workflows/build.yml, job "release") after both builds are in dist/.
// Usage: CUE_FEED_KEY="<PEM>" node scripts/feed-write.js <version> <dist-dir> [notes]
//
// The feed lists each platform's VERSIONED archive on this tag's release, so a
// copy of Cue always fetches exactly the bytes whose sha256 was signed. The
// signature covers canonical() in src/main/update-core.js, the same function
// every Cue verifies with.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('../src/main/update-core');

const [version, dist, notes = ''] = process.argv.slice(2);
const die = (m) => { console.error(`::error::${m}`); process.exit(1); };
if (!version || !dist) die('usage: node scripts/feed-write.js <version> <dist-dir> [notes]');
const pem = process.env.CUE_FEED_KEY;
if (!pem || !pem.includes('PRIVATE KEY')) die('The secret CUE_FEED_KEY is missing or is not a PEM private key. Make one with `node scripts/feed-keygen.js` and set it in the repo settings (Secrets and variables > Actions). Without it, Windows and Linux copies cannot update.');
if (core.FEED_PUBLIC_KEY === core.PLACEHOLDER_KEY) die('FEED_PUBLIC_KEY in src/main/update-core.js is still the placeholder. Paste the public key from `node scripts/feed-keygen.js`, commit, and tag again.');
let derived = '';
try { derived = crypto.createPublicKey(crypto.createPrivateKey(pem)).export({ type: 'spki', format: 'der' }).toString('base64'); } catch (e) { die(`CUE_FEED_KEY could not be read as a private key: ${e.message}`); }
// The key in the secret must be the one built into Cue, or every copy would refuse this feed.
if (derived !== core.FEED_PUBLIC_KEY) die('CUE_FEED_KEY does not match FEED_PUBLIC_KEY in src/main/update-core.js. Copies of Cue would refuse this feed.');

const repo = process.env.GITHUB_REPOSITORY || 'jasonzacmusic/cue';
const tag = process.env.GITHUB_REF_NAME || `v${version}`;
const [baseTag, build, ...extra] = tag.split('+');
if (baseTag !== `v${version}` || extra.length || (build !== undefined && !/^desktop\.[1-9][0-9]*$/.test(build))) {
  die('The release tag must match the application version.');
}
const files = { 'win32-x64': `Cue-${version}-win-x64.zip`, 'linux-x64': `Cue-${version}-linux-x64.tar.gz` };
const platforms = {};
for (const [key, name] of Object.entries(files)) {
  const file = path.join(dist, name);
  if (!fs.existsSync(file)) die(`${name} is not in ${dist}`);
  const bytes = fs.readFileSync(file);
  platforms[key] = {
    url: `https://github.com/${repo}/releases/download/${tag}/${name}`,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
}
const feed = core.signFeed({ app: 'Cue', version, date: new Date().toISOString().slice(0, 10), notes, platforms }, pem);
if (!core.verifyFeed(feed, derived)) die('the feed did not verify after signing');

fs.writeFileSync(path.join(dist, 'cue-feed.json'), `${JSON.stringify(feed, null, 2)}\n`);
console.log(`cue-feed.json: ${version}, ${Object.keys(platforms).join(', ')}`);
