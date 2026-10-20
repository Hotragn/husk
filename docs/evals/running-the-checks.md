# Running the chat-app checks yourself

Two checks, both run by a person in the real apps:

1. **The probe**: what each app calls itself, and whether each chat gets its own process.
2. **The five tasks**: how well the app's model uses Husk.

Do the probe first. It runs nothing, and its answers decide whether the in-chat "I'm
done" prompt is offered in that app.

## 1. The probe

You need Node 20 or later and this repo checked out. Paths below are for Windows; on a
Mac use `~/Library/Application Support/Claude/claude_desktop_config.json` and
`~/.cursor/mcp.json`.

1. Fully quit Claude Desktop and Cursor (from the tray icon, not just the window).
2. Add this entry inside `"mcpServers"` in both config files, creating the object if it
   is missing:
   - Claude Desktop: `%APPDATA%\Claude\claude_desktop_config.json`
   - Cursor: `%USERPROFILE%\.cursor\mcp.json`

   ```json
   "husk-probe": {
     "command": "node",
     "args": [
       "C:\\Users\\<you>\\OneDrive\\Documents\\Claude Code\\husk\\scripts\\mcp-probe.mjs",
       "C:\\Users\\<you>\\mcp-probe.log"
     ]
   }
   ```

3. Open Claude Desktop, start a chat, and send any message. Start a second chat and send
   another. Do the same in Cursor.
4. For Claude Code, run this once from any folder, then start two sessions with `claude`
   in two terminals and send a message in each:

   ```bash
   claude mcp add husk-probe -- node "C:\Users\<you>\OneDrive\Documents\Claude Code\husk\scripts\mcp-probe.mjs" "C:\Users\<you>\mcp-probe.log"
   ```

5. Send `C:\Users\<you>\mcp-probe.log`. Each line is one event:
   - `start`: a new process, with its pid.
   - `initialize`: the app's `client` name and `clientVersion`.
   - `disconnect`: the process ended.

   Two chats with two different pids means one process per chat.
6. Remove the `husk-probe` entries afterwards, and run `claude mcp remove husk-probe`.

## 2. The five tasks

Use [chat-model-tasks.md](chat-model-tasks.md). Run it once on the release before the
change and once on this branch.

1. **Point the apps at the version under test.**
   - The published release: `npx -y @husk-ai/mcp` (what the README installs).
   - This branch: build it with `npm ci && npm run build`, then point the app at
     `node <repo>\packages\mcp\dist\bin.js` instead of `npx`.
   - In Claude Desktop, put it under `"mcpServers"` as `"husk"`. In Claude Code, run
     `claude mcp add husk -- node <repo>\packages\mcp\dist\bin.js`, or install the plugin
     with `/plugin install husk --marketplace Hotragn/husk`.
2. Start Docker Desktop if you want container computers. Without it, Husk uses the local
   provider and says so in its first reply.
3. For each task, open a **new chat**, paste the prompt exactly, and touch nothing
   except the handoff in task 3.
4. Fill in the score sheet: pass or fail per task, the client version and the Husk
   version, plus the notes it asks for.
5. Clean up chat computers from the console's Computers table (`husk serve`, then open
   the printed URL), or with `husk rm <id>`.
