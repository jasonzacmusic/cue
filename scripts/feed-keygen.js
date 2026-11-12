// Prints a fresh Ed25519 keypair for signing Cue's Windows/Linux update feed.
// Nothing is written to disk. Usage: node scripts/feed-keygen.js
//
//   1. Put the PRIVATE key (the whole PEM block) in the GitHub Actions secret
//      CUE_FEED_KEY of jasonzacmusic/cue. Keep no other copy in iCloud or the repo.
//   2. Paste the PUBLIC key line into FEED_PUBLIC_KEY in src/main/update-core.js.
//   3. node test/update-cross.js must then pass its "public key" line.
// A Cue in the field only trusts the key it was built with, so changing the key
// later means Windows/Linux copies older than that change stop updating.
const crypto = require('crypto');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
process.stdout.write(`PUBLIC KEY (paste into FEED_PUBLIC_KEY in src/main/update-core.js):\n${pub}\n\nPRIVATE KEY (the GitHub secret CUE_FEED_KEY, all of it):\n${priv}`);
