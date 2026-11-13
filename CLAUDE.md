# Cue: guide for Claude, Codex and any other AI working here

Cue is Nathaniel School of Music's free, open-source browser, built on Electron (Chromium).
Owner: Jason Zac, a non-coder who works by voice. GitHub (`main`) is the source of truth.
`AGENTS.md` points here so Codex reads the same file.

## The goal right now
Cue replaces Helium as Jason's daily browser. Jason does not want Helium or Brave data moved in. Helium is removed only after Cue is proven better
on the Mac mini: see "Retiring Helium" below. Stage 2 (our own Chromium build) has not started.

## 0.7.0: Cue is for everyone (12-Nov-2026)
Read this before anything below; several older sections describe the two-folder Cue.
- **People's folders.** `store.data.folders` is the list (id, name, colour, picture, email, lock, agents). Any number. Each has its own `persist:<id>` session, so its own Google, WhatsApp, cookies; history, bookmarks, Boards, passwords, downloads, closed tabs and alerts are per folder too. `sessionFor` throws on an unknown folder. Nothing is shared unless the pair is in `settings().sharedPairs` (the owner's Personal+School only). Optional passcode per folder (scrypt); a locked folder is absent from `sendState`. `test/people.js`.
- **A fresh install is plain.** One folder, one Space, empty number keys, nothing pinned, AI door off, Teacher and Business kits off, a first-run sheet. Everything school-specific lives in `src/main/presets/nsm.json` and applies only when `settings().preset === 'nsm'`. An upgraded install is frozen first (`freezeLegacy`, once) so the owner sees no change. Tests say which world they are in with `test/world.js` (`asOwner` / `asStranger`). `test/first-run.js`.
- **WhatsApp and Gmail tools** take `who` = any folder name or id from `cue_identities`. "jason"/"nathaniel" still work on the owner's install.
- **Files for agents** (`src/main/attach.js`). `cue_attach` puts real files on any page through Chromium's DevTools protocol, sharing the debugger connection `wearIdentity` already holds, never detaching it: a file box (hidden, iframe or shadow root), then an intercepted file chooser, then a drag-and-drop of real paths. No native dialog ever opens. Paths only from home, `/tmp` or `/Volumes`; never `~/Library`, keys or Cue's data. `cue_whatsapp send files` and `cue_gmail compose/reply files` use the same path; WhatsApp is "sent" only once the bubbles are seen, Gmail is a draft unless `send:true`. `cue_download` saves into `Downloads/Cue Agents`. Proven on stand-in pages (`test/attach.js`); check the live sites after any WhatsApp or Gmail redesign.
- **One Chrome identity** for every session, frame, worker and pop-up comes from `src/main/identity.js` (shared workers are the one gap in Electron 44). Google refusals clear that folder's Google state and retry once per 10 minutes.
- **Vanish** has its own settings room and one shortcut table (`src/main/vanish-keys.js`); main-window keys do nothing while Vanish has focus. "Only one video plays at a time" is off by default.
- **Tabs.** Ordinary tabs stay (`archiveDays: 0`). "Just for now" tabs (`temp`, Cmd/Ctrl+Alt+T) are never saved. Spaces are `{ name, tint }`. Pinned apps have volume (Option-scroll, level bar, hover control).
- **Updates on every system** (`updater.js`, `update-core.js`, `settle.js`, `win-swap.ps1`). Mac reads the old labs-downloads feed as before. Windows and Linux read `releases/latest/download/cue-feed.json` on this repo, written and Ed25519-signed by CI with the secret `CUE_FEED_KEY` (public key in `update-core.js`; a backup of the private key is in the print-room Mac's login keychain, item "Cue update feed signing key"). Never change that key: older Windows/Linux copies would stop updating. The tag's release must not be a prerelease.
- Run tests with their own `CUE_AGENT_PORT` so they never fight the installed Cue for 8813.

## 0.7.1 (13-Nov-2026)
- **Updates go in while Cue stays open**, at a quiet moment: 20 idle minutes, or the screen locked 10, and nothing on air, recording, playing, downloading, half-typed, in Vanish or "Just for now". `quietRefusal` in `update-core.js` decides (tested in `test/update-cross.js`), main.js asks every 5 minutes, and the tabs are written down (`saveNow`) before the swap because `app.exit` skips before-quit. Other Macs get Cue the first time from iCloud `Claude Handoffs/Updates/2026-11-13 Cue on every computer/install-cue.sh`.
- **Full screen owns the screen.** The AI panel and Peek were stacked above a full-screen video and took the mouse over part of it (pointer hidden, controls never back until Escape). In full screen they are hidden and the tab is raised; after the Mac's animation the view is nudged one pixel so it listens over the whole screen. Proved on the real screen with `test/fullscreen-real.js` (`CUE_REAL_SCREEN=1` skips the hidden-window stand-ins; by hand only, nobody teaching).
- **Google's sign-in steps repaint.** Moving between steps sometimes changed the address but left the old step on screen. If the step in the address changes and no visible word does within 3 s, the page reloads once per step (`skipGooglePasskey` in `src/preload/tab.js`). Passkeys themselves still cannot work (see Honest limits): use "Try another way".

## Pre-launch audit fixes (13-Nov-2026)
Gemini 4 Carbon audited Cue before launch; `test/audit.js` proves the fixes in the real app.
- **A web page can never open Cue's own pages or a local file**, in a tab, Peek, the AI panel or a pop-up (`protectPage` refuses it; Cue itself still loads `cue://` with `loadURL`). Extension pages lost their old exemption. Every `cue://` HTML page carries a strict CSP (`PAGE_CSP`): no inline scripts, ever, in `src/ui/pages`.
- **A page that never arrives shows `cue://offline`** (certificate errors say there is no way past); the tab keeps the site's address (`offlineSite`), so Reload and a restart go back to the site.
- **Links sent to Cue while the folder in front is locked wait** (`lockedPending`) and open after the passcode. Nothing at launch may throw past `pendingUrls`.
- **Sign-in pop-ups are tracked** (`openPopups`) and close when their folder locks or is removed; Vanish's close before the wipe.
- **Orders check who sent them**: `ui:cmd`/`ui:invoke` only from the sidebar (or the menu, which sends none), `vanish:cmd` only from Vanish's bar, `cue:internal` only from a `cue://` main frame, acting on that page's own folder; "open it anyway" only from the warning page about that site.
- Kept on purpose: `storage-access` is still allowed (Netflix and card sign-ins break without it), notifications still need no prompt, the teaching rig tools (`slots`, `show`, `take`, `front`, `volume`) ignore "AI paused" because the Stream Deck pedal uses them. Electron's relauncher waits for the old process, so there is no single-instance race on update.

## AI sites keep one account per folder (0.7.2, 13-Nov-2026)
Personal and School share sign-ins, and that used to include Claude, ChatGPT and Grok. People sign in to those with the folder's own Google account, so a sign-in in one folder overwrote the other's: School's Claude became jasonzac@gmail.com and School's own artifacts said "Sign in to view this page". AI sites are now in `TWO_ACCOUNTS` (`shared-logins.js`) beside Google and Meta; `test/audit.js` proves it with two real paired sessions. A folder still holding the other's copied session needs one sign-out and sign-in there, once.

## 0.7.3 (13-Nov-2026)
- **Link buttons** (start page and address bar): with nothing typed, or with the page's own address still selected in the box, each opens its site; typed words are still searched. Before, they did nothing, or searched the page's address.
- **Folder passcode is a switch** in Settings > Folders and accounts, "Ask for a passcode to open this folder", off by default. On asks for a new one, off asks for the current one.
- **Boards never sleeps** (`OWN_PAGE_AWAKE` in `mustStayAwake`; Library, Bills and Thumbnail check too) and keeps each picture's card, so coming back or switching boards does not reload pictures. `test/ui-fixes.js`.

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
- `src/main/whatsapp.js` + `src/main/gmail.js`: `cue_whatsapp` and `cue_gmail`, one call each, plain lines back.
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

## WhatsApp and Gmail for agents, as of 0.6.17 (11-Nov-2026)

- **Opening a chat.** `cue_whatsapp` types the name into WhatsApp's own search box (it filters
  again since 11-Nov; on 2-Nov it did not), clicks the matching row under "Chats" (then
  "Contacts"; never a "Messages" hit) and empties the box afterwards, every time, in a `finally`.
  If WhatsApp does not answer with its section headings, Cue walks the list instead and clicks the
  row the moment it is drawn. A phone number works as a name ("+91 85003 50600" or "8500350600");
  a number with no chat at all is opened with WhatsApp's `send?phone=` address, which reloads the
  tab, so it is refused on the tab he has in front of him.
- **The right chat, or an error.** Names are compared in FULL (letters and digits only, so emoji
  and the invisible U+202A/U+202C marks round numbers do not matter), never by prefix. The header
  name comes from `[data-testid="conversation-info-header-chat-title"]` with emoji pictures read
  back from their `alt`; the header's first line is the avatar's letter on a chat without a
  photo, which is how "Priyanshu" once read Parth's messages. Half a name is allowed only when it
  fits ONE chat; two candidates is an error that lists them. `read` checks the header again after
  reading, `send` checks it right before Send.
- **One job at a time per account, both accounts at once.** Calls for the same account queue,
  because one tab has one open chat. Personal and School are two tabs and run side by side.
- **Never in front of him.** Nothing in `whatsapp.js` or `gmail.js` calls `activate()`, focuses a
  window or raises one; only `status` with `show:true` does, for the one-time scan. Focusing the
  search box inside a background page is the page's business and does not move his keyboard.
  So Claude can work in the school's WhatsApp while he types in his own, and the other way round.
- **Waking a background tab** (`wake()` in main.js). A hidden tab gets no animation frames, no
  scroll events and, if never shown, no size: WhatsApp's list and Gmail's rows then do not draw.
  While an agent works in a tab it is SHOWN outside the window's visible area at its normal size
  (Chromium's view-size override supplies the size, since Chromium sizes a view by the part inside
  the window), with background throttling off. Fifteen seconds after the last call it is hidden
  again; if he opens the tab himself, `layout()` puts it in its normal place. Every agent tool
  goes through it (`needAwake` in agent-port.js). `incrementCapturerCount` is gone in Electron 44.
- **`cue_gmail`** (`src/main/gmail.js`): `search` (Gmail's own search words, up to 50 rows with
  sender, subject, snippet, date and an [id]) and `read` (every message of the thread, collapsed
  ones expanded; Gmail marks it read). It works in the agent's OWN Gmail tab of that folder, never
  his inbox: `openTab({ own: true })` skips the one-Gmail-per-folder rule, which used to hand
  agents his tab and leave it on their search. `cue_open` uses `own` too.

## Carrying sign-ins over from Chrome
Google and Meta both refuse a sign-in form typed into a browser they do not recognise. Chrome on
this Mac is signed in to Google, YouTube, Facebook and Instagram, and `carryFromChrome()` copies
those cookies into one folder. `signin.carry-all` does Google and Meta together, from a button per
folder in Settings. Instagram, Facebook and Threads MUST come over together — half a Meta session
is exactly what Meta's checks look for. Chrome keeps one Instagram and one Facebook account, so
the second account still needs a real sign-in, which is what the shield fix above made possible.

## Muted has to be a shape
Red already means on air, so mute cannot be a red dot. It is a crossed-out speaker badge on the
favicon and on the pinned app, and the pinned app dims. `test/folders.js` photographs the sidebar
and checks the badge is in the list AND on the pin — a pinned tab leaves the list, so proving both
needs two muted tabs.

## Meta's sites need Meta's own addresses
EasyPrivacy stops `instagram.com/ajax/bz` and `logging_client_events`. Those are Instagram's OWN
addresses, and `/ajax/bz` is where Meta plants the `mid` and `datr` device cookies. Without them a
sign-in reaches the code sent by text and then answers "there was a problem with your request"
forever, with nothing in the console to show for it. `NEVER_TOUCH` in `shield.js` now allows Meta's
sites on Meta's sites, scoped with `$domain=` so the pixel on someone else's page is still blocked.
`test/shield.js` holds both halves. Symptom to recognise: `document.cookie` on instagram.com has
`csrftoken` but no `mid` and no `datr`; Chrome's jar has `datr, mid, ig_did, sessionid`.

## Gmail when one Chrome profile holds both accounts
His Chrome keeps BOTH Google accounts signed in to one profile, so carrying the sign-in over brings
both, and `/mail/u/0/` is then whichever one Google feels like. `googleForFolder()` adds
`?authuser=<address>` — Google's own parameter, and it works for Gmail, Calendar, Drive and YouTube
alike. **The address does not go in the path**: `/mail/u/<address>/` answers `Temporary Error (404)`,
which is the trap I fell into first. A mailbox he names himself, or an existing `authuser`, is left
alone, and nothing outside Google's own hosts is touched. Applied in `navigate`, in `openApp` and in
`agentApi.open`, because all three open pages.

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
   On 4-Nov-2026 something on the Mac mini moved every fresh `build/Cue-darwin-arm64/Cue.app` to
   the Trash within about 90 seconds, mid-notarisation (cause not found). `ditto` the app into the
   session scratch folder first and notarise it there.
   Never re-sign an Electron build after packaging.
4. `~/.claude/skills/nsm-mac-app/scripts/nsm-publish.sh cue <version> <dmg> --notes "..."`
5. Push a `v<version>` tag. That builds Windows and Linux in GitHub Actions
   (`.github/workflows/build.yml`; not code-signed, smoke test must pass) AND it is where
   labs.nathanielschool.com reads Cue's version from, so without the tag the Labs page keeps
   showing the old release however the registry reads.
6. `nsm-publish.sh` does NOT write the Mac update feed. Write `cue-update.json` by hand
   (version, date, notes, sha256, size, the rolling `downloads/Cue.dmg` url; `size` must be exact, the app checks it) and
   `gh release upload downloads cue-update.json --repo jasonzacmusic/labs-downloads --clobber`.
   The Windows/Linux feed (`cue-feed.json`) is written and signed by CI on the tag; nothing to do by hand.
7. Check the registry really changed: `release.version` in `product-registry/registry.yaml`. The Windows and
   Linux links should be the fixed `releases/latest/download/Cue-win-x64.zip` and `Cue-linux-x64.tar.gz`.
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
- A Vanish page asking to share the screen is refused, but on some runs Chromium never calls Cue's handler and the page's request simply never answers (seen 12-Nov-2026, intermittent, same code passes and hangs). `test/vanish-settings.js` gives it 8 seconds and then fails that one check rather than hanging the suite. Cause not found.
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
- Protected video plays. Cue runs castLabs' Electron (`github:castlabs/electron-releases#v44.10.1+wvcus`), which carries Widevine; `components.whenReady()` in `src/main/main.js` sets `drmReady`, and the old "can't play its shows" notice in `src/main/video.js` only appears if that fails. The CDM is a Google-signed library, so the helper processes (and only the helpers) are signed with `scripts/entitlements.helper.plist`, which turns off library validation; Cue's own binary keeps it on. Netflix may still refuse until the app is VMP-signed with castLabs EVS, which needs a castLabs account. Dolby audio (E-AC3), AirPlay and casting aren't available.
- Vanish full screen fills the screen where the window already is (`setSimpleFullScreen`). A Mac's own full screen moved it to another desktop and could land on the main window.
- Passkeys need Apple's browser permission or our own Chromium build (Stage 2).
- The cache limit is per login, not per site.
- Vanish is hidden from screen sharing with Apple's normal setting. Some capture tools on recent macOS ignore it.
- Chrome extensions: simple ones work. Ones that need Chrome's toolbar APIs may not, until Stage 2.
- Windows passwords and sign-ins can't be moved in, because Chrome locks them to itself there.
- The bill reader works from each page's wording, so a redesigned billing page may need a new phrase in `bills.js`.

## Google sign-ins cannot be carried from Chrome (2-Nov-2026)

0.6.2 shipped a Settings button that copied Chrome's cookies into a folder. For Instagram and
Facebook that works. For Google it does not, and it did real damage: Google ties a session to the
one browser it was made in, so within the hour it revoked the copies AND the original, and both
folders landed on `accounts.google.com/CookieMismatch` reading "Signed out". Chrome itself was
untouched, which is what made it look like a Cue bug rather than a Google one.

There was a second fault underneath. `carryFromChrome` picks the Chrome profile holding the most
cookies for the site. His Chrome keeps BOTH Google accounts in one profile, so Personal and School
each received the same jar holding both accounts - the folders stopped meaning anything. The
`?authuser=` routing added the same day was papering over exactly that.

So: `carryAllFromChrome` carries Meta only. Google is signed into inside Cue, once per folder,
through `googleSignIn(identity)`, which opens Google's own AccountChooser with the folder's address
in `Email=`. Google accepts Cue's sign-in form now (the client-hints work in `chromeHints`), and
when it asks to "verify it's you" that is the account asking, not Google rejecting the browser.
`test/signin.js` pins both halves: Google must not appear in the carry, and a folder must be able
to open Google's own page as itself.

## Google refuses the dead jar, not Cue (2-Nov-2026)

Proved by probe (`test/signin.js` pins it): a clean Electron session reaches Google's
"Enter your password" step under a Chrome, Firefox or Safari identity alike. Google has no
quarrel with Cue's engine, and the UA/client-hint spoofing is not what decides it.

What Google refuses is a folder still holding the *cancelled* remains of the old Chrome
carry - on 2-Nov-2026 both folders held ~128 dead Google cookies, and that is what produced
`signin/rejected` and `CookieMismatch`. So `googleSignIn()` now calls `clearGoogleState()`
first: it empties that folder's Google cookies and origin storage, then opens Google's own
form. Never tell him Google rejects Cue by name - it does not.
