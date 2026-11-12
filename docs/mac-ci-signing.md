# What a macOS signing job in CI would need

Today the Mac build is made, signed and notarised by hand on a Mac (CLAUDE.md, "Releasing"),
and its update feed `cue-update.json` on the `downloads` release of
`jasonzacmusic/labs-downloads` is written by hand. No CI job does any of it, because none of
the secrets below exist in GitHub. This file lists exactly what a `macos-latest` job would need
before it could replace the hand steps. Nothing here is set up.

## Secrets (repository: jasonzacmusic/cue)
| Secret | What it is |
|---|---|
| `MAC_CERT_P12` | base64 of the "Developer ID Application: … (R3UNCZH45H)" certificate **with its private key**, exported as .p12 |
| `MAC_CERT_PASSWORD` | the .p12 export password |
| `MAC_KEYCHAIN_PASSWORD` | any random string, for the throwaway keychain the job creates |
| `APPLE_API_KEY_P8` | an App Store Connect API key (.p8) with the Developer role, for `notarytool` |
| `APPLE_API_KEY_ID` | that key's id |
| `APPLE_API_ISSUER` | the issuer id of the App Store Connect team |
| `LABS_DOWNLOADS_TOKEN` | a fine-grained token with contents:write on `jasonzacmusic/labs-downloads`, to upload `Cue.dmg` and `cue-update.json` (the job's own `GITHUB_TOKEN` cannot write to another repo) |

## Steps the job would run
1. `security create-keychain` / `set-keychain-settings` / `unlock-keychain` with
   `MAC_KEYCHAIN_PASSWORD`; `security import` the .p12; `security set-key-partition-list
   -S apple-tool:,apple:,codesign:` so `codesign` can use it without a prompt.
2. `npm ci`, then `npm run dist:mac` (scripts/build-mac.js already signs with
   `@electron/osx-sign`, the hardened runtime and `scripts/entitlements*.plist`; it must find
   the identity in the throwaway keychain). Keep the size budget check.
3. Notarise and staple the app **without re-signing it**
   (`xcrun notarytool submit --key … --key-id … --issuer … --wait`, then `xcrun stapler staple`),
   build the DMG, notarise and staple the DMG, as `nsm-notarize.sh --no-resign --dmg` does by hand.
4. Verify exactly what the updater verifies:
   `spctl -a -t exec Cue.app` and
   `codesign --verify --deep --strict -R='identifier "com.jasonzac.cue" and anchor apple generic and certificate leaf[subject.OU] = "R3UNCZH45H"' Cue.app`.
5. Write `cue-update.json` in the **old shape, unchanged**: `{ app, version, date, notes,
   sha256, size, url }`, with `url` = the rolling
   `https://github.com/jasonzacmusic/labs-downloads/releases/download/downloads/Cue.dmg`
   and `size`/`sha256` of that exact DMG (the updater now checks `size`, so it must be right).
6. `gh release upload downloads Cue.dmg cue-update.json --clobber --repo
   jasonzacmusic/labs-downloads` with `LABS_DOWNLOADS_TOKEN`.
7. Delete the throwaway keychain (`security delete-keychain`) in an `always()` step.

## Things to decide before switching it on
- The runner must be Apple silicon (`macos-14` or later) to build the arm64 app.
- Every Cue 0.6.18+ Mac in the field reads that feed; a bad CI run would reach them all. Keep
  the hand steps until a CI-built DMG has passed `node test/update.js` (with `CUE_OLDER_DMG`)
  on a real Mac.
- The castLabs Widevine (VMP) signing, if ever added, needs a castLabs EVS account and is a
  separate step before Apple signing.
