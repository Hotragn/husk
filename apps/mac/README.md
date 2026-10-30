# Husk Bar (macOS)

A menu-bar companion for a local Husk server.

- **Menu-bar icon, on every Mac.** It shows how many computers are running, and turns
  orange with "Waiting for you" when a handoff needs you. Its menu lists each computer
  with its app and chat label, with **Open** and **Take over**.
- **The notch pill, on Macs with a notch.** A pill sits under the notch: hidden when
  nothing runs, "1 computer" while one runs, amber "Waiting for you" on a handoff.
  Hovering over it expands it into the list. On external displays and Macs without a
  notch there is no pill; the menu-bar icon covers it. While the Husk desktop app runs,
  its own notch shows the computers and Husk Bar's pill makes way: one notch, not two.

It reads `GET /v1/overview` from the local server every 3 seconds. It finds the shared
Husk the way the desktop app and your chats do, from the record the shared Husk writes
as it starts (`~/.husk/daemon.json`, or `$HUSK_HOME/daemon.json`), read again on every
poll, since a Husk that restarted has a new token. `HUSK_URL` and `HUSK_TOKEN`, when
set, win, as the CLI and SDK read them. It talks only to a loopback address, stores
nothing, and never asks for credentials. It needs no Full Disk Access, Accessibility or
screen-recording permission. **Open** and **Take over** open the console in your
browser, without the token in the URL.

## What CI proves, and what it can't

The `mac` workflow runs on GitHub's `macos-latest` runner for every change under
`apps/mac/`. It runs `swift build`, `swift test`, `xcodebuild -scheme HuskBar`, and
`scripts/bundle.sh`, and uploads the unsigned `Husk Bar.app` as an artifact. The tests
cover:

- computer and handoff states, and the pill text;
- choosing the notch or the menu-bar fallback from given screen geometry;
- reading `HUSK_URL` and `HUSK_TOKEN`, and refusing a non-loopback server;
- finding the shared Husk from its record, with the environment winning when set;
- the pill making way for the desktop app;
- decoding the overview.

CI cannot show how the notch pill looks and feels on real hardware: its position against
a real notch, hover and expand, and behaviour as displays come and go. That is what the
checklist below is for, run on a Mac.

## Build

Requires Xcode 15 or later (Swift 5.9) on macOS 13 or later. From a clean checkout:

```bash
cd apps/mac
swift test
```

```bash
xcodebuild -scheme HuskBar -destination 'platform=macOS' -configuration Release -derivedDataPath .build/xcode build
```

```bash
sh scripts/bundle.sh
```

```bash
open "build/Husk Bar.app"
```

`swift test` runs the logic tests (pill text, loopback-only config, overview decoding,
notch geometry). `xcodebuild` builds the app target from `Package.swift`; there is no
`.xcodeproj` to keep in sync. `open` launches the bundled app.

A GUI app does not inherit your shell's environment. The shared Husk needs nothing from
it. If you run a server of your own with `HUSK_TOKEN` or a non-default `HUSK_URL`, launch
Husk Bar from a terminal that has them set, for example
`HUSK_TOKEN=... open "build/Husk Bar.app"`, or set them with `launchctl setenv`.

## Test checklist

Against a real `husk serve`, with Docker running:

- [ ] With no server running, the menu says Husk is not running and there is no pill.
- [ ] Against a Husk older than this branch (no `/v1/overview`), the menu says to update it.
- [ ] With the server running and no computers, the menu says "No computers yet" and
      there is no pill.
- [ ] Start one computer (`husk up`): the icon shows "1 computer"; on a notched
      MacBook the pill shows "1 computer" under the notch, centred.
- [ ] Start a second: both read "2 computers".
- [ ] Open a handoff (run a husk with `hand_off`, or call `hand_off` from a chat): the
      icon turns orange, the pill turns amber with "Waiting for you", and the menu shows
      the reason under that computer.
- [ ] **Take over** opens the console's Handoffs panel; pressing Done there returns both
      to the running state within a few seconds.
- [ ] Hovering over the pill expands it into the list; moving away collapses it.
- [ ] Plug in an external display and make it the main one: the pill stays on the
      built-in display, or disappears if the lid is closed. Unplug: it comes back.
- [ ] On a Mac without a notch (or an external display only), there is no pill and the
      icon and menu still work.
- [ ] Set `HUSK_URL=http://example.com:7377`: the menu says the address is not loopback
      and no request is made (check with Little Snitch or `nettop`).
- [ ] With `HUSK_TOKEN` set on the server and not in the app's environment, the menu says
      Husk refused it, and nothing crashes.
- [ ] With the shared Husk a chat started (no environment at all), the icon and the pill
      follow it; quit it and let a chat start it again, and they follow the new one.
- [ ] Start the Husk desktop app: Husk Bar's pill goes away while the app's notch shows
      the computers. Quit the app: the pill comes back.
- [ ] System Settings > Privacy & Security shows no new permission requests.
- [ ] Quit from the menu works; Activity Monitor shows HuskBar using next to no CPU.

## Signing and notarization (release steps)

Not set up. Nothing here needs, or contains, a certificate or secret. Shipping a build
others can open without a Gatekeeper warning needs an Apple Developer account, and the
account holder runs these steps:

1. In Xcode, or with a Developer ID Application certificate in the login keychain, sign
   the bundle with the hardened runtime:
   `codesign --force --options runtime --timestamp --sign "Developer ID Application: <name> (<team>)" "build/Husk Bar.app"`
2. Zip it and submit it for notarization with a stored keychain profile:
   `ditto -c -k --keepParent "build/Husk Bar.app" HuskBar.zip`
   `xcrun notarytool submit HuskBar.zip --keychain-profile <profile> --wait`
3. Staple the ticket: `xcrun stapler staple "build/Husk Bar.app"`.
4. Check it: `spctl --assess --type execute --verbose "build/Husk Bar.app"`.

Apple's references:
- [Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)

The keychain profile is created once with `xcrun notarytool store-credentials` and stays
in the keychain; it is never committed.
