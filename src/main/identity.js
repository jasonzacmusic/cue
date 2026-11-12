// Who Cue says it is, in one place.
//
// Google and Meta ask "which browser is this?" in several places at once: the User-Agent line,
// the Sec-CH-UA client-hint headers, navigator.userAgent, navigator.userAgentData (low and high
// entropy), navigator.platform and navigator.languages - in the page, in every iframe, and in the
// page's workers. A real Chrome gives the SAME answer everywhere. Any two that disagree are a
// stronger "not Chrome" signal than any one of them on its own, so every surface is fed from the
// one object this file builds.
//
// The brand list is built exactly the way Chromium builds it (components/embedder_support/
// user_agent_utils.cc, GenerateBrandVersionList with the updated GREASE): the filler brand, its
// version and the ORDER of the three brands are all derived from the major version, so they move
// with every Chromium upgrade instead of being frozen at whatever was true the day it was written.
const os = require('os');

const GREASE_CHARS = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
const GREASE_VERSIONS = ['8', '99', '24'];
const ORDERS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

// Chromium's filler brand for a major version: "Not?A_Brand" / "24" for 152.
function grease(seed, full) {
  const brand = `Not${GREASE_CHARS[seed % GREASE_CHARS.length]}A${GREASE_CHARS[(seed + 1) % GREASE_CHARS.length]}Brand`;
  const v = GREASE_VERSIONS[seed % GREASE_VERSIONS.length];
  return { brand, version: full ? `${v}.0.0.0` : v };
}

// The three brands in the order a real Google Chrome of this version lists them.
function brandList(seed, version, full) {
  const order = ORDERS[seed % ORDERS.length];
  const out = new Array(3);
  out[order[0]] = grease(seed, full);
  out[order[1]] = { brand: 'Chromium', version };
  out[order[2]] = { brand: 'Google Chrome', version };
  return out;
}

// macOS "26.4" -> "26.4.0", the way Chromium reports platformVersion.
const threeParts = (v) => {
  const p = String(v || '').split('.').map((x) => x.replace(/\D.*$/, '')).filter((x) => x !== '');
  while (p.length < 3) p.push('0');
  return p.slice(0, 3).join('.');
};

// Windows' platformVersion is the UniversalApiContract version, not the NT build. Chromium reads it
// from the registry; this is the published mapping by build, close enough that a page cannot tell
// Cue from a Chrome on the same machine. Windows 7/8 (pre-10) answer "0.0.0" in Chrome too.
function windowsPlatformVersion(release) {
  const build = Number(String(release || '').split('.')[2]) || 0;
  if (!build) return '0.0.0';
  const table = [[26100, '19.0.0'], [22631, '15.0.0'], [22621, '15.0.0'], [22000, '14.0.0'], [19041, '10.0.0'],
    [18362, '8.0.0'], [17763, '7.0.0'], [17134, '6.0.0'], [16299, '5.0.0'], [15063, '4.0.0'], [14393, '3.0.0'], [10586, '2.0.0'], [10240, '1.0.0']];
  for (const [min, v] of table) if (build >= min) return v;
  return '0.0.0';
}

function systemVersion() {
  try { if (typeof process.getSystemVersion === 'function') return process.getSystemVersion(); } catch {}
  return os.release();
}

function preferredLanguages() {
  try {
    const { app } = require('electron');
    const list = (app.getPreferredSystemLanguages && app.getPreferredSystemLanguages()) || [];
    const clean = [...new Set(list.map((l) => String(l).trim()).filter((l) => /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(l)))];
    if (clean.length) return clean;
    const one = app.getLocale && app.getLocale();
    if (one) return [one];
  } catch {}
  return ['en-US'];
}

// Everything a page could ask, answered once. Every input can be passed in, so the Windows and
// Linux answers are checked by test/identity-test.js on a Mac.
function chromeIdentity(o = {}) {
  const fullVersion = o.chrome || process.versions.chrome;
  const major = fullVersion.split('.')[0];
  const seed = Number(major);
  const platform = o.platform || process.platform;
  const arch = o.arch || process.arch;
  const release = o.osVersion !== undefined ? o.osVersion : (platform === process.platform ? systemVersion() : '');
  const languages = (o.languages && o.languages.length ? o.languages : preferredLanguages()).slice(0, 8);
  const mac = platform === 'darwin'; const win = platform === 'win32';
  const arm = /^arm/.test(arch);
  const uaOS = mac ? 'Macintosh; Intel Mac OS X 10_15_7' : win ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
  return {
    fullVersion,
    major,
    // Chrome's reduced user agent: the real major version, the rest zeros, and the frozen OS token.
    userAgent: `Mozilla/5.0 (${uaOS}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    brands: brandList(seed, major, false),
    fullVersionList: brandList(seed, fullVersion, true),
    platform: mac ? 'macOS' : win ? 'Windows' : 'Linux',
    platformVersion: mac ? threeParts(release) : win ? windowsPlatformVersion(release) : threeParts(release),
    architecture: arm ? 'arm' : 'x86',
    bitness: /64/.test(arch) || arch === 'x64' ? '64' : '32',
    model: '',
    mobile: false,
    wow64: false,
    formFactors: ['Desktop'],
    // navigator.platform is NOT frozen in Chrome: a Mac says MacIntel even on Apple silicon.
    navigatorPlatform: mac ? 'MacIntel' : win ? 'Win32' : (arm ? 'Linux aarch64' : 'Linux x86_64'),
    vendor: 'Google Inc.',
    languages,
    acceptLanguage: languages.join(','),
  };
}

// Built once, after the app is ready: before that the system's languages cannot be read.
let cached = null;
const appReady = () => { try { return require('electron').app.isReady(); } catch { return true; } };
const identity = () => {
  if (cached) return cached;
  const id = chromeIdentity();
  if (appReady()) cached = id;
  return id;
};

const quote = (list) => list.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
const str = (s) => `"${s}"`;

// The client-hint headers. The three low-entropy ones go on every https request, as in Chrome; the
// rest only when the site asked for them (Accept-CH), which shows up as Chromium already putting
// the header on the request - Cue then makes its value agree.
function hintHeaders(id = identity()) {
  return {
    'sec-ch-ua': quote(id.brands),
    'sec-ch-ua-mobile': id.mobile ? '?1' : '?0',
    'sec-ch-ua-platform': str(id.platform),
    'sec-ch-ua-full-version-list': quote(id.fullVersionList),
    'sec-ch-ua-full-version': str(id.fullVersion),
    'sec-ch-ua-platform-version': str(id.platformVersion),
    'sec-ch-ua-arch': str(id.architecture),
    'sec-ch-ua-bitness': str(id.bitness),
    'sec-ch-ua-model': str(id.model),
    'sec-ch-ua-wow64': id.wow64 ? '?1' : '?0',
    'sec-ch-ua-form-factors': quote(id.formFactors.map((f) => ({ brand: f, version: '' }))).replace(/;v=""/g, ''),
  };
}
const ALWAYS = new Set(['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']);

let tapFn = null;
// Only on https, which is where a real Chrome sends them.
function sayChrome(headers, url, id = identity()) {
  if (/^https:/i.test(url)) {
    const hints = hintHeaders(id);
    const seen = new Map();
    for (const k of Object.keys(headers)) seen.set(k.toLowerCase(), k);
    for (const [name, value] of Object.entries(hints)) {
      const had = seen.get(name);
      if (!had && !ALWAYS.has(name)) continue;
      headers[had || name] = value;
    }
    const ua = seen.get('user-agent');
    if (ua) headers[ua] = id.userAgent;
  }
  if (tapFn) { try { tapFn(url, headers); } catch {} }
  return headers;
}

// What Chromium itself is told, through its own DevTools protocol: Emulation.setUserAgentOverride
// with full metadata. This is the one door that reaches the page, every same- and cross-origin
// iframe, dedicated workers AND the client-hint headers Chromium writes itself, without defining a
// single property on navigator that a page could catch being redefined.
function cdpOverride(id = identity()) {
  return {
    userAgent: id.userAgent,
    acceptLanguage: id.acceptLanguage,
    platform: id.navigatorPlatform,
    userAgentMetadata: {
      brands: id.brands, fullVersionList: id.fullVersionList, fullVersion: id.fullVersion,
      platform: id.platform, platformVersion: id.platformVersion, architecture: id.architecture,
      model: id.model, mobile: id.mobile, bitness: id.bitness, wow64: id.wow64, formFactors: id.formFactors,
    },
  };
}

// What a page's own script should see, for the places the protocol cannot reach (service workers;
// and the top frame if the protocol ever failed to attach). Plain data, handed to the preloads.
function pageData(id = identity()) {
  return {
    userAgent: id.userAgent, brands: id.brands, fullVersionList: id.fullVersionList, fullVersion: id.fullVersion,
    platform: id.platform, platformVersion: id.platformVersion, architecture: id.architecture, bitness: id.bitness,
    model: id.model, mobile: id.mobile, wow64: id.wow64, formFactors: id.formFactors, navigatorPlatform: id.navigatorPlatform,
    languages: id.languages,
  };
}

// Runs in the page's own world (a frame, or a service worker). Makes navigator agree with `d`
// by patching the getters on the PROTOTYPES, where the real ones live, so an own-property check on
// navigator finds nothing. Does nothing where the answer already matches.
function patchNavigator(d) {
  try {
    const N = typeof Navigator !== 'undefined' ? Navigator : (typeof WorkerNavigator !== 'undefined' ? WorkerNavigator : null);
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    if (!N || !nav) return;
    const data = nav.userAgentData;
    const already = data && data.brands && data.brands.length === d.brands.length
      && data.brands.every((b, i) => b.brand === d.brands[i].brand && b.version === d.brands[i].version);
    const copy = (l) => l.map((b) => ({ brand: b.brand, version: b.version }));
    const getter = (proto, name, value) => {
      const was = Object.getOwnPropertyDescriptor(proto, name);
      if (!was || !was.get) return;
      const g = { [name]() { return typeof value === 'function' ? value() : value; } }[name];
      Object.defineProperty(g, 'name', { value: `get ${name}` });
      Object.defineProperty(proto, name, { ...was, get: g });
    };
    if (nav.userAgent !== d.userAgent) {
      getter(N.prototype, 'userAgent', d.userAgent);
      getter(N.prototype, 'appVersion', d.userAgent.replace(/^Mozilla\//, ''));
    }
    if (nav.platform !== d.navigatorPlatform) getter(N.prototype, 'platform', d.navigatorPlatform);
    if (!already && data && typeof NavigatorUAData !== 'undefined') {
      const P = NavigatorUAData.prototype;
      getter(P, 'brands', () => Object.freeze(copy(d.brands)));
      getter(P, 'mobile', d.mobile);
      getter(P, 'platform', d.platform);
      const high = P.getHighEntropyValues;
      const ghev = { getHighEntropyValues(hints) {
        return high.call(this, hints).then((v) => {
          const want = new Set(Array.isArray(hints) ? hints : []);
          const out = { ...v, brands: copy(d.brands), mobile: d.mobile, platform: d.platform };
          const put = (k, val) => { if (want.has(k)) out[k] = val; };
          put('fullVersionList', copy(d.fullVersionList)); put('uaFullVersion', d.fullVersion); put('platformVersion', d.platformVersion);
          put('architecture', d.architecture); put('bitness', d.bitness); put('model', d.model); put('wow64', d.wow64); put('formFactors', d.formFactors.slice());
          return out;
        });
      } }.getHighEntropyValues;
      P.getHighEntropyValues = ghev;
      const toJSON = { toJSON() { return { brands: copy(d.brands), mobile: d.mobile, platform: d.platform }; } }.toJSON;
      P.toJSON = toJSON;
      // Functions that read as native, the way Chrome's own do.
      const real = Function.prototype.toString;
      const fakes = new Map([[ghev, 'getHighEntropyValues'], [toJSON, 'toJSON']]);
      for (const name of ['brands', 'mobile', 'platform']) { const x = Object.getOwnPropertyDescriptor(P, name); if (x && x.get) fakes.set(x.get, `get ${name}`); }
      for (const name of ['userAgent', 'appVersion', 'platform']) { const x = Object.getOwnPropertyDescriptor(N.prototype, name); if (x && x.get && !fakes.has(x.get)) fakes.set(x.get, `get ${name}`); }
      const ts = { toString() { return fakes.has(this) ? `function ${fakes.get(this)}() { [native code] }` : real.call(this); } }.toString;
      fakes.set(ts, 'toString');
      Function.prototype.toString = ts;
    }
  } catch { /* a page we could not dress is still a page */ }
}

module.exports = {
  chromeIdentity, identity, brandList, grease, hintHeaders, sayChrome, cdpOverride, pageData, patchNavigator,
  windowsPlatformVersion, tap: (fn) => { tapFn = fn; },
};
