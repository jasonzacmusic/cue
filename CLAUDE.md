# Cue: guide for Claude, Codex and any other AI working here

Cue is Nathaniel School of Music's free, open-source browser, built on Electron (Chromium).
Owner: Jason Zac, a non-coder who works by voice. GitHub (`main`) is the source of truth.
`AGENTS.md` points here so Codex reads the same file.

## The goal right now
Cue replaces Helium as Jason's daily browser. Jason does not want Helium or Brave data moved in. Helium is removed only after Cue is proven better
on the Mac mini: see "Retiring Helium" below. Stage 2 (our own Chromium build) has not started.

## How to work
- Plain English in anything Jason reads: Done / Not done / Need you, under 150 words.
- Never ask him to run a command or open a dashboard. Passwords and 2FA are the only things he types.
- Check before touching the screen: `pgrep -x REAPER; pgrep -f CptHost; pgrep -x obs`. If any prints
  a number he is recording or teaching: wait. Never touch his DAW or audio settings.
- Never force-quit, never empty the Trash. Old apps go to the Trash, which is recoverable.
- Commit and push to `main` when a change is tested. Don't commit keys, private IDs or build output.
- Every sound in an NSM app comes from the NSM Sample Vault. Cue plays no sounds of its own.

## Where things are
- `src/main/main.js`: windows, tabs, Spaces, split views, on air, Peek, AI panel, menus, every wire.
- `src/main/agent-port.js` + `bin/cue-mcp.js`: the AI door (port 8813) and its tools. Add a tool in both.
- `src/main/vanish.js`: the Vanish window. Its tabs are kept out of Cue's tab list on purpose, so nothing that saves or shares tabs can reach them.
- `src/main/signin.js`: where a page's new window goes (popup, same tab, new tab). `refuseOpen` stops pages opening local files or Cue's own pages. `shared-logins.js`: copies sign-ins between Personal and School, except sites with two accounts.
- The team.nathanielschool.com password import is a one-time step for the school's own staff. It shows only if this computer is signed in to that site. Everyone else moves in from Chrome or Safari; never present it as a Cue feature.
- `src/main/db.js`: history, bookmarks, Boards. `vault.js`: passwords (OS keychain). `bills.js`: bill reader.
- `src/main/importer.js`: move in from Chrome, Safari, Helium, Brave, Edge, Arc. Safari needs Full Disk Access.
- `src/main/capture.js`, `page-tools.js`, `extensions.js`, `groups.js`, `obs.js`.
- `src/preload/tab.js`: runs in every page (volume, music tools, logins, held notifications).
- `src/ui/`: sidebar and toolbar. `src/ui/pages/`: Boards, Library, Bills, Thumbnail check (`cue://` pages).

## Testing
Tests never take over Jason's screen: every `CUE_TEST` run is hidden (`test/hidden-windows.js`: no Dock icon, no focus, invisible windows, full screen acted out).
For a small fix, run only the check for that change. Run the full suite once, just before a release. Never rerun after a failure until the cause is fixed.
Real macOS full screen can't run hidden: check it by hand on the installed app when he's away, or on the Mac mini.
```bash
npm ci
CUE_QUIET=1 CUE_TEST=features CUE_USER_DATA=/tmp/cue-a CUE_OUT=/tmp/cue-a-out npx electron .   # every feature, real app
CUE_TEST=restart CUE_PHASE=1 CUE_USER_DATA=/tmp/cue-r npx electron . && CUE_TEST=restart CUE_PHASE=2 CUE_USER_DATA=/tmp/cue-r npx electron .   # split views survive a restart
CUE_TEST=1 CUE_USER_DATA=/tmp/cue-b CUE_OUT=/tmp/cue-b-out npx electron .          # real NSM sites, split views, on air
node test/importer-test.js                                                          # move-in, with fake browser data
CUE_OLDER_DMG=<a signed older Cue.dmg> node test/update.js                           # updating itself, on the notarized build
```
`CUE_QUIET=1` keeps tests silent and independent of whatever headphones are connected: a sleeping pair of AirPods stalls every video.
The screen must be awake and unlocked, or picture and click checks fail.
Use a new `CUE_USER_DATA` folder each run. Results are printed as PASS/FAIL and written to `CUE_OUT`.
`CUE_TEST` uses a mock keychain, so tests never pop a dialog and never touch his real passwords.
Look at the pictures in `CUE_OUT`, not just the numbers. Add a check to `test/features.js` for
every new feature, and run a control when a test proves something by finding nothing.

Testing NSM apps through Cue: open the app with `cue_open` in the agent lane, click through with
`cue_snapshot` and `cue_click`, then report from `cue_problems`.

## WhatsApp (src/main/whatsapp.js)

Jason, Claude, Codex and every other agent use the SAME two WhatsApp logins: the pinned tab in
Personal is his own number, the pinned tab in School is the school's. WhatsApp allows one linked
browser per phone, so there is no second session to make — these tabs are it.

- `cue_whatsapp` is the only way an agent should touch WhatsApp. One call per job, one piece of
  JavaScript in a tab that is already open, an answer of a few plain lines. No screenshot, no
  snapshot, no navigation: a chat list costs about 120 characters.
- `who` is always said out loud — "jason" or "nathaniel". It refuses to guess, so a message
  meant for a student never leaves his personal number.
- `send` is only reported as sent once the words are seen in the conversation. If it cannot see
  them it says so and names the tab to look at. Never soften that into "sent".
- The two WhatsApp tabs are the one place agents may click and type in Jason's own tabs
  (`HANDED_OVER` in main.js), because group admin and saving a contact still need hands.
  Everywhere else the old rule holds: an agent's own tab, or one he ticked.
- Linking is his: Cue cannot scan a code. When an account is not linked every action says so in
  plain words and `status` with `show: true` brings the tab forward for the scan.
- The page scripts lean on the few parts of WhatsApp's markup that have outlived its redesigns:
  `#pane-side`, `[role="listitem"]`, `span[title]`, `data-pre-plain-text`, the two
  contenteditable boxes. `test/whatsapp.js` drives them against a stand-in page, so a WhatsApp
  redesign will NOT turn that test red — check the live thing after any WhatsApp change.
- Opening a chat to read it is the same as opening it on his phone: WhatsApp marks it read. So
  `read` costs him the unread mark. Use `chats unreadOnly:true` to see what is waiting without
  spending it, and only read what he asked for.
- Clicks are dispatched in the page, never aimed at x,y: these tabs live in the background with
  no geometry, and a mouse sent at a tab nobody can see hits nothing.

## WhatsApp markup moves under us
WhatsApp renamed its chat rows from `role="listitem"` to `role="row"` (seen live 2-Nov-2026, which
is what 0.6.2 fixes). Anything that walks the chat list lists BOTH roles. The test serves one
account in each shape on purpose, so a selector that only knows one of them fails the suite.
The anchors that have held so far: `#pane-side`, `span[title]`, `data-pre-plain-text`,
`.message-in` / `.message-out`, `.selectable-text`, and the two `div[contenteditable="true"]`.

## The AI door

It is remembered now, not reset at every launch (`settings().aiDoor`), because an agent
answering WhatsApp while he teaches cannot wait for someone to open a door. Everything else
about it stands: private tabs, Vanish tabs and the tab on air are refused, every call is logged,
and Cue says on screen when an agent reaches into a tab he did not hand it.

## Releasing (needs the `nsm-notary` keychain profile; `~/Documents/NSM Reports/codex-cue-notary-release.md` sets it up on a new Mac)
0. `npm run check` - every file Cue ships has to parse. 0.6.0 shipped a broken MCP bridge
   because an apostrophe in "the school's" closed a single-quoted string, and no suite caught it:
   the bridge only runs in a separate process that nothing in the gate starts. Never skip this.
1. Raise `version` in `package.json` and the `serverInfo` version in `bin/cue-mcp.js`.
2. `npm run dist:mac`
3. `~/.claude/skills/nsm-mac-app/scripts/nsm-notarize.sh build/Cue-darwin-arm64/Cue.app --no-resign --dmg`
   Never re-sign an Electron build after packaging.
4. `~/.claude/skills/nsm-mac-app/scripts/nsm-publish.sh cue <version> <dmg> --notes "..."`
5. Push a `v<version>` tag. That builds Windows and Linux in GitHub Actions
   (`.github/workflows/build.yml`; not code-signed, smoke test must pass) AND it is where
   labs.nathanielschool.com reads Cue's version from, so without the tag the Labs page keeps
   showing the old release however the registry reads.
6. `nsm-publish.sh` does NOT write the in-app update feed. Write `cue-update.json` by hand
   (version, date, notes, sha256, size, the rolling `downloads/Cue.dmg` url) and
   `gh release upload downloads cue-update.json --repo jasonzacmusic/labs-downloads --clobber`.
7. Check the registry really changed: its "registry.yaml: cue -> x" line can print while the
   file is untouched. `release.version`, `asset_patterns` and `stable_download_urls` in
   `product-registry/registry.yaml` all carry the version; commit and push them yourself.
8. Prove it from outside: the Labs page, the three download links and the feed, each with a
   cache-busting `?t=`. The script's own "shows x ✓" line has been wrong.

## Retiring Helium
Prove it on the Mac mini with real measured numbers (time to first page and
memory on the same five pages, written to `speed-vs-helium.md` in iCloud `NSM Deliverables/01 Apps/Cue Browser`).
Then, in order: move in from Chrome inside Cue (File > Move In), confirm bookmarks, history and
sign-ins arrived, make Cue the default browser, and only then move `/Applications/Helium.app` to
the Trash. Never delete Helium's data folder, and never empty the Trash. If Cue is slower, leave
Helium installed and report the numbers.

## Size and cache limits (do not loosen without a reason)
- The app must stay under the budget in `scripts/build-mac.js`, which fails the build above it. Adding a dependency is a size decision.
- Cache: 256 MB disk cap per login, 600 MB total per login before `trimCaches` empties it. Sign-ins survive.
- History keeps the newest 50,000 pages. Logs rotate.

## Honest limits today
- YouTube's own ads are removed inside the page (`quietYouTube` in `src/preload/tab.js`), on youtube.com only, never Studio. YouTube can change its page and break this. Videos embedded on other sites aren't covered, and neither are sponsored posts inside Instagram or Facebook feeds.
- Blocked ad scripts can retry in a tight loop, which costs more than the ad. `CUE_TEST=speed` shows it; a tiny exception in `shield.js` stops it, as with CNN.
- Google will not run its sign-in form inside Cue, as in every browser built this way: it answers "this browser or app may not be secure". Cue says the user agent and the client hints Chrome says, which is not enough, so from 0.5.3 Cue replaces Google's dead end with `cue://signin-blocked` and carries the Google sign-in over from Chrome instead.
- Carrying a sign-in over from Chrome (File > Bring This Site's Sign-in Over From Chrome) empties
  the jar for that site first. Adding Chrome's cookies to the ones already there mixed two
  generations of the same session, which is what made Google answer "we've detected a problem with
  your cookie settings". It also takes the Chrome profile that actually holds cookies for that
  site; the first profile and the email on the identity are both wrong on this Mac.
- Never open `accounts.google.com/Logout` in a jar that was carried from Chrome. The carried
  cookies ARE Chrome's session, so signing out there revokes it everywhere it was copied - it
  signed Chrome itself out of both Google accounts on 31-Oct-2026, and only a fresh sign-in with
  the password brings it back. To put a different Google account in an identity, sign in to that
  account; never sign the carried one out.
- WhatsApp Web keeps its link in IndexedDB, not cookies, so it cannot be carried from any browser.
  Each identity has to scan the code once with the phone; after that it stays. That is also how
  Personal and School end up as two separate WhatsApps.
- Safari's cookies cannot be read at all (macOS protects `~/Library/Safari` and the cookie store),
  so Chrome is the only browser a sign-in can come from.
- Protected video (Netflix, Prime, Hotstar, Apple TV, Spotify) does not play: the Electron we use has no Widevine. `src/main/video.js` lists these sites and Cue says so once. The way in is castLabs' Electron with Widevine plus free EVS signing, which needs an account. Dolby audio (E-AC3), AirPlay and casting aren't available either.
- Vanish full screen fills the screen where the window already is (`setSimpleFullScreen`). A Mac's own full screen moved it to another desktop and could land on the main window.
- Passkeys need Apple's browser permission or our own Chromium build (Stage 2).
- The cache limit is per login, not per site.
- Vanish is hidden from screen sharing with Apple's normal setting. Some capture tools on recent macOS ignore it.
- Chrome extensions: simple ones work. Ones that need Chrome's toolbar APIs may not, until Stage 2.
- Windows passwords and sign-ins can't be moved in, because Chrome locks them to itself there.
- The bill reader works from each page's wording, so a redesigned billing page may need a new phrase in `bills.js`.
