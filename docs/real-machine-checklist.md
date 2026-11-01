# Real-machine checklist

What only a person on a real machine can check before a release: J7-d in #187, for 0.2.0. Do it once on a Windows 11 PC and once on a Mac. Tick a box only when you saw what it says. If you saw something else, write it under the line.

Build tested: commit `________` · Windows build `________` · macOS `________` · date `________`

## If something goes wrong, copy these

- Husk's logs, in its home folder: `%USERPROFILE%\.husk` on Windows, `~/.husk` on a Mac (or the `HUSK_HOME` folder, if you set one):
  - `daemon.log`: the shared Husk every chat goes through.
  - `desktop.log`: the desktop app.
  - `jobs.log`: bots' triggers. It exists only once a bot has a trigger.
  - `data\<computer id>`: one line per tool call on that computer.
- What `husk doctor` prints (or the Husk window: Advanced → Doctor), and what http://127.0.0.1:7377/health shows.
- The chat app's name and version, the computer's id (`cmp_…`), and a screenshot.
- Never share `daemon.json`, `jobs.json`, `.env`, the `remote` folder, or a console link with `#token=` in it. They hold Husk's tokens and keys.
- To undo Husk's change to a chat app's settings, use the copy next to that file that ends in `.husk-backup-<time>`.

## How to read the steps

- **[Win]** Windows only. **[Mac]** Mac only. No tag: every machine.
- Windows has three setups: **[No WSL]** no Linux in WSL, so commands run in `cmd.exe`; **[WSL 2]** a working Linux in WSL 2, with Docker Desktop not running; **[Docker]** Docker Desktop running. The Mac has two: **[Docker]** and **[Mac, no Docker]**.
- The corner: the very small 3D computers at the bottom right of the screen. The Computers window: the small window that opens when you click one. The notch: the black capsule at the top of the screen. The Husk window: tray → Open Husk. The tray: the Husk icon by the Windows clock (it may be under ^), or in the Mac menu bar.
- `husk` means the CLI you set up in section 1.

## 1. Get the build

- [ ] Have ready: Node 20.10 or newer, Git, Docker Desktop, a GitHub account, and the chat apps you will test (Claude Desktop, Claude Code, Codex CLI, Cursor, VS Code with GitHub Copilot, Windsurf or Devin Desktop, Zed, Gemini CLI; [Mac] Perplexity for Mac). Run `node -v`. You should see: `v20.10.0` or later.

Before 0.2.0 is on npm (npm has 0.1.4):

- [ ] GitHub → Hotragn/husk → Actions → **desktop** → the run for the newest green commit on `main`. Write that commit at the top. You should see: a green run with the artifacts `husk-desktop-windows-latest` and `husk-desktop-macos-latest`.
- [ ] [Win] Download `husk-desktop-windows-latest` and unzip it. You should see: `Husk Setup 0.2.0.exe`. It is unsigned.
- [ ] [Mac] Download `husk-desktop-macos-latest` and unzip it. You should see: a `.dmg`. It is unsigned (unverified: GitHub builds it on an Apple-silicon runner, so it may not run on an Intel Mac).
- [ ] Clone and build the same commit, in a folder with no spaces in its path (for example `~/husk`): `git clone https://github.com/Hotragn/husk.git husk`, `cd husk`, `git checkout <commit>`, `npm ci`, `npm run build`. You should see: every command ends without an error.
- [ ] Only if the artifacts are gone (unverified: GitHub keeps them about 90 days): build the installer from the clone with `cd apps/desktop`, `npm ci`, `npm run stage`, `npx electron-builder --publish never` ([Mac] run `export CSC_IDENTITY_AUTO_DISCOVERY=false` first). You should see: the installer in `apps/desktop/dist`.
- [ ] In every terminal you use for Husk (not in your profile), from the `husk` folder, point `husk` and the chat apps at this build. [Win] PowerShell: `$repo = (Get-Location).Path; function husk { node "$repo\packages\cli\dist\bin.js" @args }; $env:HUSK_LAUNCH = @{ command = (Get-Command node).Source; args = @("$repo\packages\mcp\dist\bin.js") } | ConvertTo-Json -Compress`. [Mac] zsh: `repo=$PWD; alias husk="node $repo/packages/cli/dist/bin.js"; export HUSK_LAUNCH="{\"command\":\"$(command -v node)\",\"args\":[\"$repo/packages/mcp/dist/bin.js\"]}"`. You should see: `husk version` prints `0.2.0`, then a line `node … · state in …`.
  - Why: without `HUSK_LAUNCH`, `husk setup` writes `npx -y @husk-ai/mcp@~0.2` into each chat app, and bots on Claude Code or Codex start it too. npm cannot serve that until 0.2.0 is published. The desktop app does not need it.
  - [Win] The PowerShell `husk` drops a `--`. Where a step says `husk exec … -- …`, type `node "$repo\packages\cli\dist\bin.js" exec …` instead.
- [ ] Build the Claude Desktop extension: `npm run bundle:mcpb`. You should see: `Bundle: …husk-0.2.0.mcpb`.

After 0.2.0 is on npm (skip the `HUSK_LAUNCH` line):

- [ ] Download the installers from https://github.com/Hotragn/husk/releases/tag/v0.2.0, and run `npm install -g @husk-ai/cli@0.2.0`. You should see: an `.exe`, a `.dmg` and a `.zip` on the release (unverified: their exact names); `husk version` prints `0.2.0`.

Signed installers, once the certificates are repository secrets:

- [ ] Actions → **release** → Run workflow with `dry_run` on. You should see: the artifacts `husk-desktop-release-windows-latest` and `husk-desktop-release-macos-latest`. The desktop job runs only after the publish job, which checks the npm token even on a dry run.
- [ ] [Win] `Get-AuthenticodeSignature "Husk Setup 0.2.0.exe"`. You should see: `Valid`.
- [ ] [Mac] After installing it, `spctl --assess --type execute --verbose "/Applications/Husk.app"`. You should see: `accepted` and `source=Notarized Developer ID`.

## 2. Install (J4 gate: a fresh install)

- [ ] Start clean. Quit the chat apps and any running Husk: tray → Quit and stop Husk, or [Win] `Stop-Process -Id (Get-Content "$HOME\.husk\daemon.json" -Raw | ConvertFrom-Json).pid`, [Mac] `kill $(node -p "require(require('os').homedir()+'/.husk/daemon.json').pid")`. Rename `~/.husk` to `.husk-before-test` if it exists. You should see: http://127.0.0.1:7377/health does not load.
- [ ] Optional, upgrade from 0.1.4: on one machine that used 0.1.4, keep `~/.husk` instead. You should see: later, `husk ps --all` lists the old computers, and Connect shows the old chat-app entries as "older Husk".
- [ ] [Win] Run `Husk Setup 0.2.0.exe`. SmartScreen warns about an unsigned app: More info → Run anyway. If asked, install for yourself only (unverified: Windows' and the installer's wording). You should see: Husk installs and starts; its icon appears in the tray.
- [ ] [Mac] Open the `.dmg`, drag Husk to Applications, and open it from there. If macOS blocks it: System Settings → Privacy & Security → Open Anyway; if it says the app is damaged, run `xattr -dr com.apple.quarantine /Applications/Husk.app` (unverified: macOS's own steps for an unsigned app). You should see: the Husk icon in the menu bar.
- [ ] The first window. You should see: the Husk window opens on Connect and asks "Show a chat’s computer when the chat starts using it?" with Show it and Only when I click it. Choose Show it.
- [ ] Hover the tray icon. You should see: `Husk · 0 computers running`.
- [ ] Open http://127.0.0.1:7377/health. You should see: `"ok":true` and `"version":"0.2.0"`.
- [ ] Open `desktop.log`. You should see: `updates are announced, not installed: this build is not signed, or is a Linux one` (unverified: until a release carries the installers, an `update check failed` line may follow; that is expected).
- [ ] Open Husk again from the Start menu or Applications while it runs. You should see: the Husk window comes forward, and there is still one tray icon.
- [ ] Find your setup with `husk doctor`. You should see under COMPUTERS: [Docker] `✓ docker   isolated`; [WSL 2] `✓ local    not isolated` with `via WSL2 (<your distro>)`, and docker `✗` with "docker is installed but the daemon is not reachable" (or "the docker CLI is not on PATH"); [No WSL] local with `via Windows host shell (no WSL) -- commands are NOT Linux` and ``fix: run `wsl --install` for a real Linux shell, or start Docker for actual isolation``; [Mac, no Docker] local with `via /bin/sh on the host`.
- [ ] [Win] To try each setup on one PC: start with Docker Desktop running, then quit it for [WSL 2]. [No WSL] needs a PC where `wsl -l -q` lists nothing, or only `docker-desktop` with Docker Desktop not running. Do not remove a distro to get there: that deletes it.
- [ ] [Mac] With Docker Desktop running and Husk opened from Applications (not a terminal), look at Connect → Where computers run. You should see: docker available. If not, `desktop.log` says `<shell> gave no PATH; keeping …`.

## 3. Connect each chat app

### 3a. From the desktop app's Connect page

- [ ] Connect → Where computers run: keep the recommended one; with docker, leave Include a browser on; click Test this computer. You should see: `✓ <provider> answered in N s:` then `Linux …` ([Docker], [WSL 2]), `Microsoft Windows [Version …]` ([No WSL]) or `Darwin …` ([Mac, no Docker]). The first docker test fetches Playwright's image (about 2 GB) with no progress shown (unverified: how long it takes).
- [ ] Look at Chat apps. You should see: each app marked found, not found, connected or older Husk, with the file or command it changes under its name.
- [ ] Whenever you change setup later, pick the new computer here and click Connect again for each app you test, then restart that app. The computer is written into each app's entry.
- [ ] For every app below: click Connect, do what its message says, start a new chat and ask "Use Husk to tell me what OS your computer runs." You should see, for every app: an answer naming the computer's OS, a new computer in the corner, and the app's name when you hover it.
- [ ] Claude Desktop. You should see: "added to Claude Desktop. Quit Claude Desktop fully and open it again." and a Backup path; the corner label Claude Desktop.
- [ ] Claude Desktop's Code tab (same entry; ask in the Code tab). You should see: another computer, also labelled Claude Desktop.
- [ ] Claude Code. You should see: "added to Claude Code. Start a new Claude Code session." (no backup); the label Claude Code.
- [ ] Codex CLI. You should see: "added to Codex CLI. Start a new Codex session."; the label Codex. (unverified: the Codex IDE extension and the ChatGPT desktop app read the same `~/.codex/config.toml`, as docs/clients.md says.)
- [ ] Cursor. You should see: "added to Cursor. Restart Cursor, then check Settings, MCP."; husk under Settings → MCP; the label Cursor.
- [ ] VS Code (Copilot Chat in Agent mode). You should see: "added to VS Code. Reload VS Code. Husk appears in the Copilot chat tools."; the label VS Code.
- [ ] Windsurf (Devin Desktop). You should see: "added to Windsurf (Devin Desktop). Restart Windsurf or Devin Desktop."; the label Windsurf, or the name the app gives itself (write it down).
- [ ] Zed. You should see: "added to Zed. Open Zed’s Agent Panel settings: Husk is in its MCP servers. Restart Zed if it is not."; Zed's `settings.json` keeps its comments; the label Zed.
- [ ] Gemini CLI. You should see: "added to Gemini CLI. Start a new Gemini CLI session."; the label Gemini CLI.
- [ ] [Mac] Perplexity for Mac, by hand: Plugins → Add custom; name `husk`; command `<full path of node> <repo>/packages/mcp/dist/bin.js` (after the release: `npx -y @husk-ai/mcp@~0.2`). You should see: an answer; the corner label is the name Perplexity gives itself (write it down).
- [ ] Open one app's settings file (Connect shows its path). You should see: the `husk` entry starts the Husk app itself, with `ELECTRON_RUN_AS_NODE` set to `1` and `…runtime/node_modules/@husk-ai/mcp/dist/bin.js` as its first argument ([Win] `…\Husk.exe`; [Mac] `/Applications/Husk.app/Contents/MacOS/Husk`); the app's other servers are unchanged. (unverified: the Windows folder, likely `%LOCALAPPDATA%\Programs\Husk`.)
- [ ] Optional, a 0.1.4 entry: in any folder run `claude mcp add husk -- npx -y @husk-ai/mcp`, then reload Connect. You should see: Claude Code marked older Husk, with Update. Update says "added to Claude Code. Its own entry in one project now starts this Husk too. Start a new Claude Code session."

### 3b. From a terminal (`husk setup`)

- [ ] Run `husk setup`. You should see: "WHERE SHOULD YOUR CHATS’ COMPUTERS RUN?" with the five computers, each `✓ isolated`, `✓ not isolated`, or `✗` with its reason and a `fix:` line, one marked `(recommended)`; then "Pick one".
- [ ] Press Enter. With docker or podman, press Enter again at "Include a browser? The image is larger, and pages render like in Chrome." You should see: "CHAT APPS ON THIS MACHINE", each app found, connected, not found, or "older Husk, moves here". The apps you connected in 3a show "older Husk, moves here", because their entry starts the Husk app and not this build.
- [ ] Type Claude Code's number only, then press Enter at "Connect these? Each file is backed up first." You should see: `will edit claude mcp add --scope user husk -- <node> <repo>…bin.js`; `✓ Claude Code: added to Claude Code. Start a new Claude Code session.`; with docker, "getting the computer image, once: mcr.microsoft.com/playwright:v1.59.1-noble (about 2 GB, with the browser)" if it was not there yet; then NEXT with `computer`, a `console` link, and `try it   ask your chat: "Use Husk to tell me what OS your computer runs."`.
- [ ] Start a new Claude Code session and ask that. You should see: the answer, and its computer in the corner.
- [ ] Back on Connect, Claude Code now shows older Husk. Click Update. You should see: Claude Code starts the Husk app again (section 8 needs that).
- [ ] After the release only: Connect → "Or let your chat set it up" → pick Claude Code → Copy prompt, and paste it into Claude Code. You should see: the chat runs `npx -y @husk-ai/cli@~0.2 setup --computer auto --apps claude-code --yes` and tells you to restart. Before the release this fails: npm has no 0.2.

### 3c. What each app supports (J6-a: the unverified cells in docs/clients.md)

- [ ] Names and processes: do part 1 of docs/evals/running-the-checks.md (the probe) for Claude Desktop (a chat and the Code tab) and Cursor, and also for VS Code (under `servers`, with `"type": "stdio"`), Windsurf (`~/.codeium/windsurf/mcp_config.json`) and [Mac] Perplexity for Mac. Use two chats in each. [Mac] Give `command` the full path of node (unverified: a Mac app may not find `node` by name). You should see in `mcp-probe.log`: Claude Desktop's chat `"client":"claude-ai"`; its Code tab `local-agent-mode-husk-probe`; Cursor `cursor-vscode`; both Claude Desktop chats with one pid; both Cursor chats with one pid. For VS Code, Windsurf and Perplexity, write down the name and whether two chats share a pid. A `start` with no `initialize` means the app opened with the newer protocol: write that down too.
- [ ] Protocol versions and what each app declares: each `initialize` line also has the `protocol` the app asked for and the `capabilities` it declares. You should see: Claude Desktop's chat on 2025-11-25 (community). Write down the rest: not documented for its Code tab, Cursor, Windsurf and Perplexity.
- [ ] "Done?" in the chat: in each app ask "Sign in to https://github.com/login on your computer's browser and tell me the name on the account." You should see: Claude Code, Cursor and VS Code show a form in the chat with your reason, "Open <link> on this device to see and use the computer's browser. Answer here when you are done.", and an "I'm done" box. Every other app gives you a link and asks you to say when you are done. (unverified: Claude Desktop's and Codex's "declared, not shown"; Husk never asks them in the chat.)
- [ ] Claude Code on the older protocol: start `claude` with `MCP_PROTOCOL_NEGOTIATION=legacy` set, and repeat the sign-in. You should see: the same "I'm done" form.
- [ ] Long calls: in each app ask "Run a command on your computer that waits 58 seconds, then prints done." You should see: Claude Code, Claude Desktop's chat, VS Code and Gemini CLI get done from one call. The Code tab, Codex, Cursor, Windsurf, Zed and Perplexity get, after 50 s, `<tool> is still running after 50s, and goes on in the computer. Call job_wait with job "<id>" for its result.`, then done from `job_wait`. No app gives up first. (This shows each app waits at least 50 s; the exact limits marked community or not documented stay unverified.)
- [ ] Cards: ask Claude Desktop, Cursor and VS Code "Call computer_info." You should see: a Husk computer card in the chat. In Claude Code: no card, and a link to the computer.
- [ ] Prompts: open each app's prompt list. You should see Husk's three prompts (Set up a project, Research a topic with sources, Fill out a web form with me): in Claude Desktop's "+" menu, in Claude Code as `/husk:…`, in VS Code as `/husk.…`. Cursor: write down where they show (not documented).
- [ ] [No WSL] Tool list changes: after the first Husk call in Claude Desktop and in Cursor, find the `shell` tool's description. You should see: "…running cmd.exe on Windows, NOT Linux…" where the app took Husk's `tools/list_changed`. Write down which app did (not documented; reported ignored by Cursor). (unverified: where each app shows a tool's description.)
- [ ] Claude Desktop's elicitation (not documented; reported not shown). You should see: whether `elicitation` is among its `capabilities` in `mcp-probe.log`; write it down. Whether it shows a form stays unverified: Husk never asks Claude Desktop in the chat.

### 3d. The Claude Desktop extension (workspaces)

- [ ] On Connect, click Disconnect for Claude Desktop, so it does not get two Husks. In Claude Desktop: Settings → Extensions → Advanced settings → Install Extension → `build/husk-0.2.0.mcpb`. You should see: an install prompt for an unsigned extension, then Husk under Extensions.
- [ ] Ask "Create a Husk workspace called My first brief and open its viewer." Open the link, add a public page, choose Cited brief → Copy prompt, paste it into the chat, then Review & download → Export workspace. You should see: the page's text captured; the chat saves a result; the viewer shows it; a ZIP downloads.
- [ ] In the viewer open Advanced · computer tools. You should see: the provider and how isolated it is, before anything turns on. Then remove the extension, and click Connect for Claude Desktop again.

## 4. A chat uses its computer

Use a new Claude Code session unless a line says otherwise. [Win] Do this section once for each setup you have.

- [ ] Ask "Call computer_info." Expand the tool result. You should see it start with: [Docker] `[husk] docker container cmp_…, isolated from the host. /work persists for this session.`; [WSL 2] `[husk] local computer cmp_… on real Linux via <distro>. This is a guarded working directory, NOT a sandbox…`; [No WSL] `[husk] local computer cmp_… running on cmd.exe, NOT Linux.` and later ``the user can run `wsl --install` to fix it`` (unverified: the rest of computer_info may fail on cmd.exe); [Mac, no Docker] `[husk] local computer cmp_… on the host shell. This is a guarded working directory, NOT a sandbox…`.
- [ ] Ask "Run uname -a, or ver on Windows, and show me the output." You should see: Linux ([Docker], [WSL 2]), `Microsoft Windows [Version …]` ([No WSL]), or Darwin ([Mac, no Docker]).
- [ ] Ask "Write hello from husk to /work/hello.txt, then read it back." Then in the Husk window open Advanced → Files. You should see: the text read back; `hello.txt` in Files. [No WSL]: the computer's folder is a real Windows path under `.husk\workspaces\cmp_…\root`.
- [ ] Ask "Open https://example.com in your browser and tell me the page title." You should see: [Docker] "Example Domain", and the page live in the Computers window. [WSL 2] the same, or a refusal like "browser setup is missing N system libraries; no download was attempted" that names them (unverified: a fresh Ubuntu may lack them).
- [ ] [No WSL] and [Mac, no Docker]: ask the same. You should see: no rendered browser, and the chat says why ([Mac, no Docker] "automatic Chromium installation needs Linux; this computer reports Darwin", or that it needs Python 3). Then "Read https://example.com" (the `browse` tool) still works. (unverified: the [No WSL] wording, likely "the computer could not run a command, so the browser cannot start"; whether `browse` works on [No WSL]; whether macOS offers to install its developer tools when Husk looks for python3.)
- [ ] Ask "Take a screenshot of the page and show it to me." You should see: a picture of Example Domain in the chat.
- [ ] [Docker] or [WSL 2] Lightpanda: add `"browser": "lightpanda"` to `~/.husk/config.json` (if the file does not exist, make it `{ "browser": "lightpanda" }`), start a new session, and ask "Call browser_status, then open https://example.com and tell me the title." You should see: `husk doctor` SELECTION says `browser lightpanda`; browser_status starts "This computer's browser is Lightpanda: lighter than Chrome, and it draws no screen."; the title comes back.
- [ ] Then ask for a screenshot. You should see: "this computer's browser moved from Lightpanda to Chrome, because a screenshot was asked for." Remove the setting afterwards.
- [ ] Ask "Give me a link to watch your computer." You should see: a link (`computer_open_ui`) that opens the computer's page in your browser, with Take over.
- [ ] Hand-off: ask "Sign in to https://github.com/login on your computer's browser and tell me the name on the account." You should see: a notification "Waiting for you" with the reason; the corner computer glows amber; the tray says "1 waiting for you" and lists "Take over: <reason>"; the Computers window shows "Waiting for you. <reason>" and a Done button; in Claude Code, the "I'm done" form.
- [ ] In Claude Desktop, ask for the same sign-in; when it gives you the link, ask it to run any command. You should see: `E_COMPUTER_HELD (handoff): The user has the computer right now (handoff hnd_…: <reason>). …`.
- [ ] Sign in on the computer's screen (in the Computers window or through the link). Then press Done → Hand back to the chat in the window, or tick "I'm done" in the chat. You should see: the chat takes the computer back and tells you the account name. Through the link: "Paused, waiting for you", then Done → "Yes, hand back to the agent" → "Handed back. Your AI chat has the computer again. You can close this tab."; then tell the chat you are done.
- [ ] Take over mid-call: ask "Run a command that waits 30 seconds, then prints finished." While it runs, click Take over in the Computers window. You should see: "Taking over: waiting for shell to stop…", then "You have it" and Give back; the corner computer glows teal; the tray says "you hold 1" and lists "Give back: <label>"; the chat is told "The user took over this computer while this call was running, so it was stopped part-way…" and says it is paused.
- [ ] While you hold it, open another page on the screen. Give it back, then ask the chat to click a link on the page it had. You should see: "The user changed the page while they had the computer: it is now … (it was …). This call was not run: take a browser_snapshot…", and the chat looks again and carries on.
- [ ] Give back from each place: take over and give back once each from the Computers window, the Husk window (Home → the computer → Open), the tray, and the watch link's page. You should see: each one ends the hold; afterwards the tray holds nothing.
- [ ] Ask "Create a Husk workspace called Test notes and open its viewer." Then, in a new session, "Open my Husk workspace Test notes." You should see: a viewer link both times, on the same workspace.
- [ ] [Docker] Run `husk rm <the computer's id>`. Quit that Claude Code session, resume it (`claude --resume`, pick it), and ask it to read /work/hello.txt. You should see: `✓ destroyed <name> (its files stay for its next computer)`; the resumed session gets a new computer that still has hello.txt.
- [ ] [Docker] Husk window → Advanced → Computers → Delete on that computer, then resume the session again and ask the same. You should see: "Delete cmp_… (<label>)? Its files at …, everything installed on it and its browser’s logins go with it. This cannot be undone."; afterwards the new computer has no hello.txt.
- [ ] [Docker] Quit Docker Desktop, start a new chat, and ask it to run a command. You should see: `Computer unavailable: provider "docker" is not usable: docker is installed but the daemon is not reachable` and ``start Docker Desktop (or `sudo systemctl start docker`), then re-run `husk doctor` `` (unverified: how soon Husk notices). Start Docker Desktop again.

## 5. The desktop app's windows

- [ ] Open the tray menu: [Win] right-click the icon; [Mac] click it (unverified: whether a click on the Mac opens the menu or the window). You should see: the status line; one item per computer; Go to the computers (Ctrl+Alt+Shift+H, [Mac] Cmd+Option+Shift+H); Open Husk; Connect chat apps; Start at login; Show computers on screen; Open the window when a chat starts using a computer; Minimize computers to the notch; Quit (chats keep their computers); Quit and stop Husk.
- [ ] With two or more chats using computers, look at the corner. You should see: one very small 3D computer per computer, bottom right, above the taskbar or Dock, not moving; hovering one shows a tiny label with its chat app's name; nothing opens until you click.
- [ ] Click one. You should see: the Computers window opens small at the bottom right on that computer's tab; the tabs show each app's logo (VS Code its own icon, Codex a monogram); the browser live on a white screen; a status line with what it last did, and Take over.
- [ ] Switch tabs; turn Keep on top (the pin) off and on; Maximize and back; resize. You should see: each works; a maximized window is not kept on top.
- [ ] Close the Computers window. You should see: it hides; the computers stay in the corner and keep running.
- [ ] Minimize it. You should see: the notch, a black capsule hanging from the top centre ([Mac] around the real notch on a MacBook that has one), with each computer's logo; hovering opens a list of what each is doing; clicking one opens the window on it.
- [ ] Press Ctrl+Alt+Shift+H ([Mac] Cmd+Option+Shift+H), then Tab, Enter and Escape. You should see: a ring on the corner (on the notch while minimized); Tab moves, Enter opens one, Escape gives the keyboard back. While you hold a computer, its screen shows a second ring while your keys go to the page.
- [ ] Opens by itself without taking focus: minimize the Computers window, start typing in Notepad ([Mac] TextEdit), and have a new chat make its first Husk call. You should see: the Computers window opens on that computer, and your typing stays in Notepad.
- [ ] [Mac] Minimize to the notch, then check the Dock, Cmd-Tab, and `lsappinfo info -only ApplicationType Husk`. You should see: Husk still in the Dock and in Cmd-Tab; `Foreground`; with another app full screen, the notch still floats over it; clicking Husk in the Dock brings the Husk window back.
- [ ] Two screens: drag the Computers window to the second screen, then unplug that screen. You should see: the window comes back on the main screen at the same size; the corner and the notch follow the main screen.
- [ ] Terminal: Husk window → Advanced → Terminal on a computer, run `sleep 60; echo done` (unverified: on [No WSL], `ping -n 61 127.0.0.1 >nul & echo done` instead). Close the Husk window, then tray → Open Husk. You should see: `done` arrives.
- [ ] Untick, one at a time: Show computers on screen; Minimize computers to the notch; Open the window when a chat starts using a computer. You should see: the corner goes away; minimizing leaves no notch (click the corner to get the window back); a new chat's first call no longer opens the window. Tick them all again.
- [ ] Take over a computer, then close the Computers window. You should see: "You still hold <label>" with Give back and Keep holding. Choose Keep holding.
- [ ] Then tray → Quit (chats keep their computers). You should see: "You still hold <label>" with Give back and quit, Quit and keep holding, and Cancel. Choose Cancel.
- [ ] While you still hold it, stop the shared Husk: [Win] `Stop-Process -Id (Get-Content "$HOME\.husk\daemon.json" -Raw | ConvertFrom-Json).pid`; [Mac] `kill -9 $(node -p "require(require('os').homedir()+'/.husk/daemon.json').pid")`. You should see: the tray says "Husk is not answering · trying again"; the Computers window says "Husk is not answering. The app is trying again; the screen comes back when Husk does." over a cleared screen; within about a minute Husk is back, the tabs return, and the tray still says "you hold 1". Give it back.
- [ ] With a chat's hand-off waiting, tray → Quit and stop Husk. You should see: "Husk is busy" and "A run or a handoff is in progress, so Husk was left running. Quit again when it finishes."
- [ ] Tick Start at login, sign out and back in. You should see: Husk starts by itself. Untick it.
- [ ] Turn on reduced motion ([Win] Settings → Accessibility → Visual effects → Animation effects off; [Mac] System Settings → Accessibility → Display → Reduce motion). You should see: nothing in the corner, the notch or the window moves.
- [ ] [Mac] If Husk Bar ships, run its own list in apps/mac/README.md. You should see: while the desktop app runs, Husk Bar's pill makes way, so there is one notch.

## 6. Make a bot from a chat (J5 gate)

You need Claude Code signed in, and Codex signed in if you have it. For Husk's own engine you need a model: `ollama pull qwen2.5:7b`, or an API key line such as `ANTHROPIC_API_KEY=…` in `~/.husk/.env`. Then tray → Quit and stop Husk, and open Husk again, so it reads the file. `husk models` should list at least one model.

In the Husk window:

- [ ] Home → the Claude Code chat's computer → Open → Make this chat a bot → Make this a bot. You should see: Runs on "Your Claude Code, continuing this chat", with "Your own Claude Code, on your own login, goes on with this chat on its computer, with Husk's tools only."; "Draft for <name> · confidence N%. Read it before saving."; YAML with `engine:`, `type: claude-code` and `resume: <session id>`.
- [ ] Click Save as a bot. You should see: "Saved as <name>. Run it from Husks."
- [ ] Advanced → Husks → Make a bot from a chat → Find chats on this computer. Use this chat on a Codex chat. You should see: chats listed as "Claude Code · <title>" or "Codex · <title>" (and Cursor or Gemini CLI ones, if you have them); a draft that runs on "Your Codex". Save it.
- [ ] Upload an export: ChatGPT's `conversations.json`. You should see: "This file holds N chats. Which one?" with Use this one; a draft that runs on your Claude Code or Codex.
- [ ] In that draft, set Runs on to "Husk's own engine, on any model", and save it.
- [ ] Husks → the Claude Code bot → Playground → Input "List the files in /work and say what you find." → Run. You should see: Runs on Claude Code in the table; the steps stream; the warning "Claude Code counts a continued chat’s earlier spend in its cost, so this run shows its tokens and no cost"; the answer names the chat's own files.
- [ ] The same for the Codex bot. You should see: a run on Codex, with Husk's tools only.
- [ ] Husks → the bot on Husk's own engine → Playground: Input "Write hello to /work/hi.txt and read it back.", choose a model under Model override, keep Approvals on ask, Run. You should see: "Approval required" for each dangerous tool; after you approve, the run ends with the model's answer.
- [ ] During a long Playground run, Take over its computer in the Computers window, wait, then Give back. You should see: "Paused: a person took over the computer. The run goes on when they give it back."; the run goes on after Give back.
- [ ] Give a saved bot a trigger (Husks → its YAML → Save): set its `triggers:` to `- type: cron`, `schedule: '*/2 * * * *'`, `prompt: Say hello.` You should see: `jobs.json` and `jobs.log` appear in `~/.husk`; within two minutes the bot's Runs count goes up. Remove the trigger and save: `jobs.json` goes away.
- [ ] [Mac] With Husk opened from Applications (not a terminal), run the Claude Code bot. You should see: it finds your `claude` (Husk took your login shell's PATH).

With `husk`:

- [ ] `husk import`, then pick a Claude Code chat when asked (or `husk import --pick <n>`). You should see: "Found N transcripts" and a table; then `✓ imported <title>` with its id, and `Next: husk distill <id> --no-model`.
- [ ] `husk distill <id> --out bot.yaml`. You should see: `✓ wrote …bot.yaml`; EXTRACTED with `runs on   Claude Code, under your own login, going on with this chat` and a confidence bar; `Next:` with `husk validate bot.yaml` and `husk run bot.yaml "hello"`. With neither Claude Code nor Codex installed: `runs on   Husk's own engine · it needs a model: an API key, or a local one`.
- [ ] `husk distill <id> --engine codex --out bot-codex.yaml`, and `husk distill <id> --engine builtin --no-model --out bot-own.yaml`. You should see: `runs on   Codex, under your own login`, and `runs on   Husk's own engine …`. For an engine that is not installed: `--engine codex is not one this chat can run on here`.
- [ ] `husk validate bot.yaml`, then `husk run bot.yaml "What files are in /work?"`. You should see: a header with `husk <name>`, `engine claude-code continuing chat <id>` and `tools Husk's, on its computer`; the steps; the answer; `N steps · … · … tokens`. (Before the release without `HUSK_LAUNCH`: "Husk's tools did not start in Claude Code (…); ~/.husk/daemon.log may say why".)
- [ ] `husk run bot-own.yaml "Write a short poem about computers to /work/poem.txt" --model <one from husk models>`. You should see: a header with `model <id>` and `computer created on first use`; the file written; `N steps · … · … tokens · $…` or `· free`. This is the J5 gate's real-model run.
- [ ] Take over that bot's computer while `husk run bot-own.yaml …` runs. You should see: the run goes on. `husk run` on Husk's own engine runs in your terminal, outside the shared Husk, so a take-over does not reach it yet (the docs say so; the fix waits until after launch). Give the computer back.
- [ ] Press Ctrl-C during a `husk run bot-own.yaml …`. You should see: the run stops; ``the computer is still up — `husk ps` to see it, `husk rm <name>` to remove it``.

## 7. Notes kept between a bot's runs

- [ ] In `bot-own.yaml`, put `enabled: true` under `memory:` (add `memory:` if the file has none). Run `husk run bot-own.yaml "The project is called Blue Falcon. Save that in your notes."`. You should see: `memory` in the header's tools line and a `memory` call; a file in `~/.husk/bots/<name>/memory/`.
- [ ] `husk run bot-own.yaml "What is the project called?"`. You should see: it reads its notes and says Blue Falcon.
- [ ] Change the name in that note file by hand to Red Falcon, and ask again. You should see: Red Falcon.
- [ ] Same notes on another engine: `husk distill <id> --engine claude-code --name <bot-own's name> --out bot-cc.yaml`, set `enabled: true` under its `memory:` the same way, then `husk run bot-cc.yaml "What is the project called?"`. You should see: Red Falcon, read through Husk's `memory` tool.
- [ ] `husk run bot-own.yaml "Save this in your notes: ghp_abcdefghijklmnopqrstuvwxyz0123456789"`. You should see: the note holds `ghp_ab...[redacted]`, not the made-up token.
- [ ] Add `  backend: sqlite` under `memory:` and run again. You should see: "memory.backend sqlite is not built yet, so this run keeps no notes between runs; use file". Take the line out.
- [ ] Put `enabled: false` under `computer:` (add `computer:` if the file has none) and run again. You should see: no computer tools in the header's tools line; `memory` is still there.

## 8. Update the desktop app (J4 gate: an update)

This needs two releases that carry the installers (release.yml's desktop job). The first chance is after 0.2.0 ships.

- [ ] Install the older release (for example 0.2.0) from its release page. Connect Claude Desktop from Connect, and check a chat gets its computer.
- [ ] Publish the next release (for example 0.2.1) as docs/RELEASING.md says. Then tray → Quit (chats keep their computers), and open Husk again: it looks for updates as it starts, then every six hours.
- [ ] Unsigned build. You should see: a notification "Husk 0.2.1 is out" with "Download it from its release page."; the tray item "Download Husk 0.2.1", which opens https://github.com/Hotragn/husk/releases/latest; nothing installs by itself. Install the new one by hand ([Win] run the new installer; [Mac] replace Husk in Applications).
- [ ] Signed build. You should see: `desktop.log` says "updates install themselves: this build is signed"; a notification "Husk 0.2.1 is ready" with "Restart Husk from the tray to update. Your chats keep their computers."; the tray item "Restart to update to Husk 0.2.1"; Husk restarts as the new version.
- [ ] Either way. You should see: http://127.0.0.1:7377/health shows the new version; the chat connected before still gets its computer; its entry still starts the Husk app.
- [ ] [Mac] Moving the app (works before any release): tray → Quit and stop Husk. Copy Husk.app to the Desktop and open the copy. You should see: "Move Husk to your Applications folder?" with Move to Applications and Not now. Choose Not now, then on Connect click Connect again for Claude Desktop.
- [ ] [Mac] Tray → Quit and stop Husk, then open Husk from Applications. You should see: a notification "Your chat apps start this Husk now" with "One chat app moved to this version. Restart them to use it."; `desktop.log` has `chat app claude-desktop: now starts this Husk`. Delete the copy.

## 9. Remove everything

- [ ] Connect → Disconnect for each app, or `husk setup --remove`. You should see: "removed from <app>", with a Backup for apps that have a file; `husk setup --remove` asks "Remove Husk from <apps>?" and prints `✓ <app>: removed from <app>`; each app's other servers stay; run again, it says "Husk is not connected to any chat app here."
- [ ] `husk rm --all --erase --force`. You should see: `✓ destroyed N computers`, or `nothing to remove`.
- [ ] [Docker] `docker ps -a --filter label=husk.provider=docker` and `docker volume ls --filter name=husk-`. You should see: nothing listed. To get the disk space back: `docker image rm mcr.microsoft.com/playwright:v1.59.1-noble`, and any image `docker image ls husk-packages` lists.
- [ ] [WSL 2] `wsl -e sh -c 'ls ~/.husk/workspaces'`. You should see: no `cmp_` folders left (unverified: that `--erase` empties the distro's folder too).
- [ ] Tray → Quit and stop Husk. You should see: http://127.0.0.1:7377/health stops loading.
- [ ] Uninstall the app: [Win] Settings → Apps → Installed apps → Husk → Uninstall; [Mac] drag `/Applications/Husk.app` to the Trash. Remove the Claude Desktop extension if it is still there. You should see: no Husk in the list, and no tray icon after you sign in again.
- [ ] Export any workspace you want to keep, then delete `~/.husk` and the app's settings folder: [Win] `%APPDATA%\Husk`, [Mac] `~/Library/Application Support/Husk` (unverified: Electron's folder for the app). You should see: both gone.
- [ ] Close the terminals with `HUSK_LAUNCH` and the `husk` shortcut; delete the clone, and the `.husk-backup-*` files if you no longer need them. After the release: `npm uninstall -g @husk-ai/cli`. If you made `.husk-before-test`, rename it back to `.husk`.

## 10. Checks that need accounts or servers

### Chat apps on the web (J6-d)

Needs: Docker running; a Tailscale account with Funnel; a claude.ai account (the Free plan allows one custom connector); a ChatGPT plan that can add a custom MCP server (unverified which: search results say Business and Enterprise/Edu); Perplexity Pro, Max or Enterprise; a phone or key that can hold a passkey. Guide: apps/docs/content/guides/remote-access.mdx.

- [ ] Quit the chat apps, then tray → Quit and stop Husk; otherwise `husk serve` says "another husk server (v0.2.0) is already on 127.0.0.1:7377". Run `tailscale funnel --bg 7378`. You should see: your name, `https://<machine>.<tailnet>.ts.net`.
- [ ] `husk serve --remote --public-url https://<your name>`. You should see: `✓ control plane on http://127.0.0.1:7377`; `✓ remote access on https://<your name>/mcp, for its owner only, on docker computers`; `publish port 7378 at that name with your tunnel, e.g. tailscale funnel --bg 7378`; ``claim code XXXX-XXXX-XXXX-XXXX  good for 15 minutes; `husk remote claim` makes a new one``.
- [ ] claude.ai: Customize → Connectors → + Add → Add custom connector → `https://<your name>/mcp`. On Husk's sign-in page type the claim code, make a passkey, then Allow. You should see: claude.ai connected; on the console's Connect page, "Remote access on" and claude.ai under the apps signed in.
- [ ] In claude.ai ask "Use Husk to run uname -a." You should see: a link instead of a result; the link asks for your passkey, then shows the computer and the exact command; Approve, tell the chat, and it runs. "Open https://example.com and tell me the title" runs without asking. The box "Also let … for the next hour" is never ticked for you.
- [ ] In claude.ai ask "Sign in to https://github.com/login on your computer's browser." You should see: a link that asks for your passkey first, then the computer's browser; you type there; Done; then tell the chat.
- [ ] ChatGPT: chatgpt.com/plugins → + → Add custom MCP server → the address, OAuth → read the warning → Create as a plugin → install → @-mention it in a chat. You should see: sign-in with your passkey; the command approval works as in claude.ai.
- [ ] Perplexity: Plugins → Add custom → Connector → Add MCP connector → Remote → the address, OAuth → click the connector to sign in. You should see: it signs in, or fails asking for a client secret (the forum report). Write down which.
- [ ] The web rows of docs/clients.md: ask claude.ai and ChatGPT "Call computer_info." You should see: a Husk computer card in both; Husk's three prompts in claude.ai's "+" menu; write down whether ChatGPT shows them (not documented). Elicitation and `tools/list_changed` stay unverified for both (Husk gives these apps links, not forms).
- [ ] On Connect: Sign out claude.ai; then Switch off; then Switch on; then run `husk remote`. You should see: claude.ai has to sign in again; while off, `https://<your name>/mcp` is a 404 and every app is signed out; `husk remote` prints `remote access on` (or off), the owner, and the apps.

### Signed webhook (sweep)

- [ ] On a `husk serve` you can reach from the internet, with `HUSK_TOKEN` set (apps/docs/content/guides/self-hosting.mdx), save a bot with a trigger `type: webhook`, `path: /gh`, `secret: ${GITHUB_WEBHOOK_SECRET}`, and set `GITHUB_WEBHOOK_SECRET` for the server. In a GitHub repo: Settings → Webhooks → Add webhook; Payload URL `https://<host>/v1/w/<bot>/gh`; Content type `application/json`; the same secret. You should see: GitHub's ping gets in without the token and a run of the bot starts (Husks shows it); after you change the secret on GitHub, Redeliver gets 403 "webhook rejected: signature does not match". (unverified: GitHub may mark the delivery as timed out when the run takes longer than it waits; the run still goes on.)

### Fly (sweep)

- [ ] Create a Fly app and set `HUSK_FLY_TOKEN` and `HUSK_FLY_APP` (apps/docs/content/computers/providers.mdx). It costs a little. You should see: `husk setup` lists fly but does not recommend it.
- [ ] `husk up flybox --provider fly`, then `husk exec flybox --json --timeout 10 -- sleep 60`. You should see: after about 10 s, `"exitCode": 124`, `"timedOut": true`, and `"stderr": "fly api timed out after 10000ms"` with no "[husk] the command may still be running inside the computer: stopping it could not be confirmed". (unverified: what Fly itself answers when its own timeout fires.)
- [ ] `husk exec flybox -- 'cat /proc/[0-9]*/cmdline | tr "\0" " " | grep -c "[s]leep 60"'`. You should see: `0`. Then `husk rm flybox`.
- [ ] Watching a fly computer: on Connect pick fly and click Connect again for one app; have a chat open a page; open its tab in the Computers window. You should see: "Each picture of this screen is a command on the computer, which keeps it awake, so it shows when you look." and a Look button; Look shows the screen for about a minute; while you hold the computer, it shows all the time. Connect the app back to your usual computer.

### The OCI box (sweep)

- [ ] On an Oracle Cloud box with Docker and Husk on it (apps/docs/content/guides/oracle-free-tier.mdx): `husk up meta --packages curl`, then `husk exec meta -- curl -m 5 -sS http://169.254.169.254/`. Add `sudo iptables -I DOCKER-USER -d 169.254.169.254/32 -j DROP` and run it again, then `husk exec meta -- curl -sS -o /dev/null -w "%{http_code}" https://example.com`. You should see: the metadata address answers before the rule and not after it; example.com still gives 200. (unverified: the guide names the `DOCKER-USER` chain but gives no rule; this one is a suggestion.)

### GitHub job logs (sweep)

- [ ] `curl -sSI -H "Authorization: Bearer <a GitHub token>" https://api.github.com/repos/Hotragn/husk/actions/jobs/<a job id>/logs`. You should see: a `location:` header; write down its host. examples/ci-triage.yaml allows only `*.github.com` and `objects.githubusercontent.com`; if the host is another one, that list needs it (unverified: which host GitHub uses).
- [ ] With a model, `husk run examples/ci-triage.yaml "Why did <a failed run's URL> fail?"`. You should see: it reads the failing log, or says which host was refused.

### Discord (sweep)

Put each bot token in `~/.husk/.env` before you save the bot whose trigger uses it, while no other bot has a trigger: the job host reads the file when it starts.

- [ ] A Discord test bot with MESSAGE CONTENT INTENT off. Put `DISCORD_BOT_TOKEN=…` in `~/.husk/.env`, then save a bot with a trigger `type: discord`, `channels: ['<channel id>']`. You should see in `jobs.log`, once and with no reconnect loop: "discord closed the gateway with 4014: a privileged intent is not enabled -- turn on MESSAGE CONTENT INTENT in the Developer Portal -- not reconnecting".
- [ ] Turn the intent on. Remove the bot's trigger and save, then put it back and save (unverified: a simpler restart may do). Mention the bot in that channel. You should see: the bot replies.

### Slack and Telegram (test tokens)

- [ ] Slack: `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` in `~/.husk/.env`, then a bot with `type: slack` and its channel. Mention it. You should see: a reply.
- [ ] Telegram: `TELEGRAM_BOT_TOKEN` in `~/.husk/.env`, then a bot with `type: telegram` and `allowlist: ['<your username>']`. Message it. You should see: a reply; someone not on the list gets none.

### Husk on Fly (after 0.2.0 is on npm)

- [ ] Deploy `deploy/fly/` as the remote access guide says, run `fly ssh console --app <app> -C "husk remote claim"`, and add `https://<app>.fly.dev/mcp` to claude.ai. You should see: the same sign-in and approvals as above.
