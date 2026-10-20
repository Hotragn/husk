# Husk Bar (macOS)

A menu-bar companion for a local Husk server.

- **Menu-bar icon, on every Mac.** It shows how many computers are running, and turns
  orange with "Waiting for you" when a handoff needs you. Its menu lists each computer
  with its app and chat label, with **Open** and **Take over**.
- **The notch pill, on Macs with a notch.** A pill sits under the notch: hidden when
  nothing runs, "1 computer" while one runs, amber "Waiting for you" on a handoff.
  Hovering over it expands it into the list. On external displays and Macs without a
  notch there is no pill; the menu-bar icon covers it.

It reads `GET /v1/overview` from the local server every 3 seconds. It talks only to a
loopback address, reads `HUSK_URL` and `HUSK_TOKEN` from its environment the way the CLI
and SDK do, stores nothing, and never asks for credentials. It needs no Full Disk
Access, Accessibility or screen-recording permission. **Open** and **Take over** open
the console in your browser, without the token in the URL.

> This was written on Windows and has not been built or run on a Mac yet. Treat the
> steps below as the first test, and the checklist as what to confirm.

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

A GUI app does not inherit your shell's environment. If your server uses `HUSK_TOKEN` or
a non-default `HUSK_URL`, launch it from a terminal that has them set, for example
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
      Husk asks for a token, and nothing crashes.
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
