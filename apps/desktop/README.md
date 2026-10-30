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
  waiting for you, and raises a notification when a chat hands you the computer. It lists
  each computer too, and choosing one opens its window. Closing the window leaves Husk
  running; your chats keep their computers.
- **Works by keyboard.** Ctrl+Alt+Shift+H (Cmd+Option+Shift+H on a Mac) brings the
  keyboard to your computers: the notch while the window is minimized, else the corner.
  Tab moves between them, Enter opens one, and Escape goes back to where you were. On
  Linux, where the corner cannot take the keyboard, it opens the Computers window. A
  held screen shows a second ring while your keys go to the page. With reduced motion
  on, nothing in the corner, the notch or the window moves.
- **Keeps each chat's computer one click away.** A very small 3D iMac for each computer
  a chat is using stands on a small frosted tray in the bottom-right corner, facing you,
  its screen white. It never moves or shows a picture, so it never distracts: it glows
  amber only when the chat is waiting for you and teal while you hold it. Hover it for a
  tiny label with the chat app's name. Without WebGL it draws the same iMac flat.
- **Opens the Computers window when you click one.** One compact window
  whose tabs are your computers, each with its chat app's logo: the browser live on a
  white screen, and **Take over** or **Give back** beside what it is doing. Resize it,
  maximize it, or keep it on top (the pin). Closing it only hides it; the computers keep
  running. At first run Husk asks once whether to also open it by itself, without taking
  focus, the moment a chat starts using a computer; the tray changes that later. Taking
  over while the chat's AI is mid-call says which call it waits for to stop. On ssh and
  Fly computers, where every picture is a command that keeps the computer awake, the
  screen shows for a minute when you press **Look**, and all the time while you hold it.
- **Says what you hold.** While you hold a computer, the tray says so ("you hold 1"), with
  **Give back** for each. Closing the window or quitting while you hold one asks first,
  keeping the hold unless you choose to give it back; its chat stays paused until you do.
- **Says when Husk stops answering.** The tray says "Husk is not answering · trying again",
  and the Computers window says so over a cleared screen, offering nothing that needs Husk.
  The app starts Husk again, and after a start that fails waits two seconds before the
  next, twice as long each time after that, up to a minute. Everything comes back when
  Husk does.
- **Minimizes to the notch.** The minimized window becomes its computers' logos in a black
  capsule hanging from the top of the screen: around the notch on a Mac that has one,
  centred on Windows and Linux. Click a logo to open that tab; hover to see what each
  computer is doing. Clicks around the corner and the notch reach the windows under them,
  on Linux too. Both follow your main screen when screens are added, removed or resized,
  and a Computers window left on a screen that went away comes back.
- **Real logos.** Claude, Cursor, Gemini, Zed and Windsurf use their marks from
  [simple-icons](https://simpleicons.org) (CC0). VS Code shows its own installed app icon,
  and Codex a monogram until its mark is added.
- These windows are the console's own small views (`apps/console/src/desktop`), so they
  need no login of their own. They talk to the app through one preload
  (`src/preload.cjs`) that exposes a state stream and a short list of requests, each
  checked against the window that sent it (`src/computers.mjs`). The tray turns each part
  on or off.
- **Updates itself.** It looks for a new version on GitHub Releases as it starts, and
  every six hours. Where the platform checks the new version's signature against this
  one's, it downloads in the background, and **Restart to update** in the tray installs
  it; your chats keep their computers. That is a signed Windows build, or a Mac app with
  a Developer ID. Elsewhere, an unsigned build or Linux, the tray and a notification
  say a new version is out, with its page.
- **Start at login** is a tray menu option, off by default.
- **Quit** leaves Husk running for your chats. **Quit and stop Husk** stops it too.
  Closing the Husk window only hides it, so a command running in its Terminal keeps
  running. On a Mac, the Dock icon brings it back.

It never adds Husk to a chat app on its own: that happens only on the Connect page, when
you click. The one edit it makes by itself keeps those entries pointing at the app. When
the app updates or moves, a chat app whose entry starts an older copy of it starts the
new one, keeping the flags you gave it. An entry you pointed elsewhere, such as `npx`,
is never touched.

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

Built this way, the installers come out unsigned: Windows SmartScreen and macOS
Gatekeeper warn on them. A release signs them (`release.yml`'s `desktop` job), with an
Apple Developer ID and a Windows code-signing certificate the maintainer sets as
secrets. They are never in this repository. See
[the desktop installers](../../docs/RELEASING.md#the-desktop-installers).

## Checked

On Windows 11 on ARM: the packaged app starts its bundled Husk, opens the console signed
in, and shuts down cleanly in smoke mode. The app binary run as Node starts the MCP server
over stdio (initialize, then 34 tools listed). The `desktop` workflow builds and
smoke-tests it on Windows, macOS and Linux.

Not yet checked by a person: the tray, notifications and Start at login on each platform,
and a chat app connected to the installed app's binary. Nor these, which CI cannot see:

- **Windows:** a chat's call opens a minimized Computers window without taking focus from
  what you are typing in. Ctrl+Alt+Shift+H gives the keyboard to the corner, and Escape
  gives it back.
- **macOS:** after the window is minimized to the notch, Husk is still in the Dock and in
  Cmd-Tab (`lsappinfo info -only ApplicationType Husk` says `Foreground`), and the notch
  still floats over a full-screen app. Cmd+Option+Shift+H gives the keyboard to the notch.
- **Linux:** with the app's own flags (not the smoke run's), the corner and the notch are
  transparent, and clicks around them reach the window under them.
- **Two screens:** unplug the screen the Computers window is on, and it comes back on the
  main screen; the corner and the notch move with the main screen.
- **The Terminal:** start `sleep 60; echo done` in the console's Terminal, close the window,
  open it from the tray, and `done` arrives.
- **Updates, on Windows and macOS:**
  - install a signed build of the previous release, then publish the next one;
  - the tray offers **Restart to update**, the app comes back as the new version, and a
    chat it connected still gets its computer;
  - an unsigned build only says the new version is out.
