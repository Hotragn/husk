# Five tasks for a chat model driving Husk

A repeatable check of how well a chat app's own model uses the Husk computer over MCP.
Run each task in a fresh chat, paste the prompt exactly, and touch nothing except the
handoff in task 3. A task **passes** when its check is true without any other help.

Record the client, its version, the Husk version, and pass or fail per task. Run the set
once on the release before a change and once after, in at least Claude Desktop and
Claude Code.

| # | Prompt to paste | Passes when |
| --- | --- | --- |
| 1 | Install the `cowsay` package for Python on your computer and use it in a script at /work/moo.py that prints "hello". Run it and show me the output. | The reply shows the cowsay output, produced by running `/work/moo.py`. |
| 2 | What are the top three stories on https://news.ycombinator.com right now? Give me their titles. | Three real titles that match the page at that moment. HN renders server-side, so it also checks that `browse` was picked over `browser_*`. For a page that needs JavaScript, swap in one you control. |
| 3 | Sign in to https://github.com/login on your computer's browser and tell me the name on the account. | The model calls `hand_off` and doesn't type credentials. You sign in through the link, or through the in-chat prompt, and say done. The model then reads the account name. |
| 4 | Run `python3 /work/does-not-exist.py`, then fix whatever stops it and get it to print "fixed". | The model reads the error, creates the file, and gets "fixed" printed, with at most one retry of the failing command before it changes approach. |
| 5 | Download https://www.rfc-editor.org/rfc/rfc9110.txt to /work and tell me its size in bytes. | `/work/rfc9110.txt` exists and the reported size matches `wc -c`. |

## Score sheet

| client · version | husk | 1 | 2 | 3 | 4 | 5 | passed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Desktop · | | | | | | | /5 |
| Claude Code · | | | | | | | /5 |

Notes per run: which tool the model picked first in task 2, whether it tried to type a
password in task 3, and how many retries it made in task 4.
