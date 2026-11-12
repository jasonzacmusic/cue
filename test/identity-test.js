// node test/identity-test.js
//
// The one Chrome identity (src/main/identity.js), checked for every platform Cue ships on - from
// this Mac, by passing the platform in - against what real Google Chrome says.
const assert = require('assert');
const id = require('../src/main/identity');

let pass = 0; let fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log(`PASS ${name}`); } catch (e) { fail++; console.log(`FAIL ${name} :: ${e.message}`); } };
const names = (l) => l.map((b) => `${b.brand}/${b.version}`).join(', ');

// Brand lists real Chrome sent, as recorded from Chrome's own Sec-CH-UA header.
check('Chrome 131 brand order and filler', () => assert.strictEqual(names(id.brandList(131, '131', false)), 'Google Chrome/131, Chromium/131, Not_A Brand/24'));
check('Chrome 120 brand order and filler', () => assert.strictEqual(names(id.brandList(120, '120', false)), 'Not_A Brand/8, Chromium/120, Google Chrome/120'));
check('Chrome 124 brand order and filler', () => assert.strictEqual(names(id.brandList(124, '124', false)), 'Chromium/124, Google Chrome/124, Not-A.Brand/99'));
check('Chrome 152 (this Electron) matches what Chromium itself builds', () => assert.strictEqual(names(id.brandList(152, '152', false)), 'Chromium/152, Not?A_Brand/24, Google Chrome/152'));
check('the filler moves with the version (never a frozen "24")', () => assert.notStrictEqual(id.grease(150).brand + id.grease(150).version, id.grease(151).brand + id.grease(151).version));
check('full version list uses the filler’s x.0.0.0', () => assert.strictEqual(id.brandList(152, '152.0.7977.169', true).find((b) => /Not/.test(b.brand)).version, '24.0.0.0'));

const cases = [
  { platform: 'darwin', arch: 'arm64', osVersion: '26.4', want: { platform: 'macOS', platformVersion: '26.4.0', architecture: 'arm', navigatorPlatform: 'MacIntel', ua: 'Macintosh; Intel Mac OS X 10_15_7' } },
  { platform: 'darwin', arch: 'x64', osVersion: '14.6.1', want: { platform: 'macOS', platformVersion: '14.6.1', architecture: 'x86', navigatorPlatform: 'MacIntel', ua: 'Macintosh; Intel Mac OS X 10_15_7' } },
  { platform: 'win32', arch: 'x64', osVersion: '10.0.22631', want: { platform: 'Windows', platformVersion: '15.0.0', architecture: 'x86', navigatorPlatform: 'Win32', ua: 'Windows NT 10.0; Win64; x64' } },
  { platform: 'win32', arch: 'x64', osVersion: '10.0.19045', want: { platform: 'Windows', platformVersion: '10.0.0', architecture: 'x86', navigatorPlatform: 'Win32', ua: 'Windows NT 10.0; Win64; x64' } },
  { platform: 'win32', arch: 'arm64', osVersion: '10.0.26100', want: { platform: 'Windows', platformVersion: '19.0.0', architecture: 'arm', navigatorPlatform: 'Win32', ua: 'Windows NT 10.0; Win64; x64' } },
  { platform: 'linux', arch: 'x64', osVersion: '6.8.0-45-generic', want: { platform: 'Linux', platformVersion: '6.8.0', architecture: 'x86', navigatorPlatform: 'Linux x86_64', ua: 'X11; Linux x86_64' } },
  { platform: 'linux', arch: 'arm64', osVersion: '6.1.21-v8+', want: { platform: 'Linux', platformVersion: '6.1.21', architecture: 'arm', navigatorPlatform: 'Linux aarch64', ua: 'X11; Linux x86_64' } },
];
for (const c of cases) {
  const x = id.chromeIdentity({ chrome: '152.0.7977.169', platform: c.platform, arch: c.arch, osVersion: c.osVersion, languages: ['en-GB', 'hi-IN'] });
  const tag = `${c.platform}/${c.arch}`;
  check(`${tag}: platform, version, arch, navigator.platform`, () => {
    for (const k of ['platform', 'platformVersion', 'architecture', 'navigatorPlatform']) assert.strictEqual(x[k], c.want[k], k);
  });
  check(`${tag}: Chrome's reduced user agent, no Electron`, () => {
    assert.strictEqual(x.userAgent, `Mozilla/5.0 (${c.want.ua}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36`);
    assert(!/electron|cue/i.test(x.userAgent));
  });
  check(`${tag}: headers, protocol override and page data all say the same brands`, () => {
    const h = id.hintHeaders(x);
    const fromHeader = h['sec-ch-ua'].split(', ').map((s) => s.replace(/^"([^"]*)";v="([^"]*)"$/, '$1/$2')).join(', ');
    assert.strictEqual(fromHeader, names(x.brands));
    assert.strictEqual(names(id.cdpOverride(x).userAgentMetadata.brands), names(x.brands));
    assert.strictEqual(names(id.pageData(x).brands), names(x.brands));
    assert.strictEqual(h['sec-ch-ua-platform'], `"${c.want.platform}"`);
    assert.strictEqual(id.cdpOverride(x).platform, c.want.navigatorPlatform);
    assert.strictEqual(h['sec-ch-ua-bitness'], '"64"');
  });
  check(`${tag}: Accept-Language is navigator.languages`, () => {
    assert.strictEqual(id.cdpOverride(x).acceptLanguage, 'en-GB,hi-IN');
    assert.deepStrictEqual(id.pageData(x).languages, ['en-GB', 'hi-IN']);
  });
}

check('headers: low-entropy hints always, high-entropy only when the site asked', () => {
  const x = id.chromeIdentity({ chrome: '152.0.7977.169', platform: 'win32', arch: 'x64', osVersion: '10.0.22631', languages: ['en-US'] });
  const plain = id.sayChrome({ 'User-Agent': 'x Electron/44' }, 'https://accounts.google.com/', x);
  assert(plain['sec-ch-ua'] && plain['sec-ch-ua-mobile'] === '?0' && plain['sec-ch-ua-platform'] === '"Windows"');
  assert(!plain['sec-ch-ua-full-version-list'] && !plain['sec-ch-ua-arch']);
  assert.strictEqual(plain['User-Agent'], x.userAgent);
  const asked = id.sayChrome({ 'Sec-CH-UA-Full-Version-List': 'old', 'sec-ch-ua-arch': 'old' }, 'https://accounts.google.com/', x);
  assert.strictEqual(asked['Sec-CH-UA-Full-Version-List'], '"Chromium";v="152.0.7977.169", "Not?A_Brand";v="24.0.0.0", "Google Chrome";v="152.0.7977.169"');
  assert.strictEqual(asked['sec-ch-ua-arch'], '"x86"');
  assert.strictEqual(Object.keys(id.sayChrome({}, 'http://plain.example/', x)).length, 0);
});

console.log(`DONE ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
