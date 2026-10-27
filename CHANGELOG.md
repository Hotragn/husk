# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file records what changed for people who installed the packages. Repository
housekeeping — CI, workflows, README edits, branch cleanup — lives in the commit log,
not here.

## [Unreleased]

### Added

- **Workspaces.** Named local workspaces keep the public sources you add and the
  results your chat writes, with a viewer, downloads and ZIP export. They need no
  Docker and no extra API key. `--profile starter` serves the workspace tools only; it is
  what the Claude Desktop extension uses
  ([#151](https://github.com/Hotragn/husk/pull/151)).
- **Hand-offs.** `hand_off` and `hand_off_done` give you the computer for a login, a 2FA
  code or a CAPTCHA, and give it back only when you say so
  ([#164](https://github.com/Hotragn/husk/pull/164)). Every chat gets its own computer,
  which is kept until you delete it
  ([#165](https://github.com/Hotragn/husk/pull/165)).
- **The computer card.** In apps that render MCP Apps, the chat shows its computer's state
  and a link ([#166](https://github.com/Hotragn/husk/pull/166)).
- **The console's Home** is an overview of every computer
  ([#167](https://github.com/Hotragn/husk/pull/167)).
- **Husk Bar**, a macOS menu-bar and notch companion
  ([#168](https://github.com/Hotragn/husk/pull/168)).
- **One shared Husk for every chat on the machine.** Each chat's tools go through it, so
  the console shows every chat's computer, its live browser and what it did last
  ([#175](https://github.com/Hotragn/husk/pull/175)). Each chat's computer has its own
  page, with the live browser, its activity, Take over and Make this a bot
  ([#176](https://github.com/Hotragn/husk/pull/176)).
- **`husk setup`** picks where computers run, connects your chat apps and starts the
  shared Husk. The console's Connect page does the same
  ([#177](https://github.com/Hotragn/husk/pull/177)).
- **The desktop app** carries its own Node and keeps each chat's computer one click away:
  - a corner of small computers;
  - a Computers window whose tabs are your computers;
  - a notch when it is minimized;
  - a tray that tells you when a chat is waiting.

  Each release attaches its installers for Windows, macOS and Linux, signed and
  notarized when the release has the signing keys
  ([#178](https://github.com/Hotragn/husk/pull/178),
  [#185](https://github.com/Hotragn/husk/pull/185),
  [#231](https://github.com/Hotragn/husk/pull/231)).
- **The desktop app updates itself.** A signed build looks on GitHub Releases at start and
  every six hours, downloads in the background, and **Restart to update** in the tray
  installs it. Husk keeps running, so chats keep their computers. An unsigned build, or
  Linux, only says a new version is out. Chat apps that start the app's Husk follow it
  when it updates or moves, keeping their flags and computer choice; an entry you pointed
  elsewhere is left alone ([#232](https://github.com/Hotragn/husk/pull/232)).
- **The desktop app says when Husk stops answering.** The Computers window shows a banner
  and clears its screen, the tray, the corner and the notch say so too, and Take over
  waits until Husk is back. The app starts Husk again, waiting longer after each failed
  start, up to a minute ([#225](https://github.com/Hotragn/husk/pull/225)).
- **The corner and the notch work by keyboard.** Ctrl+Alt+Shift+H (Cmd+Option+Shift+H on
  a Mac) hands them the keyboard, and the tray lists every computer. With reduced motion
  on, nothing pulses or flies in ([#226](https://github.com/Hotragn/husk/pull/226)).
- **The desktop app on every platform and screen.** On Linux, clicks pass through around
  the corner and the notch. They follow the main screen as screens come and go, and a
  Computers window left on no screen comes back. On a Mac, minimizing to the notch keeps
  the Dock icon; on Windows, a chat reopening the window no longer takes focus from what
  you are typing. Closing the console window keeps its Terminal running
  ([#227](https://github.com/Hotragn/husk/pull/227)).
- **Bots on your own Claude Code or Codex.** A husk's `engine` is `builtin`, `claude-code`
  or `codex`. A CLI engine runs your installed CLI headless, under your own login, with
  Husk's tools and nothing else: no built-in shell or file tools, no other MCP server, no
  project's settings, and for Codex a read-only sandbox. A Claude Code bot can go on with a
  chat (`engine.resume`): each run is a fork of it, on the chat's own computer, and the chat
  itself is never written to ([#238](https://github.com/Hotragn/husk/pull/238)).
- **Every chat app can become a bot.** Make this a bot reads Claude Code and Codex chats
  back by themselves. **Husks › Make a bot from a chat** takes a chat found on this
  computer, an export or pasted text, and asks which chat when a file holds many. Codex
  rollouts import, and a draft runs on the chat's own app when it is installed
  ([#239](https://github.com/Hotragn/husk/pull/239)).
- **A job host for bots' triggers.** Schedules, webhooks and chat-app triggers run in a
  process of their own, which the shared Husk starts when a bot has a trigger and which
  leaves once none has; a trigger keeps the shared Husk's address and token
  ([#235](https://github.com/Hotragn/husk/pull/235)).
- **Take over at any moment**, from the console, the desktop app or a chat's link
  ([#180](https://github.com/Hotragn/husk/pull/180),
  [#182](https://github.com/Hotragn/husk/pull/182)).
- **A faster browser.** One long-lived driver per computer, and a pushed live screen.
  `browser_run` does several steps in one call
  ([#181](https://github.com/Hotragn/husk/pull/181)), and `browser_script` runs a short
  Python script with control flow inside the computer
  ([#184](https://github.com/Hotragn/husk/pull/184)).
- **Take-over stops the AI where it is.** Taking a computer stops the AI's calls running
  on it, browser scripts included, and every route that changes the computer refuses a
  program while you hold it; a husk run obeys it too. After Give back, a browser action
  on a page you changed is refused until the AI looks again
  ([#192](https://github.com/Hotragn/husk/pull/192), [#194](https://github.com/Hotragn/husk/pull/194), [#195](https://github.com/Hotragn/husk/pull/195)).
- **Holds only you end.** A take-over survives a restart of the shared Husk, and only your
  Give back ends it: from the console, the desktop app, the tray or the link you took it
  with. A sign-in handoff a chat asked for still ends with its "done". While you hold a
  computer its browser stays open, the tray says so, and quitting asks first
  ([#207](https://github.com/Hotragn/husk/pull/207), [#208](https://github.com/Hotragn/husk/pull/208), [#209](https://github.com/Hotragn/husk/pull/209)).
- **The window opens as a chat starts working**, without taking focus, if you said yes
  when the desktop app first asked; a take-over says which call it is waiting for
  ([#204](https://github.com/Hotragn/husk/pull/204)).
- **Honest clicks.** A click on something covered, disabled, hidden or still moving, or a
  role and name that match two elements, is refused, saying why; `force` clicks anyway
  ([#211](https://github.com/Hotragn/husk/pull/211)).
- **Refs that expire, and frames.** A ref acts only on the document whose snapshot showed
  it, so a ref from an earlier page is refused rather than landing on whatever has its id
  now ([#213](https://github.com/Hotragn/husk/pull/213)). A snapshot reads every frame, cross-site ones included, with refs like
  `f2e7`, and typing, clicks, hover, scroll and upload reach into them ([#216](https://github.com/Hotragn/husk/pull/216)).
- **Dialogs, downloads and new tabs.** A dialog is answered the moment it opens and the
  result says so; a confirm is dismissed unless the call passes `dialog: "accept"`. A
  download lands in `/work/downloads`, and a tab a page opens is named with its id, so
  switching to it is one call ([#215](https://github.com/Hotragn/husk/pull/215), [#223](https://github.com/Hotragn/husk/pull/223)).
- **Fewer turns.** Every browser result ends with where the page is. A snapshot can be of
  one part of the page, and `browser_click` and `browser_type` take `waitFor`, watched
  from just before they act. A call on a computer you hold opens with `E_COMPUTER_HELD`
  ([#220](https://github.com/Hotragn/husk/pull/220)).
- **A benchmark against Playwright MCP** on the same computer and Chromium, published in
  every e2e run's summary, with the latest numbers in [docs/BENCHMARK.md](docs/BENCHMARK.md)
  ([#223](https://github.com/Hotragn/husk/pull/223)).
- **Strict network enforcement.** `strict: true` under `computer.network`, or
  `husk-mcp --network-strict`, refuses a provider that cannot enforce the policy for every
  process. Without it, Husk says what is not enforced ([#219](https://github.com/Hotragn/husk/pull/219)).
- **Zed.** `husk setup` and the Connect page connect it, keeping the comments its settings
  start with ([#243](https://github.com/Hotragn/husk/pull/243)).
- **Long calls in every chat app.** Most apps give up on a tool call after a while, such as
  Claude Desktop after 240 s and Zed after 60 s. Husk now answers first: the call says it
  is still running and goes on in the computer, and `job_wait` collects its result
  ([#243](https://github.com/Hotragn/husk/pull/243)).
- **The chat apps' support matrix**, in [docs/clients.md](docs/clients.md). For each app,
  it gives how the app gets Husk, what it supports and its limits, with sources. The e2e
  run checks every app ([#243](https://github.com/Hotragn/husk/pull/243)).
- **Chat apps on the web.** `husk serve --remote --public-url https://<name>` lets claude.ai
  and ChatGPT use Husk through a tunnel you run, or from a Fly app of your own
  ([#245](https://github.com/Hotragn/husk/pull/245), [#247](https://github.com/Hotragn/husk/pull/247), [#248](https://github.com/Hotragn/husk/pull/248)).
  - It is for one owner, who claims it once with a code printed on the machine and signs
    in with a passkey after that.
  - Commands, file changes and browser actions wait for the owner's passkey, on a page
    that shows exactly what they send.
  - The console's Connect page and header, and Husk Bar, show whether it is on. The
    Connect page and `husk remote` switch it off and sign apps out.
  - It will not start while a high or critical security advisory stands against the
    install.
  - The guide is *Chat apps on the web* in the docs. The Fly provider now also takes its
    token from `HUSK_FLY_TOKEN`.
- **`husk rm --erase`** erases what a chat's or a bot's computer keeps on Docker and
  Podman, its files and browser logins, as the console's Delete does
  ([#259](https://github.com/Hotragn/husk/pull/259)).

### Changed

- **Chats get the image with the browser by default**, and setup pulls it with its
  progress, so a chat's first page does not wait on a 2 GB download mid-call
  ([#201](https://github.com/Hotragn/husk/pull/201)).
- **`auto` leaves paid Fly out** unless `HUSK_AUTO_FLY=1`; `--provider fly` always works.
  A chat's computer on another provider than the one asked for is kept, and the chat is
  told ([#203](https://github.com/Hotragn/husk/pull/203)).
- **Setup pins a version range** (`@husk-ai/mcp@~0.2`), and the shared Husk speaks a
  protocol version, so a later release that speaks another cannot start under it
  ([#196](https://github.com/Hotragn/husk/pull/196)).
- **Coming from 0.1.4**, setup and the Connect page move each chat app's `husk` entry to
  this release, keeping the flags and env you gave it, Claude Code's per-project entries
  included. Computers, named sessions, their files and your bots carry over as they are
  ([#205](https://github.com/Hotragn/husk/pull/205)).
- **Only the shared Husk stops a chat's computer**, after ten idle minutes, and never one
  you hold ([#197](https://github.com/Hotragn/husk/pull/197)).
- **An ssh or Fly computer's screen shows when you ask.** Each picture there is a command
  on the computer, which kept it awake: **Look** shows it for a minute, and a computer you
  hold shows all the time. Docker, Podman and local push their screen as before
  ([#228](https://github.com/Hotragn/husk/pull/228)).
- **Bots wait out a take-over.** A chat is told to stop when you take its computer; a bot,
  with nobody to tell, waits until you give it back, says so once in its run, and goes on.
  A cancel or its timeout still ends it ([#240](https://github.com/Hotragn/husk/pull/240)).
- **The built-in engine ships with every install**, the desktop app included, so a bot
  runs on any model, a local Ollama among them, with no CLI install
  ([#234](https://github.com/Hotragn/husk/pull/234)).
- **The desktop app gives its Husk your login shell's PATH**, so a Mac app opened from the
  Finder finds `docker`, `claude` and `codex` ([#238](https://github.com/Hotragn/husk/pull/238)).
- **Setup changes a chat app's file in place.** Only Husk's own entry changes, and the rest
  of the file keeps its layout. Windsurf is listed as Windsurf (Devin Desktop), whose two
  agents read the same file. Codex, Gemini CLI and Claude Desktop's Code tab are named on
  the computers they make ([#243](https://github.com/Hotragn/husk/pull/243)).
- **Husk speaks MCP 2026-07-28**, and the 2025 revisions before it, on the same stdio
  connection. An app on 2026-07-28, such as Claude Code's v2 runtime, gets "Done?" in the
  chat in that revision's own way. Every older app works as before. `@husk-ai/mcp` now
  runs on the MCP SDK v2 ([#244](https://github.com/Hotragn/husk/pull/244)).

### Fixed

- **A Chromium that died stayed dead** until the shared Husk restarted. The next call now
  starts it again, keeping its logins. A failed launch, and a computer reaped for
  idleness, no longer leave a Chromium behind ([#217](https://github.com/Hotragn/husk/pull/217)).
- **Fly computers could not browse**, because the driver needed stdin, which Fly's exec
  refuses ([#222](https://github.com/Hotragn/husk/pull/222)).
- **Stopping a wedged browser on `local` killed other computers' scripts** ([#222](https://github.com/Hotragn/husk/pull/222)).
- **Stopping a command stopped only the client.** On Docker, Podman and SSH the command
  ran on inside the computer while the chat was told it "was killed". It is now ended
  where it runs, on every provider, and a chat's cancel reaches it
  ([#190](https://github.com/Hotragn/husk/pull/190), [#191](https://github.com/Hotragn/husk/pull/191)).
- **A chat could quietly switch to running its computer in its own process** when the
  shared Husk was briefly gone. It now starts the shared Husk again and retries, and says
  so when it cannot ([#196](https://github.com/Hotragn/husk/pull/196)).
- **One `read_file` of a huge or endless file could knock over the shared Husk**, and a
  slow viewer could grow it without bound. Reads are bounded, and a viewer that falls
  behind drops frames ([#199](https://github.com/Hotragn/husk/pull/199), [#200](https://github.com/Hotragn/husk/pull/200)).
- **Connecting Claude Code or Codex was refused** once the launch line pinned a version
  range ([#205](https://github.com/Hotragn/husk/pull/205)).
- **Husk Bar could not reach the shared Husk**: it read only `HUSK_TOKEN`, and the shared
  Husk makes its own. It now reads `~/.husk/daemon.json` on every poll, as the desktop app
  does, and its pill makes way while the desktop app's notch shows the computers
  ([#230](https://github.com/Hotragn/husk/pull/230)).
- **A run's first computer call could ignore a hold**: a run scheduled on a computer you
  had already taken ran its first command anyway ([#240](https://github.com/Hotragn/husk/pull/240)).
- **On Windows, saving a bot could fail with `EPERM`** while something read the file, the
  console's list of husks among them ([#234](https://github.com/Hotragn/husk/pull/234)).
- **A file of many chats imported only the first** over the API, so a ChatGPT export of
  hundreds of chats became its first one ([#239](https://github.com/Hotragn/husk/pull/239)).
- **A bot made from a chat that used Husk lost the computer**: Husk's own tool names did
  not count as the computer's, and Cursor's chats were looked for where Cursor does not
  keep them ([#239](https://github.com/Hotragn/husk/pull/239)).
- **A take-over from a computer's link could flick back** to Take over for a few seconds,
  when a reading sent before it answered after it
  ([#233](https://github.com/Hotragn/husk/pull/233)).
- **Open bugs from the first users:** chat triggers, symlinks, duplicate names, `~/.husk`,
  a cold WSL and the model choice
  ([#174](https://github.com/Hotragn/husk/pull/174)).
- **`computer_info` reported the host's CPU count and no memory limit at all**, when
  both are limits husk set. A computer created with `--cpus=0.5 --memory=512m` described
  itself as having the host's 10 cores and 7724MB, because `nproc` and `free` read
  `/proc`, which a container shares with the machine under it. Both now come from the
  cgroup, v2 or v1, and a fractional CPU stays fractional rather than rounding up to a
  core the computer does not have. `huskinfo` inside the images and the fallback probe
  produce identical output, which is asserted
  ([#131](https://github.com/Hotragn/husk/pull/131), thanks
  [@Audgui-Byte](https://github.com/Audgui-Byte))
- **`husk rm` could not remove a computer whose workspace directory was gone, and
  `husk ps` went on listing it as running.** The error contradicted its own hint —
  `no computer named "cmp_…"` above `hint: running now: box-…`, naming the same machine.
  A computer whose files have vanished is now returned as destroyed rather than as
  nothing, so it can be removed and stops being listed
  ([#134](https://github.com/Hotragn/husk/pull/134), thanks
  [@Audgui-Byte](https://github.com/Audgui-Byte))
- **The first line of output ran into the MCP isolation note.** A client that
  concatenates text blocks showed `isolation.hi` instead of the note and then the
  command's output
  ([#133](https://github.com/Hotragn/husk/pull/133), thanks
  [@Audgui-Byte](https://github.com/Audgui-Byte))
- **`husk import` invented paths for every Claude Code project whose directory had a
  dash in it.** The label was built by turning every `-` in the encoded directory name
  into `/`, so `C--Users-dev-Claude-Code-husk` was offered as
  `C//Users/dev/Claude/Code/husk` — a path that exists nowhere. The encoding cannot be
  reversed, because a dash in it is either a literal dash or a separator and nothing
  records which, so the real working directory is now read from the transcript itself.
  Where a transcript does not carry one, the encoded name is shown as-is rather than
  decoded into a guess
  ([#129](https://github.com/Hotragn/husk/pull/129), thanks
  [@Audgui-Byte](https://github.com/Audgui-Byte))
- **A chat's tool call failed after five minutes** on the shared Husk: a long `shell`
  command, or a bot on Claude Code or Codex waiting for a person to give its computer
  back, got `fetch failed` while the work went on. A long call now keeps its answer alive
  ([#242](https://github.com/Hotragn/husk/pull/242)).
- **`husk exec` on Docker and Podman stops a command after 120 s**, as the docs say and the
  other providers already did. Without `--timeout`, a command that never ended held the
  call open forever ([#258](https://github.com/Hotragn/husk/pull/258)).
- **`husk serve` reads `HUSK_HOST` and `HUSK_PORT`**, as documented, for a service whose
  unit file sets them. The flags still win ([#258](https://github.com/Hotragn/husk/pull/258)).
- **`husk setup --computer auto` gets the image before the first chat**, for the computer
  auto will use, as the README's setup line expects. Answering no to the browser question
  now gives chats the smaller image; it changed nothing before
  ([#258](https://github.com/Hotragn/husk/pull/258)).
- **`husk mcp` gives chats the image that runs the browser**, as `npx @husk-ai/mcp` does,
  and takes `--flavor`. It offered the browser tools on the base image
  ([#258](https://github.com/Hotragn/husk/pull/258)).
- **`husk-mcp --network-strict` without `--network` is refused**, saying why, instead of
  being dropped without a word ([#258](https://github.com/Hotragn/husk/pull/258)).
- **`husk doctor` warns below Node 20.10**, the supported floor, not only below 20
  ([#258](https://github.com/Hotragn/husk/pull/258)).
- **`~/.husk/config.json` and `~/.husk/.env` are read**, as the docs said. Nothing
  opened either file. `config.json` takes `modelAliases`, `maxCostUsd`, `maxComputers`,
  `provider` and `model`, the last two being what `auto` means on this machine. A file
  that is not JSON, a value of the wrong type or a key it does not know stops Husk with
  its name. `.env` fills in the keys the environment does not set
  ([#259](https://github.com/Hotragn/husk/pull/259)).
- **`packages` install on Docker and Podman.** A container computer's read-only root
  refused every install; the packages are now built into an image of the computer's
  own, `FROM` its image, and reused for the same list. A package name with a space, a
  quote, `# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file records what changed for people who installed the packages. Repository
housekeeping — CI, workflows, README edits, branch cleanup — lives in the commit log,
not here.

## [Unreleased]

### Added

- **Workspaces.** Named local workspaces keep the public sources you add and the
  results your chat writes, with a viewer, downloads and ZIP export. They need no
  Docker and no extra API key. `--profile starter` serves the workspace tools only; it is
  what the Claude Desktop extension uses
  ([#151](https://github.com/Hotragn/husk/pull/151)).
- **Hand-offs.** `hand_off` and `hand_off_done` give you the computer for a login, a 2FA
  code or a CAPTCHA, and give it back only when you say so
  ([#164](https://github.com/Hotragn/husk/pull/164)). Every chat gets its own computer,
  which is kept until you delete it
  ([#165](https://github.com/Hotragn/husk/pull/165)).
- **The computer card.** In apps that render MCP Apps, the chat shows its computer's state
  and a link ([#166](https://github.com/Hotragn/husk/pull/166)).
- **The console's Home** is an overview of every computer
  ([#167](https://github.com/Hotragn/husk/pull/167)).
- **Husk Bar**, a macOS menu-bar and notch companion
  ([#168](https://github.com/Hotragn/husk/pull/168)).
- **One shared Husk for every chat on the machine.** Each chat's tools go through it, so
  the console shows every chat's computer, its live browser and what it did last
  ([#175](https://github.com/Hotragn/husk/pull/175)). Each chat's computer has its own
  page, with the live browser, its activity, Take over and Make this a bot
  ([#176](https://github.com/Hotragn/husk/pull/176)).
- **`husk setup`** picks where computers run, connects your chat apps and starts the
  shared Husk. The console's Connect page does the same
  ([#177](https://github.com/Hotragn/husk/pull/177)).
- **The desktop app** carries its own Node and keeps each chat's computer one click away:
  - a corner of small computers;
  - a Computers window whose tabs are your computers;
  - a notch when it is minimized;
  - a tray that tells you when a chat is waiting.

  Each release attaches its installers for Windows, macOS and Linux, signed and
  notarized when the release has the signing keys
  ([#178](https://github.com/Hotragn/husk/pull/178),
  [#185](https://github.com/Hotragn/husk/pull/185),
  [#231](https://github.com/Hotragn/husk/pull/231)).
- **The desktop app updates itself.** A signed build looks on GitHub Releases at start and
  every six hours, downloads in the background, and **Restart to update** in the tray
  installs it. Husk keeps running, so chats keep their computers. An unsigned build, or
  Linux, only says a new version is out. Chat apps that start the app's Husk follow it
  when it updates or moves, keeping their flags and computer choice; an entry you pointed
  elsewhere is left alone ([#232](https://github.com/Hotragn/husk/pull/232)).
- **The desktop app says when Husk stops answering.** The Computers window shows a banner
  and clears its screen, the tray, the corner and the notch say so too, and Take over
  waits until Husk is back. The app starts Husk again, waiting longer after each failed
  start, up to a minute ([#225](https://github.com/Hotragn/husk/pull/225)).
- **The corner and the notch work by keyboard.** Ctrl+Alt+Shift+H (Cmd+Option+Shift+H on
  a Mac) hands them the keyboard, and the tray lists every computer. With reduced motion
  on, nothing pulses or flies in ([#226](https://github.com/Hotragn/husk/pull/226)).
- **The desktop app on every platform and screen.** On Linux, clicks pass through around
  the corner and the notch. They follow the main screen as screens come and go, and a
  Computers window left on no screen comes back. On a Mac, minimizing to the notch keeps
  the Dock icon; on Windows, a chat reopening the window no longer takes focus from what
  you are typing. Closing the console window keeps its Terminal running
  ([#227](https://github.com/Hotragn/husk/pull/227)).
- **Bots on your own Claude Code or Codex.** A husk's `engine` is `builtin`, `claude-code`
  or `codex`. A CLI engine runs your installed CLI headless, under your own login, with
  Husk's tools and nothing else: no built-in shell or file tools, no other MCP server, no
  project's settings, and for Codex a read-only sandbox. A Claude Code bot can go on with a
  chat (`engine.resume`): each run is a fork of it, on the chat's own computer, and the chat
  itself is never written to ([#238](https://github.com/Hotragn/husk/pull/238)).
- **Every chat app can become a bot.** Make this a bot reads Claude Code and Codex chats
  back by themselves. **Husks › Make a bot from a chat** takes a chat found on this
  computer, an export or pasted text, and asks which chat when a file holds many. Codex
  rollouts import, and a draft runs on the chat's own app when it is installed
  ([#239](https://github.com/Hotragn/husk/pull/239)).
- **A job host for bots' triggers.** Schedules, webhooks and chat-app triggers run in a
  process of their own, which the shared Husk starts when a bot has a trigger and which
  leaves once none has; a trigger keeps the shared Husk's address and token
  ([#235](https://github.com/Hotragn/husk/pull/235)).
- **Take over at any moment**, from the console, the desktop app or a chat's link
  ([#180](https://github.com/Hotragn/husk/pull/180),
  [#182](https://github.com/Hotragn/husk/pull/182)).
- **A faster browser.** One long-lived driver per computer, and a pushed live screen.
  `browser_run` does several steps in one call
  ([#181](https://github.com/Hotragn/husk/pull/181)), and `browser_script` runs a short
  Python script with control flow inside the computer
  ([#184](https://github.com/Hotragn/husk/pull/184)).
- **Take-over stops the AI where it is.** Taking a computer stops the AI's calls running
  on it, browser scripts included, and every route that changes the computer refuses a
  program while you hold it; a husk run obeys it too. After Give back, a browser action
  on a page you changed is refused until the AI looks again
  ([#192](https://github.com/Hotragn/husk/pull/192), [#194](https://github.com/Hotragn/husk/pull/194), [#195](https://github.com/Hotragn/husk/pull/195)).
- **Holds only you end.** A take-over survives a restart of the shared Husk, and only your
  Give back ends it: from the console, the desktop app, the tray or the link you took it
  with. A sign-in handoff a chat asked for still ends with its "done". While you hold a
  computer its browser stays open, the tray says so, and quitting asks first
  ([#207](https://github.com/Hotragn/husk/pull/207), [#208](https://github.com/Hotragn/husk/pull/208), [#209](https://github.com/Hotragn/husk/pull/209)).
- **The window opens as a chat starts working**, without taking focus, if you said yes
  when the desktop app first asked; a take-over says which call it is waiting for
  ([#204](https://github.com/Hotragn/husk/pull/204)).
- **Honest clicks.** A click on something covered, disabled, hidden or still moving, or a
  role and name that match two elements, is refused, saying why; `force` clicks anyway
  ([#211](https://github.com/Hotragn/husk/pull/211)).
- **Refs that expire, and frames.** A ref acts only on the document whose snapshot showed
  it, so a ref from an earlier page is refused rather than landing on whatever has its id
  now ([#213](https://github.com/Hotragn/husk/pull/213)). A snapshot reads every frame, cross-site ones included, with refs like
  `f2e7`, and typing, clicks, hover, scroll and upload reach into them ([#216](https://github.com/Hotragn/husk/pull/216)).
- **Dialogs, downloads and new tabs.** A dialog is answered the moment it opens and the
  result says so; a confirm is dismissed unless the call passes `dialog: "accept"`. A
  download lands in `/work/downloads`, and a tab a page opens is named with its id, so
  switching to it is one call ([#215](https://github.com/Hotragn/husk/pull/215), [#223](https://github.com/Hotragn/husk/pull/223)).
- **Fewer turns.** Every browser result ends with where the page is. A snapshot can be of
  one part of the page, and `browser_click` and `browser_type` take `waitFor`, watched
  from just before they act. A call on a computer you hold opens with `E_COMPUTER_HELD`
  ([#220](https://github.com/Hotragn/husk/pull/220)).
- **A benchmark against Playwright MCP** on the same computer and Chromium, published in
  every e2e run's summary, with the latest numbers in [docs/BENCHMARK.md](docs/BENCHMARK.md)
  ([#223](https://github.com/Hotragn/husk/pull/223)).
- **Strict network enforcement.** `strict: true` under `computer.network`, or
  `husk-mcp --network-strict`, refuses a provider that cannot enforce the policy for every
  process. Without it, Husk says what is not enforced ([#219](https://github.com/Hotragn/husk/pull/219)).
- **Zed.** `husk setup` and the Connect page connect it, keeping the comments its settings
  start with ([#243](https://github.com/Hotragn/husk/pull/243)).
- **Long calls in every chat app.** Most apps give up on a tool call after a while, such as
  Claude Desktop after 240 s and Zed after 60 s. Husk now answers first: the call says it
  is still running and goes on in the computer, and `job_wait` collects its result
  ([#243](https://github.com/Hotragn/husk/pull/243)).
- **The chat apps' support matrix**, in [docs/clients.md](docs/clients.md). For each app,
  it gives how the app gets Husk, what it supports and its limits, with sources. The e2e
  run checks every app ([#243](https://github.com/Hotragn/husk/pull/243)).
- **Chat apps on the web.** `husk serve --remote --public-url https://<name>` lets claude.ai
  and ChatGPT use Husk through a tunnel you run, or from a Fly app of your own
  ([#245](https://github.com/Hotragn/husk/pull/245), [#247](https://github.com/Hotragn/husk/pull/247), [#248](https://github.com/Hotragn/husk/pull/248)).
  - It is for one owner, who claims it once with a code printed on the machine and signs
    in with a passkey after that.
  - Commands, file changes and browser actions wait for the owner's passkey, on a page
    that shows exactly what they send.
  - The console's Connect page and header, and Husk Bar, show whether it is on. The
    Connect page and `husk remote` switch it off and sign apps out.
  - It will not start while a high or critical security advisory stands against the
    install.
  - The guide is *Chat apps on the web* in the docs. The Fly provider now also takes its
    token from `HUSK_FLY_TOKEN`.
- **`husk rm --erase`** erases what a chat's or a bot's computer keeps on Docker and
  Podman, its files and browser logins, as the console's Delete does
  ([#259](https://github.com/Hotragn/husk/pull/259)).

### Changed

- **Chats get the image with the browser by default**, and setup pulls it with its
  progress, so a chat's first page does not wait on a 2 GB download mid-call
  ([#201](https://github.com/Hotragn/husk/pull/201)).
- **`auto` leaves paid Fly out** unless `HUSK_AUTO_FLY=1`; `--provider fly` always works.
  A chat's computer on another provider than the one asked for is kept, and the chat is
  told ([#203](https://github.com/Hotragn/husk/pull/203)).
- **Setup pins a version range** (`@husk-ai/mcp@~0.2`), and the shared Husk speaks a
  protocol version, so a later release that speaks another cannot start under it
  ([#196](https://github.com/Hotragn/husk/pull/196)).
- **Coming from 0.1.4**, setup and the Connect page move each chat app's `husk` entry to
  this release, keeping the flags and env you gave it, Claude Code's per-project entries
  included. Computers, named sessions, their files and your bots carry over as they are
  ([#205](https://github.com/Hotragn/husk/pull/205)).
- **Only the shared Husk stops a chat's computer**, after ten idle minutes, and never one
  you hold ([#197](https://github.com/Hotragn/husk/pull/197)).
- **An ssh or Fly computer's screen shows when you ask.** Each picture there is a command
  on the computer, which kept it awake: **Look** shows it for a minute, and a computer you
  hold shows all the time. Docker, Podman and local push their screen as before
  ([#228](https://github.com/Hotragn/husk/pull/228)).
- **Bots wait out a take-over.** A chat is told to stop when you take its computer; a bot,
  with nobody to tell, waits until you give it back, says so once in its run, and goes on.
  A cancel or its timeout still ends it ([#240](https://github.com/Hotragn/husk/pull/240)).
- **The built-in engine ships with every install**, the desktop app included, so a bot
  runs on any model, a local Ollama among them, with no CLI install
  ([#234](https://github.com/Hotragn/husk/pull/234)).
- **The desktop app gives its Husk your login shell's PATH**, so a Mac app opened from the
  Finder finds `docker`, `claude` and `codex` ([#238](https://github.com/Hotragn/husk/pull/238)).
- **Setup changes a chat app's file in place.** Only Husk's own entry changes, and the rest
  of the file keeps its layout. Windsurf is listed as Windsurf (Devin Desktop), whose two
  agents read the same file. Codex, Gemini CLI and Claude Desktop's Code tab are named on
  the computers they make ([#243](https://github.com/Hotragn/husk/pull/243)).
- **Husk speaks MCP 2026-07-28**, and the 2025 revisions before it, on the same stdio
  connection. An app on 2026-07-28, such as Claude Code's v2 runtime, gets "Done?" in the
  chat in that revision's own way. Every older app works as before. `@husk-ai/mcp` now
  runs on the MCP SDK v2 ([#244](https://github.com/Hotragn/husk/pull/244)).

### Fixed

- **A Chromium that died stayed dead** until the shared Husk restarted. The next call now
  starts it again, keeping its logins. A failed launch, and a computer reaped for
  idleness, no longer leave a Chromium behind ([#217](https://github.com/Hotragn/husk/pull/217)).
- **Fly computers could not browse**, because the driver needed stdin, which Fly's exec
  refuses ([#222](https://github.com/Hotragn/husk/pull/222)).
- **Stopping a wedged browser on `local` killed other computers' scripts** ([#222](https://github.com/Hotragn/husk/pull/222)).
- **Stopping a command stopped only the client.** On Docker, Podman and SSH the command
  ran on inside the computer while the chat was told it "was killed". It is now ended
  where it runs, on every provider, and a chat's cancel reaches it
  ([#190](https://github.com/Hotragn/husk/pull/190), [#191](https://github.com/Hotragn/husk/pull/191)).
- **A chat could quietly switch to running its computer in its own process** when the
  shared Husk was briefly gone. It now starts the shared Husk again and retries, and says
  so when it cannot ([#196](https://github.com/Hotragn/husk/pull/196)).
- **One `read_file` of a huge or endless file could knock over the shared Husk**, and a
  slow viewer could grow it without bound. Reads are bounded, and a viewer that falls
  behind drops frames ([#199](https://github.com/Hotragn/husk/pull/199), [#200](https://github.com/Hotragn/husk/pull/200)).
- **Connecting Claude Code or Codex was refused** once the launch line pinned a version
  range ([#205](https://github.com/Hotragn/husk/pull/205)).
- **Husk Bar could not reach the shared Husk**: it read only `HUSK_TOKEN`, and the shared
  Husk makes its own. It now reads `~/.husk/daemon.json` on every poll, as the desktop app
  does, and its pill makes way while the desktop app's notch shows the computers
  ([#230](https://github.com/Hotragn/husk/pull/230)).
- **A run's first computer call could ignore a hold**: a run scheduled on a computer you
  had already taken ran its first command anyway ([#240](https://github.com/Hotragn/husk/pull/240)).
- **On Windows, saving a bot could fail with `EPERM`** while something read the file, the
  console's list of husks among them ([#234](https://github.com/Hotragn/husk/pull/234)).
- **A file of many chats imported only the first** over the API, so a ChatGPT export of
  hundreds of chats became its first one ([#239](https://github.com/Hotragn/husk/pull/239)).
- **A bot made from a chat that used Husk lost the computer**: Husk's own tool names did
  not count as the computer's, and Cursor's chats were looked for where Cursor does not
  keep them ([#239](https://github.com/Hotragn/husk/pull/239)).
- **A take-over from a computer's link could flick back** to Take over for a few seconds,
  when a reading sent before it answered after it
  ([#233](https://github.com/Hotragn/husk/pull/233)).
- **Open bugs from the first users:** chat triggers, symlinks, duplicate names, `~/.husk`,
  a cold WSL and the model choice
  ([#174](https://github.com/Hotragn/husk/pull/174)).
- **`computer_info` reported the host's CPU count and no memory limit at all**, when
  both are limits husk set. A computer created with `--cpus=0.5 --memory=512m` described
  itself as having the host's 10 cores and 7724MB, because `nproc` and `free` read
  `/proc`, which a container shares with the machine under it. Both now come from the
  cgroup, v2 or v1, and a fractional CPU stays fractional rather than rounding up to a
  core the computer does not have. `huskinfo` inside the images and the fallback probe
  produce identical output, which is asserted
  ([#131](https://github.com/Hotragn/husk/pull/131), thanks
  [@Audgui-Byte](https://github.com/Audgui-Byte))
- **`husk rm` could not remove a computer whose workspace directory was gone, and
  `husk ps` went on listing it as running.** The error contradicted its own hint —
  `no computer named "cmp_…"` above `hint: running now: box-…`, naming the same machine.
  A computer whose files have vanished is now returned as destroyed rather than as
  nothing, so it can be removed and stops being listed
  ([#134](https://github.com/Hotragn/husk/pull/134), thanks
  [@Audgui-Byte](https://github.com/Audgui-Byte))
- **The first line of output ran into the MCP isolation note.** A client that
  concatenates text blocks showed `isolation.hi` instead of the note and then the
  command's output
  ([#133](https://github.com/Hotragn/husk/pull/133), thanks
  [@Audgui-Byte](https://github.com/Audgui-Byte))
- **`husk import` invented paths for every Claude Code project whose directory had a
  dash in it.** The label was built by turning every `-` in the encoded directory name
  into `/`, so `C--Users-dev-Claude-Code-husk` was offered as
  `C//Users/dev/Claude/Code/husk` — a path that exists nowhere. The encoding cannot be
  reversed, because a dash in it is either a literal dash or a separator and nothing
  records which, so the real working directory is now read from the transcript itself.
  Where a transcript does not carry one, the encoded name is shown as-is rather than
  decoded into a guess
  ([#129](https://github.com/Hotragn/husk/pull/129), thanks
  [@Audgui-Byte](https://github.com/Audgui-Byte))
- **A chat's tool call failed after five minutes** on the shared Husk: a long `shell`
  command, or a bot on Claude Code or Codex waiting for a person to give its computer
  back, got `fetch failed` while the work went on. A long call now keeps its answer alive
  ([#242](https://github.com/Hotragn/husk/pull/242)).
, a backtick or a backslash is refused. SSH and Fly computers refuse
  `packages` rather than ignore them ([#259](https://github.com/Hotragn/husk/pull/259)).

### Security

- **Chromium keeps its own sandbox outside containers**, falling back with a warning only
  where it cannot start. Every new tab and every redirect hop is checked against the
  address filter, which reads IPv6 addresses whole ([#202](https://github.com/Hotragn/husk/pull/202)).
- **The network policy holds for every page load**, not only the URLs Husk opens. The
  browser driver checks each redirect, link, frame and pop-up, and stops a refused load
  before anything is sent ([#218](https://github.com/Hotragn/husk/pull/218)).
- **A browser script is held to `shell`'s rules** for what it hands a shell ([#222](https://github.com/Hotragn/husk/pull/222)).
- **Deleting a chat's computer kept its logins.** On Docker and Podman, a chat's or a
  bot's files and browser profile, cookies included, outlived it. The console's Delete,
  once you type the id back, now removes them too. `husk rm` still means "stop for now",
  and says what it keeps ([#229](https://github.com/Hotragn/husk/pull/229)).
- **`fetch_url` and `http_request` check each redirect before following it.** They
  followed the whole chain and checked only where it ended, so a 302 to an internal
  address had been asked before it was refused. A hop to another origin no longer carries
  `Authorization` or cookies ([#257](https://github.com/Hotragn/husk/pull/257)).
- **`${NAME}` in a husk.yaml is read from Husk's environment**, in `computer.env` and in
  a webhook's `secret`, as the docs showed. Nothing expanded it: a webhook secret copied
  from the docs was the published text `${GITHUB_WEBHOOK_SECRET}`, and a computer got
  the placeholder instead of the token. An unset or empty `NAME` is refused: no computer
  is made, and the webhook is not mounted ([#257](https://github.com/Hotragn/husk/pull/257)).
- **`guardrails.allowCommands` lifts a built-in refusal**, as documented. The lists never
  reached the computer, so `sudo apt-get install` stayed refused whatever the husk.yaml
  allowed. An entry now lifts what it matches, not the whole line: a command chained
  after an allowed one, such as `; rm -rf /`, is checked on its own
  ([#257](https://github.com/Hotragn/husk/pull/257)).
- **`systemctl stop <unit>` is refused**, as the docs said. The rule caught only the
  `service <name> stop` order ([#257](https://github.com/Hotragn/husk/pull/257)).

## [0.1.4] - 2026-09-22

### Added

- **`husk onboard` — the guided setup that was missing.** Between `npm i -g @husk-ai/cli`
  and a working first command sat: read `doctor`, pick one of eleven model providers, go
  and find a key, export it, come back, work out which of twenty commands to run. Every
  step of that was documented and none of it was in front of you. `onboard` walks the
  same ground and then does the next thing each time — it names your provider and how
  isolated it actually is, creates a computer and destroys it in front of you so you have
  seen it work before configuring anything, names the cheapest route to a model if you
  have none, and prints the MCP line for your editor. Five steps, each skippable, safe to
  re-run.

  It never asks for an API key. Husk reads credentials from the environment and does not
  store them; an onboarding that offered to hold one would make that false on the very
  first run, so it prints the `export` line and re-probes. With no terminal it prints the
  whole path as text and creates nothing, because a CLI that blocks for input inside a
  Dockerfile is a CLI people stop installing.
- **The one-time orientation now reaches every entry point.** It was wired to `husk up`
  alone, so anyone whose first command was `husk mcp` — a model about to be handed a
  shell — was never told what the isolation boundary was. `run`, `serve` and `mcp` say it
  too now, on stderr, so the MCP protocol channel stays clean.

### Fixed

- **`/work` did not name the same file for the shell as it did for the file tools.**
  Husk tells an agent that `/work` is its workspace. On the `local` provider the file
  tools honoured that and the posix shell did not, so `write_file('/work/scrape.py')`
  followed by `python3 /work/scrape.py` returned file-not-found — "write a script, then
  run it", on the provider you get by default when there is no Docker. The shell now
  maps guest-absolute paths onto the workspace it is already running in: quote-aware,
  lexical, trailing slashes preserved so `/work/$f` still concatenates, and lookalikes
  like `/workshop` left alone rather than helpfully repointed at a host file. Heredoc
  bodies are copied through untouched, because `cat > /work/notes.md <<EOF` is how an
  agent writes a file and the thing it writes about is usually the workspace. On WSL2
  the shell gets a real `/work` instead, bind-mounted per exec inside `unshare -mr`.
  A conformance suite now writes a file through the runtime, MCP, HTTP and shell
  surfaces and reads it back through every other one, against both `local` and
  `docker`, so the next surface to invent its own path space fails in CI.
- **The safety language called `/work` jailed when only half of it was.** That was true
  of the file tools and false of the shell, in four documents and in the MCP note a
  model reads before its first tool call — and a model that believes its shell is
  contained takes risks it otherwise would not. The docs now say which half is
  confined. The same correction reaches the trust-boundary diagram and the README for
  0.1.4: the path jail is a `local` control, not something every provider enforces. On
  `docker`, `podman` and `fly` the container is the boundary, so `read_file
  /etc/passwd` returns the container's own copy.
- **A run that could not fit the model's context was truncated into nonsense instead of
  refused.** Local servers still default to tiny contexts — llama.cpp long shipped
  `n_ctx 512` — and Husk's own system prompt plus the computer tool schemas is about
  2.5k tokens before the conversation starts. The run is now rejected before the first
  call, naming the tokens needed, the tokens available and the setting to raise.
- **A Chromium launch that never opened its debugging port leaked a browser per
  attempt.** The wait is bounded and the process is reaped, so a machine that cannot
  start a browser says so instead of accumulating one. The error quotes the real
  ceiling too: it said "within 40 seconds", which is the poll's arithmetic while every
  connect is refused instantly, not the 90 seconds a wedged listener can actually
  take.
- **`husk import` offered ordinary repository Markdown as chat transcripts.** Run from a
  project root it listed eighteen candidates, `CHANGELOG.md` among them, which made
  discovery useless in the first place most people try it. Markdown is content-sniffed
  now and has to look like a conversation.
- **A secret in a transcript title survived into the name derived from it.** Distilling
  a chat that mentioned an API key produced the slug `use-key-sk-antredacted` — the
  body was redacted and the prefix was not, which is a smaller leak rather than no
  leak. Redaction runs before anything becomes a name, a slug or a filename.
- **The distiller reported "configured without tools" while the spec it had just
  written listed them.** Prose and structured output are checked against each other.
- **An MCP computer that had been stopped could look connected while every command
  failed.** The next call resumes it where it can and reports the failure clearly where
  it cannot, and a failed readiness probe no longer returns a healthy-looking header.
- **`husk exec` turned a cmd.exe quoting mistake into somebody else's error message.**
  The documented `husk exec dev -- 'uname -sr && python3 -V'` is a posix-shell form;
  `cmd.exe` does not strip single quotes, so Husk received `'uname` and the container
  runtime failed with `exec: "'uname": executable file not found in $PATH`. Husk now
  recognises the stray quote before it resolves a provider and prints the double-quoted
  form of what you meant.

- **On Windows without a working WSL, `husk doctor` said nothing useful and sometimes
  contradicted itself.** The warning written for that case was gated on a test that no
  reachable state could pass, so it had never printed. The `local` provider reported
  "with no WSL" even when WSL was installed and simply not responding, directly beneath
  a line saying the opposite, and told people to `wsl --install` something they already
  had. The fix that would have helped was never shown at all, because hints only
  printed for providers reported as unavailable and `local` is always available.
  `doctor` now distinguishes the two states, gives each its own fix, and says that
  Docker is down for the same reason — its engine runs inside WSL2.
- **A model given a degraded Windows computer was told it had Linux.** The first tool
  result said the machine was "on the Windows shell", which is a label with no
  consequence attached; the model would still open with `ls -la /work` and then retry
  variations of a command that could not work. It now says what actually differs —
  `$VAR` does not expand and `'single quotes'` are not quotes, both silently at exit 0
  — and that Unix tools may or may not be on `PATH` depending on what else is
  installed. A command that fails because the shell is `cmd.exe` now carries that
  reason with it, rather than only at the top of the session.

## [0.1.3] - 2026-09-16

The browser works on Docker again, and husk stops naming things it does not own.

### Fixed

- **`flavor: full` never had a working browser on `docker` or `podman`.** The image it
  actually landed on was `debian:bookworm`, which ships no Chromium, so the `browser_*`
  tools on a `full` computer had nothing to drive. It resolves to
  `mcr.microsoft.com/playwright:v1.59.1-noble` now.
- **Every flavour tried `ghcr.io/husk-sh/husk-<flavor>` first** — a namespace husk does
  not own and has never pushed to — so the first pull on every fresh install was a
  guaranteed 404. It recovered quietly by substituting the public base image, which
  meant you ran something other than the image your spec named and lost the `huskinfo`
  script with it. Flavours resolve to a public image outright now, and `HUSK_REGISTRY`
  turns the old two-step back on as an opt-in mirror.
- **`husk --version` reported `0.1.0` while you were running 0.1.1.** Four constants
  carried the version by hand and none were bumped with the manifests, so the CLI,
  `husk doctor`, `/health`, `/v1/doctor`, the `X-Husk-Version` header and both outbound
  User-Agent strings all named a release nobody was on.
- The install instructions named `@husk/mcp`. Nothing is published under that scope and
  the scope is not ours, so the command 404'd for everyone who copied it. The published
  name is `@husk-ai/mcp`.
- `computer_info` did not answer the question its own description tells a model to call
  it for, so a model asking what was installed had to fall back to probing with shell
  commands.

### Security

- **Removed every reference to `husk.sh` and the `husk-sh` GitHub organisation.**
  Neither is ours, and both shipped to npm in 0.1.0, 0.1.1 and 0.1.2. The OpenRouter
  attribution header sent `http-referer: https://husk.sh`, and four User-Agent strings
  advertised the same domain to every model provider and every page the browser
  fetched.

## [0.1.2] - 2026-09-16

### Fixed

- **`husk` exited 0 and printed nothing when installed from npm.** The published `bin`
  pointed at a wrapper whose entry-point guard never matched through npm's shim, so the
  command that is the product's entire surface did nothing at all — silently, and with a
  success exit code, on every install of 0.1.1.
- `@husk-ai/mcp` documented a streamable HTTP transport it does not implement. The
  server speaks stdio, and the docs now say only that.
- The `@husk-ai/sdk` readme linked with `../..`, which npm cannot follow, so every
  relative link on its package page was broken.

### Added

- Webhook signature verification tests, covering the replay-window boundary at exactly
  the tolerance and the empty-body case ([#26](https://github.com/Hotragn/husk/pull/26),
  thanks [@EthemKD](https://github.com/EthemKD))
- `engines: { node: ">=20.10" }` on all eleven packages, so npm refuses an unsupported
  Node instead of failing at runtime. `repository`, `homepage` and `bugs` are now
  declared too, which is what makes the npm page link back here.

### Security

- The security disclosure address was `security@husk.sh`, a mailbox at a domain we do
  not control, printed in `SECURITY.md` as the place to send vulnerability reports.
  Disclosures now go through
  [GitHub private vulnerability reporting](https://github.com/Hotragn/husk/security/advisories/new),
  which is the only channel that is monitored.

## [0.1.1] - 2026-09-14

The first version published to npm.

### Changed

- **The npm scope is `@husk-ai/`, not `@husk/`** — `@husk` was already taken on the
  registry. Install commands and import specifiers change. The CLI binary is still
  `husk`, and `husk.yaml` is unchanged.

### Fixed

- Inter-package dependencies still pinned `0.1.0` after the packages themselves were
  bumped to `0.1.1`, so npm could not resolve them locally and fell through to the
  registry, where they did not exist. Installing anything with a sibling dependency —
  `@husk-ai/agent`, `@husk-ai/cli`, `@husk-ai/sdk` — failed.

## [0.1.0] - 2026-09-14

The first version that does the two things on the tin.

### Added

**A computer for agents**

- Five providers behind one `Computer` interface: `docker`, `podman`, `ssh`, `fly`,
  and `local`. `auto` walks them in that order, preferring real isolation over
  guardrails and free over metered, with `local` as the floor that is always there.
- **Real Linux on Windows without Docker.** The `local` provider runs each command
  inside a WSL2 user + mount namespace (`unshare -mr`) that bind-mounts the workspace
  onto `/work`. The agent is uid 0 inside the namespace, files land owned by the real
  user outside it, and the mount disappears when the command exits — so two computers
  never see each other. Falls back to the host shell, loudly, when WSL is absent.
- `ComputerManager.ensure(key)` maps a stable key to a machine, so one conversation
  keeps one filesystem without the caller tracking ids. Concurrent callers share a
  single in-flight create rather than racing into two machines.
- Snapshots commit the image *and* tar the workdir, because `/work` is a tmpfs and a
  commit alone would silently lose everything the agent did.

**A chat becomes a bot**

- Importers for Claude Code JSONL, ChatGPT exports, Cursor, Gemini and pasted
  markdown. Branched threads are reconstructed by walking `parentUuid` from the last
  leaf, so you get the conversation as it actually ran.
- Two distillers. The model-backed one map/reduces over the whole transcript; the
  heuristic one needs no key, no network, and reports an honest confidence with a list
  of what it could not determine.
- `husk.yaml` is the unit of value: readable, diffable, and validated by a zod schema.

**Models**

- Eleven providers, no vendor SDKs — the wire-format translation is the package.
  Anthropic, OpenAI, Google, Groq, OpenRouter, Together, DeepSeek, Mistral, Cerebras,
  Ollama, LM Studio.
- Aliases (`opus`, `sonnet`, `gemma`, `free`, `auto`) keep a spec portable.
- Fallback emits a `warning` event. Silently answering with a weaker model than the one
  requested is worse than failing.

**MCP**

- `claude mcp add husk -- npx -y @husk-ai/mcp` gives Claude Code a computer
  mid-conversation. Seven tools over stdio, and the first tool result states plainly
  that a `local` computer is not a sandbox.

### Security

- Path jail with symlink resolution, environment scrubbing, output caps, process-tree
  kill on timeout, and a command deny list anchored to command position — so
  `grep -r "sudo" .` is not refused, because a deny list that cries wolf gets disabled.
- **The network floor refuses loopback, link-local and RFC1918 even in
  `network.mode: 'full'`.** `full` means the internet, not the cloud metadata endpoint
  at `169.254.169.254` that hands IAM credentials to anything that asks.
- `ask`-mode approval fails closed: no approver wired means the call is denied.
- Budgets — step, cost, token, wall clock — are checked *before* a model call, so a
  ceiling is never breached, only prevented.
- `isolationKind` distinguishes `kernel`, `machine` and `guardrails`. A boolean
  overclaimed for `ssh`, which is isolated from your laptop but not from the box it
  runs on; `husk doctor` now says "isolated from this machine".

### Known gaps

Not a Keep a Changelog section, but shipping a list of what does not work belongs next
to the list of what does.

- The hosted control plane does not exist. `husk serve` is a single-user local daemon.
- `web_search` needs a Brave or Tavily key; without one the tool is not registered
  rather than failing at call time.
- Anthropic's Opus and Sonnet cache-write prices are derived from estimated input
  rates and are marked `estimatedPricing`.

[Unreleased]: https://github.com/Hotragn/husk/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/Hotragn/husk/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Hotragn/husk/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Hotragn/husk/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Hotragn/husk/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Hotragn/husk/releases/tag/v0.1.0
