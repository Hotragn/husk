# QA report — Sprout on the free path (local provider + ollama/qwen2.5:7b)

**Date:** 10 September 2026
**Subject:** `examples/sprout.yaml` — news-gathering bot, own computer, `curl` as its only browser
**Host:** Windows 11 arm64, husk 0.1.0, node 24.14.0, local provider via WSL2 (Ubuntu)
**Constraint honoured:** every web fetch in this report was made by `curl` **inside a husk computer**. No host browser was used at any point.

---

## Verdict first

The **runtime is the strong part**; the **7B model is the weak part**; and there is **one critical runtime bug** that causes silent data loss.

Husk's free path can produce correct, non-fabricated work — I got a fully verified run — but only when the task is phrased as "one tool per step", and it takes ~18–35 minutes per run. It is **not ready for unattended use**, for three reasons: fabrication is still reachable, the model silently no-ops when many tools are attached, and concurrent runs destroy each other's filesystem.

---

## 1. The critical bug: concurrent runs of the same husk destroy each other's computer

**Severity: high — silent data loss, and the error message points the wrong way.**

Two `husk run` invocations of the same husk share one bound computer (`bindings.json` key `husk:sprout`). When the **first** run exits, its cleanup destroys the computer *and its workspace directory*, while the second run is still using it.

Observed timeline:

```
05:01  run A creates cmp_ykdg5nh5nqvm
05:06  run B starts, binds to the SAME cmp_ykdg5nh5nqvm
       steps 1-3 succeed:
         OK  5.3s  /work/candidates.txt lines 1-6 of 121
         OK  15ms  /work/candidates.txt lines 7-11 of 121
         OK  4ms   /work/candidates.txt lines 12-15 of 121
~05:21 run A exits ("6 steps · 20m11s") -> destroys cmp_ykdg5nh5nqvm + workspace
       every subsequent call in run B fails:
         FAIL 159ms Error: path resolves outside the workspace through a symlink
         FAIL 4ms   Error: path resolves outside the workspace through a symlink
         ... (steps 4-8, all reads)
         FAIL 10ms  Error: path resolves outside the workspace through a symlink   (write_file)
```

After this, `husk ps` reported `no computers yet` while run B was still executing.

Two distinct defects here:

1. **A run tears down a computer another run is actively using.** An exiting run should not destroy a shared bound computer that has live users.
2. **The error is actively misleading.** The workspace root no longer exists, so the jail's `realpath` check fails and reports `path resolves outside the workspace through a symlink` for the perfectly legal path `/work/candidates.txt`. A developer chasing this would go looking for a symlink that was never there. The message should distinguish "workspace is gone" from "path escaped the jail".

This is not a contrived scenario: it happened twice, and the second time it was caused by a *different session* in the same repo running its own `husk run` — the exact "bot handling two triggers" case the product is for.

**Collateral damage:** the whole of `/work` went with it — `candidates.txt`, three fetched feeds (90 KB + 15 KB + 162 KB of real XML), and `digest.py`. Also destroyed: one successful output file, before it could be read back off disk.

---

## 2. The fabrication finding — did the digest fix resolve it?

**Partly. It reduced fabrication from total to partial, and a fully clean run is now achievable — but fabrication is still reachable.**

### Original failure (pre-fix, `.runs/sprout.log`)

The model fetched three feeds correctly and then invented the entire output: `Good news item 1`, `http://example-good-news-item-1.com`, `Fetched: 2023-10-01`.

Worth adding to the existing write-up: the log shows `write_file` was issued **in the same step as the three curls**, so the model never had the chance to read the feeds — it wrote the file before any data existed. The problem was not only "90 KB of XML is too much"; it was that the model did not sequence fetch-then-read at all.

### Post-fix, fabrication still occurred (run 5)

Once the computer was destroyed underneath it (bug #1), the model responded to repeated tool failures by inventing content rather than reporting the failure — despite its persona explicitly forbidding this:

```
1. Good News in History, September 10             <- real, in candidates.txt
2. A 'Living Roof' is Growing Atop Ford's ...     <- real, in candidates.txt
3. Arthritis Drug Demonstrates ... Alopecia       <- real, in candidates.txt
4. Conservationists Successfully Restore Rare Species in Remote Rainforest
   Source: .../conservationists-successfully-restore-rare-species-in-remote-rainforest/
5. Local Community Helps Homeless Man Find Permanent Housing
   Source: .../local-community-helps-homeless-man-find-permanent-housing/
```

Items 4 and 5 are **fabrications**. Neither title nor URL appears in `candidates.txt`. Items 1–3 were real precisely because those were the only lines the model had actually read (lines 1–15) before the failures started.

The persona's self-check step ("if any URL is not in candidates.txt, you invented it — delete the file and start again") did not fire. The model narrated the failure honestly in prose — *"It appears there is a persistent issue with reading the file"* — and then fabricated anyway.

### The clean run

See section 3. With a "one tool per step" prompt and no concurrent run, the model produced 5/5 verified-real stories.

**Conclusion on the fix:** the digest approach is sound and necessary — it turns 268 KB of XML into a 5.9 KB, 121-line list, and all 24 candidates it produces are real and live. But it does not by itself prevent fabrication. Fabrication is the model's failure mode *whenever the tools stop cooperating*, and no amount of persona text has suppressed it.

---

## 3. Verified output — the one clean run

Prompt style: numbered steps, "Use one tool per step." Run: 4 steps, 18m28s, 15,008 tokens, free.

The file, read back **off disk** with `husk exec ... -- cat`, not from the model's chat claim:

```
GOOD NEWS - 10 September 2026
Collected by Sprout from inside its own husk computer.

1. Arthritis Drug Demonstrates Substantial Hair Regrowth in 1,400 Alopecia Patients   Source: https://www.goodnewsnetwork.org/arthritis-drug-demonstrates-substantial-hair-regrowth-in-1400-alopecia-patients/
2. Scientists Recreated Chirps of Jurassic Insects, Simulating a 165 Million-yo Soundscape (Listen)   Source: https://www.goodnewsnetwork.org/scientists-recreated-chirps-of-jurassic-insects-simulating-a-165-million-yo-soundscape-listen/
3. Yard Work Reveals Largest Trove of Viking Silver Ever Discovered in Denmark   Source: https://www.goodnewsnetwork.org/yard-work-reveals-largest-trove-of-viking-silver-ever-discovered-in-denmark/
4. FDA Immediately Approves Drug That's Doubling Lifespan for Late Pancreatic Cancer Patients   Source: https://www.goodnewsnetwork.org/fda-immediately-approves-drug-thats-doubling-lifespan-for-late-pancreatic-cancer-patients/
5. Armless Racing Driver Hits 110 mph Steering with His Feet-Aims to Make History at Le Mans   Source: https://www.goodnewsnetwork.org/armless-racing-driver-hits-110-mph-steering-with-his-feet-aims-to-make-history-at-le-mans/
```

### Provenance check — every URL present in `candidates.txt`

```
in_candidates=1  https://www.goodnewsnetwork.org/arthritis-drug-demonstrates-substantial-hair-regrowth-in-1400-alopecia-patients/
in_candidates=1  https://www.goodnewsnetwork.org/scientists-recreated-chirps-of-jurassic-insects-simulating-a-165-million-yo-soundscape-listen/
in_candidates=1  https://www.goodnewsnetwork.org/yard-work-reveals-largest-trove-of-viking-silver-ever-discovered-in-denmark/
in_candidates=1  https://www.goodnewsnetwork.org/fda-immediately-approves-drug-thats-doubling-lifespan-for-late-pancreatic-cancer-patients/
in_candidates=1  https://www.goodnewsnetwork.org/armless-racing-driver-hits-110-mph-steering-with-his-feet-aims-to-make-history-at-le-mans/
```

### Liveness check — `curl -I` **from inside the computer**

```
HTTP 200  https://www.goodnewsnetwork.org/arthritis-drug-demonstrates-substantial-hair-regrowth-in-1400-alopecia-patients/
HTTP 200  https://www.goodnewsnetwork.org/scientists-recreated-chirps-of-jurassic-insects-simulating-a-165-million-yo-soundscape-listen/
HTTP 200  https://www.goodnewsnetwork.org/yard-work-reveals-largest-trove-of-viking-silver-ever-discovered-in-denmark/
HTTP 200  https://www.goodnewsnetwork.org/fda-immediately-approves-drug-thats-doubling-lifespan-for-late-pancreatic-cancer-patients/
HTTP 200  https://www.goodnewsnetwork.org/armless-racing-driver-hits-110-mph-steering-with-his-feet-aims-to-make-history-at-le-mans/
```

### Title exact-match check

```
exact_title_match=1 | Arthritis Drug Demonstrates Substantial Hair Regrowth in 1,400 Alopecia Patients
exact_title_match=1 | Scientists Recreated Chirps of Jurassic Insects, Simulating a 165 Million-yo Soundscape (Listen)
exact_title_match=1 | Yard Work Reveals Largest Trove of Viking Silver Ever Discovered in Denmark
exact_title_match=1 | FDA Immediately Approves Drug That's Doubling Lifespan for Late Pancreatic Cancer Patients
```

**Result: 5/5 URLs real and live, 4/4 extractable titles character-exact. No fabrication in this run.**

I also independently HEAD-checked the whole candidate pool from inside the computer: **24/24 returned HTTP 200**. The pool `digest.py` produces is entirely real, so any fabrication is unambiguously the model's.

### But the output is still not what was asked for

- **The summaries are missing.** The task asked for "one to two lines of summary plus the source link" for each item. The file has title + `Source:` only. The format instruction was silently dropped.
- **The dates are wrong for the brief.** The task asked for good news from **10 September 2026**. The chosen stories are dated 9 Sep (x3) and 8 Sep (x2), even though `candidates.txt` contained two 10 Sep items and the prompt said "preferring the newest DATE values".
- **Summary quality, where summaries did appear** (an earlier successful run) was near-worthless filler: *"A day filled with historical good news."*, *"A fascinating scientific achievement."*

So: **task 3 is a partial pass.** Real, verifiable, correctly-sourced links — which is the hard part and the part that was previously fabricated — but the summary requirement was not met and the date filter was ignored.

---

## 4. The other model failure: silent no-op when many tools are attached

**Reproducible, twice, byte-identical.** With the full 6-step task prompt and all 10 tools attached, `qwen2.5:7b` returns nothing at all:

```
── step 1
warning ollama/qwen2.5:7b finished without saying anything and without calling a tool
hint:  small local models often do this with tools attached — try a larger model, or --approve readonly to see its plan

1 step · 16.2s · 2516 tokens · free
```

Same result on retry (`1 step · 10.2s · 2516 tokens`). It is not flakiness.

The deciding variable appears to be **toolset size, not prompt length**:

| Prompt | Tools attached | Result |
|---|---|---|
| `Run the shell command: echo hello-from-sprout` | 10 | works |
| Full 6-step task (`sprout-task2.txt`) | 10 | **empty response, 2/2 runs** |
| Same task, phrased with tool names | 3 (`shell, read_file, write_file`) | works — model engaged |
| Numbered "one tool per step" | 3 | works — clean output |

Husk prunes the toolset when the prompt names tools, and that pruning is what unblocks the model. That is a useful lever the product should pull deliberately rather than by accident.

**Related gap:** `fallbackModels` (`llama3.2`, `qwen2.5:1.5b`) **never engaged**. An empty response with no tool call is treated as a successful terminal step, so the run ends at step 1 rather than falling back. An empty first response looks like exactly the condition fallbacks exist for.

**Also observed:** the model self-limits its own reads. Given a 121-line file it called `read_file` with `endLine=6`, then `7-11`, then `12-15` — 4-6 lines per step at up to 9 minutes per step. This is *not* a runtime defect: `read_file` defaults `endLine` to the whole file (capped at 128 KB), and in the clean run the same call returned `(121 lines)` in one shot. The model chose the tiny windows.

---

## 5. Runtime hardening results

| Check | Result | Evidence |
|---|---|---|
| `/work` persists across separate `exec` calls | **PASS** | wrote `persist-token-9f3a`, read back in a separate invocation |
| `/tmp` persists across separate `exec` calls | **PASS** | same method |
| `/work` survives `wsl.exe --shutdown` | **PASS** | file intact after restart (workspace lives on the Windows disk) |
| Path jail — file tools | **PASS** | see below |
| Path jail — shell | **does not apply by design** | see below |
| Deny list — `sudo rm -rf /` | **PASS** | `error refused: privilege escalation`, exit 1 |
| Credentials scrubbed | **PASS** | see below |
| `husk ps` agrees with reality | **PASS** (with caveats) | see §6 |

### Path jail

Holds for the **file tools**. `toHostPath` in `packages/runtime/src/policy.ts` refuses anything outside `/work` and `/tmp`, and normalises traversal before the check:

```
$ husk cp cmp_...:/etc/passwd ./qa-jailtest.txt
error path is outside the machine's writable area: /etc/passwd
hint:  this computer exposes /work and /tmp; use a path under one of them

$ husk cp 'cmp_...:/work/../../../etc/hostname' ./qa-jail2.txt
error path is outside the machine's writable area: /etc/hostname
```

No file was created in either case.

**It does not apply to shell commands, and `cat /etc/passwd` succeeds:**

```
$ husk exec cmp_... -- 'cat /etc/passwd'
root:x:0:0:root:/root:/bin/bash
daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin
...
(exit 0)
```

This is consistent with what `husk doctor` says — *"guarded working directory — process guardrails, not a sandbox"*, `local  not isolated` — so it is honestly advertised rather than hidden. But it is worth stating plainly: **on the local provider, a shell command has the full filesystem access of your user account.** `cat ../../etc/shadow` returned `Permission denied`, which is ordinary Linux file permissions doing the work, not husk. Anyone reading "path jail" and expecting shell confinement will be wrong.

### Deny list scope

`husk exec` enforces the **runtime built-ins** in `packages/runtime/src/deny.ts` (`sudo`, `rm -rf /`, `mkfs`, `dd of=/dev/sd*`, fork bomb, `shutdown`, piping a remote script into a shell, writes to `/etc/passwd|shadow|sudoers|hosts`). It does **not** enforce the per-husk `guardrails.denyCommands` from `sprout.yaml`, which live in the agent layer (`packages/agent/src/guard.ts`) and are bypassed when you skip the agent:

```
$ husk exec cmp_... -- 'git push origin main'
fatal: not a git repository ...          (ran; exit 128 — not refused)

$ husk exec cmp_... -- 'curl -X POST https://example.com'
<!doctype html><html lang="en"><head><title>Example Domain</title>...   (ran, fetched)
```

Defensible as an operator escape hatch, but it should be documented — the `curl -X POST` and `git push` rules in `sprout.yaml` read as absolute prohibitions and are not.

Relatedly, `computer.network.allow` is not enforced: `example.com` is not in the allowlist and was reachable. `sprout.yaml` already admits this in a comment, so this is a known limitation rather than a surprise.

### Credential scrubbing — clean

```
$ husk exec cmp_... -- 'echo "KEY=[$ANTHROPIC_API_KEY]"; echo "OPENAI=[$OPENAI_API_KEY]"'
KEY=[]
OPENAI=[]

$ husk exec cmp_... -- 'env | grep -iE "key|token|secret|passw|api"; env | wc -l'
(no matches)
23
```

A 23-variable environment with nothing sensitive in it. This one is solid.

---

## 6. State-management defects (lower severity)

**Stale binding.** `~/.husk/computers/bindings.json` retained `"handshake-test": "cmp_8v9zc535mtv6"` for a computer that no longer exists, and still did after other bindings were cleaned up. `ps` and `exec` both handle it correctly (`error no computer named ...`), so today it is cosmetic — but a future husk named `handshake-test` binding to a dead id is the obvious failure mode.

**Orphaned workspace directories.** Three workspace directories outlived their computers:

```
$ ls ~/.husk/workspaces/
cmp_ambm63xaedev/  cmp_msf4dpc0tem3/  cmp_x688c1gx60kg/
$ husk ps
no computers yet
```

Cleanup is inconsistent: the destroy path in §1 removed its workspace completely, while these three were left behind (one still holding a `.husk-computer.json`). Nothing reaps them, so they accumulate.

**`husk ps` itself was accurate** every time I checked it against `~/.husk/computers/*.json` — including reporting `no computers yet` at the moment a run had just destroyed one out from under another run. It reports the registry faithfully; the registry was what was wrong.

**Possible limit-enforcement gap.** `limits.timeoutSec` is 1800 (30 min), but one run reported `5 steps · 35m00s`. Flagging as observed rather than confirmed — I did not isolate whether that clock includes time the limit does not cover.

---

## 7. WSL2 hazard — how it actually behaved

**Occurrences: 2.** One spontaneous, one induced deliberately.

The important finding is that **`husk doctor` reports the downgrade when the runtime has not actually downgraded.** Both times, `doctor` said WSL was dead while `exec` through the same provider was returning Linux.

Spontaneous occurrence, 04:46 — no `wsl --shutdown` anywhere near it:

```
doctor #1:
  local    not isolated
      via Windows host shell -- WSL is installed but not responding; commands are NOT Linux

exec, seconds later:
$ husk exec cmp_... -- 'uname -a'
Linux LAPTOP-36O158DO 6.18.33.2-microsoft-standard-WSL2 ... aarch64 GNU/Linux

doctor #2, ~40s later, no intervention:
  local    not isolated
      via WSL2 (Ubuntu)
```

Deliberate test:

```
06:09:34  wsl.exe --shutdown
06:09:3x  doctor -> "via Windows host shell -- WSL is installed but not responding; commands are NOT Linux"
06:10:07  husk exec ... -- 'uname -a'
          Linux LAPTOP-36O158DO 6.18.33.2-microsoft-standard-WSL2 ... aarch64 GNU/Linux
          (and /work/good-news-sep-10.txt read back intact)
06:10:44  doctor -> "via WSL2 (Ubuntu)"
```

Findings:

- **Recovery works, and within the advertised window** — healthy again ~70s after a hard `wsl --shutdown`, with no manual intervention. The re-probe does what it claims.
- **`/work` survived the shutdown**, because the workspace is backed by the Windows filesystem.
- **I never once saw an actual downgrade to the Windows shell.** I never got `'x' is not recognized` or `The system cannot find the file specified`. `wsl.exe` starts the distro on demand, so the real exec path recovers faster than doctor's probe notices.
- Therefore the message **`commands are NOT Linux` was false both times it appeared.** That is the wrong direction for a diagnostic to be wrong in: it tells users to distrust a working system, and crying wolf would mask a genuine downgrade. Doctor's probe needs the same on-demand-start tolerance the exec path has, or it should retry before declaring the downgrade.

---

## 8. What worked well

Worth saying, because the failures above are loud:

- **`digest.py` is the right idea.** 268 KB of XML across three feeds reduced to a 5.9 KB, 121-line numbered list, in ~11s, every time. 24/24 candidate URLs live. This is the piece that makes the task tractable at all.
- **`curl` from inside the computer worked flawlessly** — every fetch in this report, including 29 HEAD requests, ran inside a husk. No host browser was needed at any point, which is the product's central claim.
- **The loop-breaker guardrail fired correctly** on a genuinely stuck model:
  ```
  warning stopping: write_file repeated 5 times without progress
  error stopped: write_file was called with byte-identical arguments 5 times in a row
  hint:  run with --debug for the trace, or --approve readonly to see what it wanted to do
  ```
- **`husk doctor` is honest about isolation.** It leads with `local  not isolated`, warns that "a prompt-injected model is closer to an adversary than to an accident", and tells you Docker would be better. Most products would not.
- **Error messages generally carry a usable fix.** The `cp` jail refusal, the deny-list refusal, and the empty-model-response warning all name the next action.

---

## 9. Verdict: is the free path good enough for unattended work?

**No — not yet, and the model is the smaller problem.**

**Blocking for unattended use:**

1. **Concurrent runs destroy each other's filesystem** (§1). An unattended bot is exactly a thing that gets triggered twice. Until an exiting run stops reaping a computer that has live users, unattended operation can lose data mid-task with a misleading error. This is the one I would fix first, and the misleading `symlink` message with it.
2. **Fabrication is still reachable** (§2). The model's response to tool failure is to invent plausible content, and the persona's own verification step does not fire. Because the tools *do* fail (see #1), these two defects compound: the runtime breaks, and the model papers over the break with fiction. Nothing in the pipeline catches it — the `grep -F` self-check exists only as a persona instruction the model can skip.
3. **Silent no-op with the full toolset** (§4). Two of six runs produced literally nothing, reproducibly, and `fallbackModels` did not engage.

**Not blocking, but disqualifying for "useful":** 18–35 minutes per run, and even the clean run dropped the summary requirement and ignored the date filter. As a daily digest bot this would produce a bare link list, twice as slow as reading the feeds yourself.

**What the free path *is* good for today:** attended, single-run, narrowly-scoped tasks where a human reads the output. Under those conditions I got a real, fully verified, correctly-sourced result at zero cost — which is a genuine achievement for a 7B model on a laptop.

**Cheapest changes with the most effect, in order:**

1. Don't let an exiting run destroy a computer another run holds; distinguish "workspace missing" from "jail escape" in the error.
2. Make the URL-provenance check a **runtime post-condition**, not a persona instruction — if a written file contains a URL absent from its cited source file, fail the run. That converts the fabrication class from silent to loud, and it is a small amount of code.
3. Treat an empty first response as a failure that triggers `fallbackModels`.
4. Prune the toolset deliberately for small models rather than incidentally via prompt wording. The evidence that 3 tools work where 10 do not is the strongest single lever in this report.
5. Fix doctor's WSL probe so it stops reporting a downgrade that has not happened.

---

## Appendix — run inventory

| Run | Prompt style | Tools | Outcome |
|---|---|---|---|
| 1 | 6-step, freeform | 10 | Feeds fetched; **output 100% fabricated** (`example-good-news-item-N.com`, 2023 date) |
| 2 | 6-step (`sprout-task2.txt`) | 10 | Stalled at step 1, died, produced nothing |
| 3 | 6-step (`sprout-task2.txt`) | 10 | **Empty response**, 1 step, 2516 tokens |
| 4 | 6-step (`sprout-task2.txt`), retry | 10 | **Empty response**, identical, 2516 tokens |
| — | `echo hello-from-sprout` | 10 | Works — model can call tools |
| 5 | Concise, tool names in prompt | 3 | Killed by bug §1 mid-run; **items 4–5 fabricated** |
| 6 | Numbered, "one tool per step" | 3 | **Clean: 5/5 URLs verified real and live**; summaries missing, dates 8–9 Sep |

Logs: `.runs/sprout*.log`. Note that `.runs/` was being written concurrently by the development session during this test, so some logs there were overwritten; the copies this report was written from are preserved in the session scratchpad.

---

## Correction and follow-up (added after the report was filed)

**The root cause in section 1 was misattributed, but the bug it found was real.**

Nothing in `husk run` destroys a computer — the run path contains no `destroy()`
call, and the reaper only runs under `husk serve`. The computer vanished because
a *different* session (the one building the product) ran `husk rm --all --yes`
as cleanup while this run was in flight. So it was not "run A's exit tears down
a shared computer"; it was "any process can delete a computer another process is
using, and the resulting error is a lie".

Both halves are now fixed, with tests:

**The misleading error.** When the workspace root is gone, `realpath` on it
fails, the ancestor walk climbs *past* the deleted directory to a surviving one,
and that reads as an escape — hence `path resolves outside the workspace through
a symlink` for a perfectly legal `/work/candidates.txt`. `assertInJail` now
checks the root's existence first and reports what actually happened:

```
E_COMPUTER_NOT_FOUND: this computer’s workspace no longer exists
hint: it was destroyed while in use -- `husk ps` to see what is left, `husk up` for a fresh one
```

A genuine symlink escape still reports as a symlink escape; both cases are
covered in `packages/runtime/src/policy.test.ts`.

**The destructive command.** `husk rm --all` now refuses when any computer ran
something in the last 60 seconds:

```
$ husk rm --all --yes
error 1 of these computers were in use in the last minute
hint:  let the run finish, remove them by name, or pass --force if you are sure
```

**What is still true and still worth acting on:** two concurrent runs of the same
husk *do* share one computer, by design, via the `husk:<name>` binding — that is
what lets a conversation keep its files across tool calls. There is no
refcounting, so the sharing is cooperative rather than enforced. For two agents
that should not share a filesystem, give them different husk names or pass an
explicit `--computer`. Worth revisiting if per-run isolation ever becomes the
expected default.

The fabrication findings in sections 2 and 3 stand unchanged, and are the more
important result.

---

## 10. Retest of sprout v0.2.0 (11 September 2026)

`examples/sprout.yaml` was redesigned in response to this report: three tools
instead of ten, a persona cut from 1.6 KB to a few lines, `digest.py` laid down
by `computer.setup` so fetching is deterministic, `temperature` 0.1, `maxSteps`
20. Retested with the task from the original brief — five stories, **each with
one to two lines of summary** plus the source link.

**Run:** 7 steps, 11m13s, 21,200 tokens, free.

### What the redesign fixed

| | v0.1.0 | v0.2.0 |
|---|---|---|
| Wall clock | 18–35 min | **11m13s** |
| `read_file` on the candidate list | 4–6 lines per call, 20+ calls | **91 lines in one call** |
| Empty-turn failures | 2 of 6 runs | none |
| Fabricated URLs | present in 2 runs | **none** |

The one-judgement-call design works. This is a real improvement and the
attention-budget diagnosis in section 4 is confirmed by it.

### Provenance — verified, clean

All five URLs present in `candidates.txt` and all five live, checked with
`curl -I` from inside the computer:

```
in_candidates=1  .../first-permit-to-clean-up-old-mine-waste-issued-for-wa-state-under-2024-good-samaritan-act/
in_candidates=1  .../humanitys-3rd-visit-to-mercury-kicks-off-with-the-successful-arrival-of-bepicolombo-mission/
in_candidates=1  .../beavers-big-moment/
in_candidates=1  .../the-spark-laundromat-libraries/
in_candidates=1  .../former-poachers-protecting-forest-nigeria/

HTTP 200  (all five)
```

### What is still broken: the model will not write the summaries

The file on disk:

```
GOOD NEWS - 10 September 2026

1. First Permit to Clean Up Old Mine Waste Issued for WA State Under 2024 ‘Good Samaritan Act’
   Source: https://www.goodnewsnetwork.org/first-permit-to-clean-up-old-mine-waste-issued-for-wa-state-under-2024-good-samaritan-act/

2. Humanity’s 3rd Visit to Mercury Kicks Off with the Successful Arrival of BepiColombo Mission
   Source: https://www.goodnewsnetwork.org/humanitys-3rd-visit-to-mercury-kicks-off-with-the-successful-arrival-of-bepicolombo-mission/
...
```

Title and `Source:` only. **No summaries — the third line of each item is simply
absent.** This is now **3 runs out of 3**, across both versions, including one
where the required shape was spelled out literally in the prompt with the
explicit note "each with its own summary lines". It is a reproducible ceiling,
not variance.

Worth being precise about what fails: the model reliably *copies* (titles and
URLs are character-exact and never invented, now that it can see the list) and
reliably *fails to generate* — the one part of the task that requires producing
new prose is the part it silently drops. Earlier runs that did emit summaries
produced filler of no value ("A fascinating scientific achievement.").

**Recency instruction also ignored.** The task said prefer the newest dates. The
chosen stories are dated 11, 10, 7, 4 and 3 September — only one from the
requested day, with 3 September selected over available newer items.

### Conclusion

v0.2.0 closes the fabrication class, which was the serious defect. What remains
is a generation ceiling: on a 7B, husk can be designed to make the model's
*selection* trustworthy, but not to make it *write*. For a digest bot that is
the difference between a verified link list and a usable product. Anything
needing original prose per item needs a larger model — and the runtime is now
good enough that the model is unambiguously the limiting factor.
