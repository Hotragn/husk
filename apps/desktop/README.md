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
- **Puts each chat's computer on your screen.** When a chat starts using a computer, a
  small window opens in the bottom-right corner without taking the keyboard: the
  computer's browser live and edge to edge, its tabs by name, and **Take over** or **Give
  back** in the title bar. Resize it, maximize it, or keep it on top (the pin). Closing it
  only hides it; the computer keeps running.
- **Stands a small 3D computer for each one** in the corner. Its screen shows that
  computer's browser, it glows amber when the chat is waiting for you and teal while you
  hold it, and hovering it names the chat. Click it to show or hide the window. Without
  WebGL it draws flat computers instead.
- **Minimizes to the notch.** A minimized window becomes its chat app's logo in a black
  capsule hanging from the top of the screen: around the notch on a Mac that has one,
  centred on Windows and Linux. Hover it to see what each computer is doing, with a live
  thumbnail, and open or close it from there.
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
