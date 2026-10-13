# Husk persona test

2026-10-12, one Windows laptop, seven simulated first-time users. Everything below was observed. Where something couldn't be tested here, it says "not tested" and why.

## How this was run

- **Machine:** Windows 11 Home 10.0.26200 (ARM64), 15.6 GB RAM, 10 cores. Node 24.14.0, npm 11.9.0, Python 3.14.3.
  - Docker Desktop is installed, but its daemon wasn't running.
  - WSL2 has Ubuntu installed (stopped at the start).
  - Ollama is running with 7 models: qwen2.5:7b, qwen2.5:1.5b, llama3.2, qwen3:4b-instruct, granite4 and two fine-tunes.
  - Claude desktop, Claude Code 2.1.296 and the OpenAI Codex app and CLI 0.147.0 are installed. ChatGPT desktop and the Gemini CLI are not.
- **Husk already on the machine:**
  - Claude Code had a `husk` MCP server pointing at a local build in this repo. I didn't use it.
  - Codex had a `husk` entry identical to the website's command (`npx -y @husk-ai/mcp`).
  - Claude Desktop had no Husk extension.
- **Public versions:**
  - `@husk-ai/mcp` and `@husk-ai/cli` on npm: latest **0.1.4** (2026-09-23).
  - The 0.2.0 workspace preview exists only as an unsigned `husk-0.2.0.mcpb` on a GitHub prerelease. The release page says "No npm package was published by this preview."
- **How the AI apps were played:** each person's AI app was a fresh headless Claude (`claude -p`, no other MCP servers, no built-in tools) or `codex exec`. I typed what the person would type. To keep everything inside this folder, `HUSK_HOME` pointed into a test folder; on WSL, Husk ignored it (see Priya).
- **Validity correction:** inside this repo, `npx @husk-ai/mcp` and `npx @husk-ai/cli` quietly run the repo's own 0.2.0 build, because the packages are linked into `node_modules`. My first Priya, Dev and Alex runs hit that by accident. I then installed the public 0.1.4 into its own folder (174 packages, 22 s) and reran all three on it. The results below are from 0.1.4 unless a line says otherwise.
- **Timings** are machine time for each step, not how long a human would spend reading.

## 1. Scores

Scores run 1 to 5; 5 is best. For "Effort", 5 means almost no effort.

| Person | Finished | Effort | Better than current tools | Would install | Verdict |
|---|---|---|---|---|---|
| Maya (ChatGPT, no terminal) | 1 | 1 | 1 | 1 | Husk has no ChatGPT route, so she's out before installing anything. |
| Sam (Claude desktop, cited essay) | 4 | 3 | 3 | 3 | Sources saved with URL and date, and they reopen in a new chat. One of three articles was too big to use. |
| Priya (analyst, ChatGPT) | 3 | 2 | 1 | 1 | Got a chart through Codex and Husk, then was told to open a path that doesn't exist. Codex alone did it better. |
| Dev (Claude Code daily) | 4 | 3 | 2 | 2 | The scraper and web app worked, but the website's install line fails in PowerShell, and Claude Code already has a shell. |
| Alex (worried about injection) | 3 | 3 | 3 | 2 | Got a clear, honest answer about what the AI can reach: almost everything. The Docker half couldn't be tested. |
| Jordan (free local models) | 5 | 4 | 4 | 4 | A free Ollama model did a real task with no key or account. The best fit here. |
| Taylor (morning page watch) | 1 | 1 | 1 | 1 | `husk serve` loaded no bots and nothing could notify them. Free page-watch services already do this job. |

## 2. Who has a need their current tools don't meet

**Jordan.** In their words: *"I want my free local model to actually do something on my computer, not just chat, without paying for an API key."* On its own, Ollama only chats; it can't run commands or fetch pages. With `husk run` and `model: local`, a 4.2 GB local model fetched a public file, ran `grep` and answered correctly (644 lines, which I checked separately). It cost nothing.

**Sam is a weaker second.** *"I need to keep the actual sources next to my summary so I can check them before I hand the essay in."* Claude Desktop can summarise pages, but it doesn't keep a dated copy of each source's text next to the output. Husk did, and it reopened that copy in a new chat. The catch: this only exists in the unsigned 0.2.0 desktop file, and long pages break it (problem 5).

Nobody else has an unmet need:
- **Maya, Priya and Taylor** aren't served at all: their AI is ChatGPT, or they need notifications.
- **Dev** already has a shell in Claude Code.
- **Alex** learned that the default provider is the risk he was worried about.

## 3. Features that mattered, and ones nobody needed

**Mattered:**
- **Workspaces** (`workspace_create`, `source_add`, `workspace_open` by name in a new chat). Sam's whole result depended on them.
- **`husk run` with `model: local` and `husk doctor`.** Jordan's whole result. Doctor found Ollama and picked a model with no setup.
- **The isolation warning in the first tool result:** "a guarded working directory, NOT a sandbox… shell commands can still reach anything your user can on the host". It was accurate, and the AI passed it straight to Alex.
- **`expose_port`, shell and file tools.** They worked for Dev, but Claude Code can already do that.

**Nobody needed or noticed:**
- Chat-to-bot (`import`, `distill`).
- The 13 `browser_*` tools.
- The `ssh` and `fly` providers.
- The eleven model providers (only Ollama was used).
- Discord, Slack and Telegram adapters: the docs say they're "never mounted".
- `husk serve`'s control plane, which Taylor couldn't use.

## 4. Top five problems that blocked or slowed people

1. **There's no route for ChatGPT users** (Maya, Priya, Taylor). The hero says "Add Husk to Claude Code, Codex or Cursor". The only ChatGPT mention is as a transcript you can import. The FAQ, MCP, quickstart and troubleshooting pages have no ChatGPT host either. Maya stopped at the homepage.
2. **The website's one-line install fails in Windows PowerShell.** Running `claude mcp add husk -- npx -y @husk-ai/mcp` printed `error: unknown option '-y'`: PowerShell swallows the `--` before it reaches the `claude.ps1` shim. The same line works in cmd.exe, and in PowerShell with `'--'` quoted.
3. **The install line and the product described don't match.** The homepage promises a workspace "you can reopen tomorrow". `npx -y @husk-ai/mcp` installs 0.1.4, whose tool list has **no** `workspace_*` tools (Dev's 0.1.4 run listed only computer and browser tools). Workspaces exist only in the unsigned 0.2.0 `.mcpb` from GitHub, which the release itself says "have not yet been observed with beta users."
4. **People can't find what they made.**
   - **Priya, 0.2.0 run:** the AI told her to open `\\wsl.localhost\Ubuntu\work\co2_mlo_analysis\co2_mlo_line_chart.png`. That path does not exist. The file was in `\\wsl.localhost\Ubuntu\home\hotragn\.husk\workspaces\cmp_6fwd0x7h4p24\root\co2_mlo_analysis\`.
   - **Priya, 0.1.4 run:** the AI told her to "open `/work` in the Husk UI/file browser". There is no such UI for computer files.
   - **Sam:** `workspace_export` returns only a viewer link, and that link stops working when the connection ends. The AI also re-quoted the dead link from the previous turn.
   - **Dev:** the web app answered while the chat was open (the AI got HTTP 200 through Windows `curl.exe`). Within a minute of the chat ending, both ports gave empty replies (curl exit 52), yet the `python3 app.py` processes kept running. One of them blocked port 8000 in the next run.
5. **A long page swamps the AI.** For Sam, `source_add` on the Wikipedia "Microplastics" article returned the whole capture (203,574 characters) inside the tool result. That exceeded Claude's limit, so the summary used only NOAA and WHO. The AI said so honestly, but one of Sam's three sources was unusable.

Also observed:
- **The deny list missed a recursive force delete.** The first tool result says "destructive commands are refused", but `rm -rf ~/nonexistent-husk-test` ran with exit 0 on both 0.2.0 and 0.1.4. The path didn't exist, so nothing was deleted.
- **Husk wrote outside its storage setting.** On WSL it ignored `HUSK_HOME` and wrote computers to `~/.husk/workspaces` inside WSL. Computers made through Codex were left behind with `persist: true` and a 3600 s idle timeout.
- **It started WSL by itself.** Ubuntu was stopped at the start of the test; Husk started it on the first shell call.
- **`husk serve` doesn't read `husk.yaml` from the folder it runs in.** It reported `{"husks":[]}` and never fired a cron set to every minute during 150 s. I found no public step that loads a file into it.
- **In Codex headless mode, every Husk call came back "user cancelled MCP tool call",** even with `approval_policy="never"`. It only worked with `mcp_servers.husk.default_tools_approval_mode="approve"`. Without that, Codex quietly finished Priya's task with its own Windows shell.
- **No chart libraries in the computer.** The WSL computer had no matplotlib, numpy or Pillow. The AI wrote its own PNG encoder, and the chart came out missing letters ("Ma na Loa", "Deseasonali ed") with the legend's trend line not drawn.

## 5. What the website made people expect vs what happened

- **"Your AI chat gets a computer."** Maya and Priya read "AI chat" as ChatGPT; the page then lists only Claude Code, Codex and Cursor. For a Codex user it was true, but only after a non-obvious approval setting in headless mode.
- **"One command. Nothing else to edit."** That holds in cmd.exe and on macOS and Linux shells. In Windows PowerShell, the default terminal on Maya's and Dev's kind of laptop, it fails (problem 2).
- **"Keep what it finds in a workspace you can reopen tomorrow."** True with the 0.2.0 desktop file (Sam reopened it in a new chat). Not true with the command the page tells you to copy (0.1.4, problem 3).
- **"Start in Claude Desktop" button.** It links to a guide built on an unsigned GitHub download. I couldn't test whether a beginner gets through Claude Desktop's Settings → Extensions → Advanced settings → Install Extension.
- **"Run it… as a bot on Discord, Slack, a web endpoint or a schedule."** The `husk.yaml` reference says Discord, Slack and Telegram "parse and validate and are never mounted". Taylor's schedule never loaded.
- **"No account, no API key, no Docker."** True and confirmed for Jordan: free, local, it worked.
- **Isolation messaging.** It matched reality, which is uncommon. Doctor, the first tool result and the Security page all said `local` isn't a sandbox, and Alex's probe confirmed it.
  - The shell listed `/mnt/c/Users/hotra` (177 entries).
  - It ran `cmd.exe /c ver`.
  - It reached the internet.
  - It reached the host's Ollama through Windows `curl.exe` (repo build run).
  - `read_file` on `/mnt/c/Windows/win.ini` was refused, but the shell isn't bound by that.
  - No variable names containing KEY, TOKEN or SECRET reached the shell.

## 6. Recommendation

**Who it's for:** people running free local models (Jordan) who want those models to do things, not just chat. Second, Claude Desktop users doing source-based writing (Sam), once workspaces ship on npm and handle long pages.

**The one job to lead with:** *"Give your free local model a computer: it runs commands and fetches pages, no key, no account."* It's the only job here that finished cleanly on the public npm package and that the person's current tools can't do.

**What to cut or stop claiming until it's true:**
- Discord, Slack and Telegram bots on the homepage (not mounted).
- The "schedule" bot story, until `husk serve` can load a `husk.yaml` in one documented step.
- ChatGPT next to "AI chat", unless there's a ChatGPT route.
- The `ssh` and `fly` rows from first-run material; nobody needed them.
- "Destructive commands are refused", unless the deny list catches `rm -rf` on a home path.

**What to fix before anyone else tries it:**
- Make the PowerShell one-liner work (quote `'--'` in the copy button for Windows).
- Publish workspaces to npm, or stop promising them under the npm one-liner.
- Return file paths that actually open from Windows, and keep `expose_port` URLs alive.
- Cap what `source_add` returns to the AI.

For Maya, Priya and Taylor, Husk isn't the answer today, and nothing on the site should suggest otherwise.

## 7. Not tested, and why

- **Claude Desktop extension install** (Settings → Extensions → Install Extension): I can't drive the desktop app's settings screen. I downloaded the `.mcpb` (6,850,735 bytes, 3 s, SHA-256 matches the published `42c2ff55…e0dd`), read its manifest and ran its server (`--profile starter`) with system Node instead. Claude Desktop's bundled Node wasn't used.
- **Workspace viewer UI and its "Export workspace" ZIP:** this session's safety check refused the built-in browser, and I didn't route around it with another browser. I checked the files on disk instead (manifest.json, outputs/*.md, sources/*.txt).
- **ChatGPT web or desktop:** not installed, and Husk offers no ChatGPT host.
- **Interactive Codex approval prompts:** that's a terminal UI I can't drive. Headless `codex exec` cancels the calls unless the per-server approval setting is on.
- **Opening Dev's app in a real browser:** browser refused, as above. I checked with `curl.exe` instead.
- **Alex's untrusted page on Docker:** Docker Desktop's daemon didn't come up within about 5 minutes (`docker-desktop` stayed Stopped, `docker info` hung), probably waiting on a GUI prompt. I quit it again.
- **Alex's untrusted page on `local`:** deliberately not run. Husk itself says to keep untrusted input off `local`, and this is a real machine.
- **Low-spec hardware:** this laptop has 15.6 GB and 10 cores. Jordan's run used a 4.2 GB model (`granite4-sotai`, which 0.1.4's doctor picked as "first reachable"). I didn't check how well a 4 to 8 GB laptop copes.
- **Taylor's notifications:** they need a Discord, Slack or Telegram bot token (not allowed here), and the docs say those triggers aren't mounted. The daily schedule itself never loaded into `husk serve`.
- **`husk onboard`** (interactive) and **chat-to-bot** (`import`, `distill`): no person needed them.
- **How long a human would take to read each page:** I didn't estimate it. All timings are machine timings.

## Clean-up

**Removed:**
- Everything in `persona-test/`: downloads, the extracted bundle, the public npm install, every `HUSK_HOME`, logs and scripts.
- WSL computers `cmp_6fwd0x7h4p24`, `cmp_4f970b7e8k9m` and `cmp_s7pe3mq666tc` under `~/.husk/workspaces`.
- Two orphaned `python3 app.py` servers in WSL.
- The headless Claude session folders for the test.
- Five Codex session logs from the test.
- The temporary `husk-persona-test` Claude Code MCP entry (added and removed).
- Docker Desktop was quit, and WSL Ubuntu was shut down again.

**Deliberately left:**
- The pre-existing WSL computer `cmp_1t54x8b1rzh3` (from 2026-09-18, not made by this test).
- Codex's pre-existing `husk` entry.
- Claude Code's pre-existing local `husk` entry.

**npm cache:** emptied afterwards with `npm cache clean --force`, so no `@husk-ai/*` 0.1.4 packages are left in it. The three `@husk-ai` folders in `npm-cache/_npx` were created 15, 16 and 22 September, before this test, so they were kept.
