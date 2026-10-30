# Cue

**The browser for people who make things.** Musicians, teachers, YouTubers, editors, designers.
Free and open source, from [Nathaniel Labs](https://apps.nathanielschool.com) at Nathaniel School of Music.

Cue is built on Chromium (through Electron), so every site works the way it does in Chrome.
On top of that it adds the things creators reach for every day.

## What it does

- **A volume knob on every tab.** Hover the speaker on any tab and drag. A tab that is too loud
  comes down without touching the page. Mute and play/pause sit right on the tab, no right-click.
- **One player at a time.** Start a YouTube video and the other tab that was playing pauses.
- **Your accounts, kept apart.** Personal and School logins live side by side in separate
  containers, so two Gmails and two Instagrams stay signed in. Vanish tabs keep nothing at all.
- **Tabs that sort themselves.** Nathaniel School, AI & Subscriptions (with billing pages),
  Google & YouTube, Social, Code. Drag to reorder; collapse a group; mute a group.
- **Split views.** Two side by side, top and bottom, three columns, or a grid of four, with
  synced scrolling.
- **Preview and On Air.** Cue a tab, press TAKE, and it goes to the *Cue Stage* window at 1920×1080.
  Share that window in Zoom, Meet or OBS; the audience never sees you hunting for tabs. Cue can
  also switch OBS scenes for you (obs-websocket).
- **Pop any tab into its own window**, titled `Cue · <page>`, so Zoom's share picker lists it by name.
- **Original sound** for music teaching: turns off echo cancel, noise cut and auto-volume on the mic.
- **Safe share.** Emails, phone numbers, prices and keys blur on the tab that is on air.
- **Search the way creators search.** Type `yt`, `i` (Google Images), `p` (Pinterest), `gh`,
  `c` (Claude) or `gpt` before your words. Right-click any image for Google Lens.
- **Built for AI agents.** A local, token-protected door (port 8813) and an MCP server let Claude
  Code, Codex and other AI tools open tabs, read, click and type, using your logins, without
  touching your private tabs or the tab that is on air. Every call is logged.
- **Ad and tracker blocking** built in, except on YouTube, which is left exactly as it is in Chrome. Idle tabs sleep after 30 minutes and unused ones archive after a week.
- **Spaces.** Teach, Create, Business and Build each keep their own tabs, usual login and layout.
- **Move in.** Bookmarks, history, open tabs, passwords and sign-ins from Helium, Chrome, Brave, Edge and Arc (bookmarks from Safari). The old browser is left untouched.
- **Passwords** kept with your computer's keychain, per login, with optional auto sign-in per site. Never for Vanish tabs or AI agents.
- **⌘K finds anything.** Tabs in every Space, history, bookmarks, Boards, NSM apps, GitHub repos and commands.
- **Peek.** Alt-click a link to read it in a side panel without leaving your page.
- **Claude and ChatGPT side panel** with your own accounts. Ask about the page you are on.
- **Bills radar and alert tray.** Reads billing pages for due dates and failed cards, warns before you are charged, and gathers notifications in one place. During a live class they are held back.
- **Music kit.** Speed without changing pitch, A-B loop and transpose on any video.
- **Video kit.** Whole-page pictures, tab recording with clean tab sound, GIFs, timestamp links and frame grabs.
- **Designer kit.** Colour picker, palette from any image, font finder, ruler and Boards that keep every image's source.
- **Creator kit.** Thumbnail check, shown the way viewers see it, plus YouTube Studio shortcuts.
- **Downloads shelf** sorted by type, with a warning before a big download on a nearly full disk.
- **Vanish tabs** keep nothing on disk and ask before saving a download. The test suite scans the disk to prove it.
- **Kits you can switch off.** Chrome extensions can be copied in from your other browsers.

## Use Cue with Claude Code or Codex

```bash
claude mcp add cue -- node /Applications/Cue.app/Contents/Resources/app.asar.unpacked/bin/cue-mcp.js
```

Or point any MCP client at `bin/cue-mcp.js`. Cue must be running. Tools are named `cue_*`
(`cue_identities`, `cue_tabs`, `cue_open`, `cue_read`, `cue_snapshot`, `cue_click`, `cue_type`,
`cue_screenshot`, …).

## Build from source

```bash
npm install
npm start            # run it
npm test             # in-app test against real sites
npm run dist:mac     # signed Cue.app in build/
```

Windows and Linux builds come from GitHub Actions and are not code-signed yet. The Linux build may
need `--no-sandbox`. Limits today: no passkeys, the cache cap is per login rather than per site, and
Chrome extensions that rely on Chrome's own toolbar may not work.

## Licence

GPL-3.0-or-later. Copyright Nathaniel School of Music.
