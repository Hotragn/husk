# Husk for the desktop

A download for people who would rather not use a terminal. It is Husk itself, not a new
product: the shared Husk every chat goes through, its console in a window, and a tray icon
that tells you when a chat is waiting for you.

## What it does

- **Runs Husk with nothing else installed.** The app carries its own copy of Husk and runs
  it with Electron's built-in Node, so neither the app nor your chat apps need Node.
- **Opens the console on Connect the first time.** Pick where your chats' computers run and
  click Connect next to each chat app. When the app connects one, the chat app is pointed
  at the app's own binary (`Husk.exe` with `ELECTRON_RUN_AS_NODE=1`), not at `npx`.
- **Sits in the tray.** It shows how many computers are running and how many chats are
  waiting for you, and raises a notification when a chat hands you the computer. Closing
  the window leaves Husk running; your chats keep their computers.
- **Keeps each chat's computer one click away.** A very small 3D iMac for each computer
  a chat is using stands on a small frosted tray in the bottom-right corner, facing you,
  its screen white. It never moves or shows a picture, so it never distracts: it glows
  amber only when the chat is waiting for you and teal while you hold it. Hover it for a
  tiny label with the chat app's name. Without WebGL it draws the same iMac flat.
- **Opens the Computers window when you click one, and only then.** One compact window
  whose tabs are your computers, each with its chat app's logo: the browser live on a
  white screen, and **Take over** or **Give back** beside what it is doing. Resize it,
  maximize it, or keep it on top (the pin). Closing it only hides it; the computers keep
  running. "Open the window when a chat starts using a computer" is in the tray, off.
- **Minimizes to the notch.** The minimized window becomes its computers' logos in a black
  capsule hanging from the top of the screen: around the notch on a Mac that has one,
  centred on Windows and Linux. Click a logo to open that tab; hover to see what each
  computer is doing.
- **Real logos.** Claude, Cursor, Gemini, Zed and Windsurf use their marks from
  [simple-icons](https://simpleicons.org) (CC0). VS Code shows its own installed app icon,
  and Codex a monogram until its mark is added.
- These windows are the console's own small views (`apps/console/src/desktop`), so they
  need no login of their own. They talk to the app through one preload
  (`src/preload.cjs`) that exposes a state stream and a short list of requests, each
  checked against the window that sent it (`src/computers.mjs`). The tray turns each part
  on or off.
- **Start at login** is a tray menu option, off by default.
- **Quit** leaves Husk running for your chats. **Quit and stop Husk** stops it too.

It never edits a chat app's settings on its own. That happens only on the Connect page,
when you click.

The window shows only the console. Any other link opens in your default browser, if it is
a web link at all. The window has no Node access (`contextIsolation`, `sandbox`).

## Build it

From the repository root:

```bash
npm ci && npm run build
cd apps/desktop
npm ci
npm test            # the app's decisions, with no window
npm run stage       # pack Husk's packages into build/runtime
npx electron-builder --publish never
npm run smoke       # start the packaged app, check the console loads and two computers land on the screen, quit
```

`npm start` runs it from the checkout, using the monorepo's own build instead of a staged
copy. Logs go to `~/.husk/desktop.log` and `~/.husk/daemon.log`.

The installers come out unsigned: Windows SmartScreen and macOS Gatekeeper warn on them.
Signing needs an Apple Developer ID and a Windows code-signing certificate, which belong
to the maintainer and are not in this repository.

## Checked

On Windows 11 on ARM: the packaged app starts its bundled Husk, opens the console signed
in, and shuts down cleanly in smoke mode. The app binary run as Node starts the MCP server
over stdio (initialize, then 32 tools listed). The `desktop` workflow builds and
smoke-tests it on Windows, macOS and Linux.

Not yet checked by a person: the tray, notifications and Start at login on each platform,
and a chat app connected to the installed app's binary.
