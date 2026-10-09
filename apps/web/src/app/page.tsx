import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/CodeBlock";
import { ContainerScroll } from "@/components/ContainerScroll";
import { HeroObject } from "@/components/HeroObject";
import { InstallSelector } from "@/components/InstallSelector";
import { LinkPreview } from "@/components/LinkPreview";
import { ScrollCue } from "@/components/ScrollCue";
import { ScrollNarrative } from "@/components/ScrollNarrative";
import { Reveal } from "@/components/Reveal";
import { IsolationViewer } from "@/components/IsolationViewer";
import { StaticTerminal } from "@/components/StaticTerminal";
import { TerminalReplay } from "@/components/TerminalReplay";
import { PREVIEWS } from "@/lib/previews";
import {
  BROWSER_TOOLS,
  ONBOARDING,
  BROWSER_TOOL_COUNT,
  DISTILL,
  DOCTOR,
  HUSK_YAML,
  MCP_TOOLS,
  PREVIEW_RELEASE_URL,
  PROVIDERS,
  WORKSPACE_GUIDE_URL,
} from "@/lib/content";

export const metadata: Metadata = {
  title: "Husk — your AI chat gets a computer",
  alternates: { canonical: "/" },
};

export default function Home() {
  return (
    <main id="main">
      {/* -------------------------------------------------------------- hero */}
      <section
        className="container hero hero-anim"
        aria-labelledby="hero-title"
        style={{ position: "relative" }}
      >
        {/* Two columns from --bp-lg. The left is what it has always been --
            headline, lead, the install command, the two buttons, the meta line
            -- at the width those were measured at. The right is the object.
            Below --bp-lg the grid is one column and the object goes above the
            copy, because a 3D scene between a headline and its own install
            command would be an interruption. */}
        <div className="hero-grid">
          <div className="hero-copy hero-copy-wide">
            <h1 id="hero-title" className="h-hero">
              Your AI chat gets a computer.
            </h1>
            <p className="lead" style={{ marginTop: "var(--space-6)" }}>
              Add Husk to Claude Code, Codex or Cursor and your AI gets a machine
              of its own: a terminal, files and a browser. It can run the code it
              writes, check the pages it talks about, and keep what it finds in a
              workspace you can reopen tomorrow.
            </p>

            {/* 42rem, not 40. The mono face is wider than the fallback stack
                the 40rem cap was measured against, so the real face pushed the
                install command past its box the moment the fonts landed — a
                scrollbar on the one string that matters, caused by fixing
                something else.

                The selector replaces the bare command block. Both this and the
                one in #mcp are the same component: the page used to hardcode
                Claude Code in two places while the copy underneath promised
                Cursor and Zed the same thing without saying what to type. */}
            <p className="small hero-preview">
              The <a href={PREVIEW_RELEASE_URL}>0.2.0 desktop preview</a> starts
              with workspace tools. Computer access is opt-in after provider
              review.
            </p>

            <div className="hero-actions" style={{ marginTop: "var(--space-4)" }}>
              <a className="btn btn-primary btn-lg" href={WORKSPACE_GUIDE_URL}>
                Start in Claude Desktop
              </a>
              <a className="btn btn-secondary btn-lg" href="#mcp">
                Set up computer tools
              </a>
            </div>

            <p className="meta" style={{ marginTop: "var(--space-6)" }}>
              No Husk account, and no extra API key for workspace tasks. Open
              source under Apache-2.0. Your AI app’s own usage limits still
              apply.
            </p>
          </div>

          <HeroObject />
        </div>

        <ScrollCue />

        {/* The proof, directly under the claim. "A real computer" is a sentence
            anyone can write; this is twenty seconds of one running on a laptop
            that had neither Docker nor an API key, and it refuses a command at
            the end rather than pretending.

            Full bleed because it has to be: globals.css only gives `.term-wide`
            16px mono at the width the bleed provides, and a terminal in a grid
            column is a terminal with a scrollbar. The isolation viewer used to
            hold this slot and answers "how contained is it?" — question three,
            asked by nobody who has not already decided to try the thing. It now
            sits in Providers, where the reader is asking it. */}
        <div className="bleed" style={{ marginTop: "var(--space-12)" }}>
          <div className="container container-2xl">
            <TerminalReplay />
          </div>
        </div>

        <p
          className="small"
          style={{ marginTop: "var(--space-4)", maxWidth: "var(--measure-prose)" }}
        >
          This ran on a Windows laptop with no Docker and no API key. Husk found
          WSL2 and used it as the computer. At the end it refused a command that
          couldn&rsquo;t be undone, and said what to change if you meant it.
        </p>
      </section>

      {/* ------------------------------------------------------- the bridge */}
      {/* The animated form of the two sections either side of it, so it gets
          no heading and no eyebrow of its own. With JS off it is a plain
          transcript of the same three facts, which is what a crawler sees. */}
      <ScrollNarrative />

      {/* ------------------------------------------------------- three jobs */}
      <section className="container section" aria-labelledby="jobs-title">
        <Reveal>
          <div className="section-head">
            <p className="eyebrow">what it does</p>
            <h2 id="jobs-title" className="h-section">
              Husk does three things.
            </h2>
            <p className="prose" style={{ marginTop: "var(--space-4)" }}>
              It gives your AI a computer, keeps useful results with their
              sources, and turns a conversation into a bot you can run again.
            </p>
          </div>
        </Reveal>

        <div className="stack-16">
          <div className="grid12">
            <div className="col-5">
              <h3 className="h-sub">It gives your AI a computer.</h3>
              <div className="prose" style={{ marginTop: "var(--space-4)" }}>
                <p>
                The computer is a throwaway Linux machine with a shell, files
                and open ports. Husk doesn&rsquo;t start it until your AI
                actually needs it, and the whole conversation uses the same
                one, so a file made in one step is still there in the next.
                </p>
              </div>
            </div>
            <div className="col-7">
              <StaticTerminal
                title="husk doctor · example report"
                lines={DOCTOR}
                label="Illustrative provider report showing what husk doctor checks"
              />
            </div>
          </div>

          <div className="grid12" id="workspaces">
            <div className="col-5">
              <h3 className="h-sub">It keeps the result with its sources.</h3>
              <div className="prose" style={{ marginTop: "var(--space-4)" }}>
                <p>
                  Named local workspaces survive reconnects and restarts. Capture
                  public pages, ask your AI to make something useful, then inspect
                  and export the result.
                </p>
                <p>
                  <a href={WORKSPACE_GUIDE_URL}>Follow the first-workspace guide</a>.
                </p>
              </div>
            </div>
            <div className="col-7">
              <ol className="rule-list" aria-label="Workspace workflow">
                <li>
                  <span className="rl-term">01 / Capture</span>
                  <span className="rl-desc">Save public pages with their URLs and capture dates.</span>
                </li>
                <li>
                  <span className="rl-term">02 / Make</span>
                  <span className="rl-desc">Choose a brief, comparison, or action list for your AI to write.</span>
                </li>
                <li>
                  <span className="rl-term">03 / Return</span>
                  <span className="rl-desc">Review the sources, download the result, and reopen it later.</span>
                </li>
              </ol>
            </div>
          </div>

          <div className="grid12" id="chat-to-bot">
            <div className="col-7">
              <StaticTerminal
                title="chat → husk.yaml → service"
                lines={DISTILL}
                label="Commands that turn a chat transcript into a running bot"
              />
            </div>
            <div className="col-5 order-first-sm">
              <h3 className="h-sub">
                It turns a chat you already had into a bot.
              </h3>
              <div className="prose" style={{ marginTop: "var(--space-4)" }}>
                <p>
                Point Husk at a Claude Code, ChatGPT or Cursor conversation. It
                follows the thread the way it actually went, skipping the
                branches you backed out of, and writes it down as a short{" "}
                <code className="inline">husk.yaml</code> file you can read and
                edit.
                </p>
                <p>
                This works without an API key. Husk picks out the instructions
                you kept repeating, the answers you left alone and the tools
                you actually used. Anything it can&rsquo;t work out, it tells
                you instead of guessing.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- mcp */}
      <section className="container section" aria-labelledby="mcp-title" id="mcp">
        <div className="grid12">
          <div className="col-7">
            <Reveal>
              <p className="eyebrow">setup</p>
              <h2 id="mcp-title" className="h-section">
                One line gives your AI a computer.
              </h2>
            </Reveal>

            <div style={{ marginTop: "var(--space-8)" }}>
              <InstallSelector size="lg" idPrefix="mcp-install" />
            </div>

            <div className="prose" style={{ marginTop: "var(--space-6)" }}>
              <p>
              In Claude Code and Codex, that&rsquo;s the whole setup. Cursor,
              Zed and Antigravity don&rsquo;t have an add command, so for those
              you paste a short block into a settings file. The tabs above show
              what to paste and where. Either way, your AI gets a shell, files,
              ports and a browser, and its files stay put for the rest of the
              conversation.
              </p>
              <p>
              The first thing Husk tells your AI is how well its machine is
              walled off from yours. An AI that wrongly thinks it&rsquo;s walled
              off will take risks it otherwise wouldn&rsquo;t.
              </p>
            </div>
          </div>

          <div className="col-5">
            <h3 className="footer-heading" style={{ marginTop: "var(--space-4)" }}>
              the computer
            </h3>
            <ul className="rule-list">
              {MCP_TOOLS.map((tool) => (
                <li key={tool.name}>
                  <span className="rl-term">{tool.name}</span>
                  <span className="rl-desc">{tool.what}</span>
                </li>
              ))}
            </ul>

            <h3 className="footer-heading" style={{ marginTop: "var(--space-8)" }}>
              the browser
            </h3>
            <ul className="rule-list">
              {BROWSER_TOOLS.map((tool) => (
                <li key={tool.name}>
                  <span className="rl-term">{tool.name}</span>
                  <span className="rl-desc">{tool.what}</span>
                </li>
              ))}
            </ul>
            <p className="small" style={{ marginTop: "var(--space-3)" }}>
              {BROWSER_TOOL_COUNT} in all. It&rsquo;s a full Chromium browser
              running inside the computer. Your AI reads each page as text rather
              than a screenshot, so it doesn&rsquo;t need to see it.
            </p>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------ onboarding */}
      <section className="container section" aria-labelledby="start-title" id="start">
        <Reveal>
          <div className="section-head">
            <p className="eyebrow">after setup</p>
            <h2 id="start-title" className="h-section">
              Three things to ask it first.
            </h2>
            <p className="prose" style={{ marginTop: "var(--space-4)" }}>
              Setup is one line, and then nothing tells you what changed. Ask
              these three, in this order. They show you quickly that there&rsquo;s
              a real machine on the other end.
            </p>
          </div>
        </Reveal>

        {/* No Reveal on these. Two reasons, either sufficient: UI-PRINCIPLES §3
            permits the reveal on section heads and nothing else, and a stagger
            across list items is the specific thing it names; and Reveal renders
            a div, which between <ol> and <li> is invalid nesting that costs the
            list its semantics — a screen reader stops announcing three items.
            The heading above this list already marks the arrival. */}
        <ol className="steps">
          {ONBOARDING.map((step, i) => (
            <li className="step" key={step.ask}>
              <span className="step-n" aria-hidden="true">
                {i + 1}
              </span>
              <div>
                <p className="step-ask">&ldquo;{step.ask}&rdquo;</p>
                <p className="step-what">{step.what}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* ------------------------------------------------------- providers */}
      <section
        className="container section"
        aria-labelledby="providers-title"
        id="providers"
      >
        <Reveal>
          <div className="section-head">
            <p className="eyebrow">isolation</p>
            <h2 id="providers-title" className="h-section">
              Run <code className="inline">husk doctor</code> to see which one you
              have.
            </h2>
            <p className="prose" style={{ marginTop: "var(--space-4)" }}>
              Husk can run your AI&rsquo;s computer five ways, and two of them
              don&rsquo;t really keep it apart from your own machine. Husk always
              says which kind you&rsquo;re on, so you never have to guess.
            </p>
          </div>
        </Reveal>

        <div className="table-scroll" tabIndex={0} role="region" aria-labelledby="providers-title">
          <table className="data">
            <caption>
              How each option keeps the computer apart from your machine, what it
              costs, and when to use it.
            </caption>
            <thead>
              <tr>
                <th scope="col">provider</th>
                <th scope="col">isolation</th>
                <th scope="col">how</th>
                <th scope="col">cost</th>
                <th scope="col">best for</th>
              </tr>
            </thead>
            <tbody>
              {PROVIDERS.map((p) => (
                <tr key={p.id}>
                  <th scope="row">{p.id}</th>
                  <td>
                    <span className={`iso iso-${p.isolationKind}`}>
                      <span className="iso-glyph" aria-hidden="true">
                        {p.isolationKind === "kernel"
                          ? "[#]"
                          : p.isolationKind === "none"
                            ? "[!]"
                            : "[?]"}
                      </span>
                      <span className="iso-word">{p.isolation}</span>
                    </span>
                  </td>
                  <td>{p.mechanism}</td>
                  <td>{p.cost}</td>
                  <td>{p.when}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="small" style={{ marginTop: "var(--space-4)", maxWidth: "var(--measure-prose)" }}>
          Husk never quietly swaps in a weaker option. If you ask for Docker and
          Docker isn&rsquo;t running, you get an error, not a downgrade.
        </p>

        {/* The viewer answers "how contained is the one I got?", which is a
            question you only have once the table above has given you the word
            for it. It spent the first release in the hero, three sections
            before anyone was asking. */}
        <div className="grid12" style={{ marginTop: "var(--space-12)" }}>
          <div className="col-5">
            <IsolationViewer />
          </div>
          <div className="col-7">
            <div
              className="callout"
              style={{ maxWidth: "var(--measure-prose)" }}
            >
              <p>
                <span className="callout-code">guardrails, not a sandbox</span>
                On the local option, your AI is kept inside one folder. It
                can&rsquo;t follow a path out of it, API keys are stripped from its
                environment, its output is capped, and anything it starts is stopped
                when time runs out. That stops accidents. It won&rsquo;t stop someone
                trying to break out, and an AI tricked by something it read is closer
                to that than to an accident.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------- husk.yaml */}
      <section
        className="container section"
        aria-labelledby="yaml-title"
        id="husk-yaml"
      >
        <div className="grid12">
          <div className="col-4">
            <Reveal>
              <p className="eyebrow">the output</p>
              <h2 id="yaml-title" className="h-section">
                What comes out is a file you can read.
              </h2>
            </Reveal>
            <div className="prose" style={{ marginTop: "var(--space-4)" }}>
              <p>
              It&rsquo;s laid out for a person to read, with a note at the top
              saying which conversation it came from. That matters, because the
              first thing you&rsquo;ll want to do is disagree with a line and
              change it.
              </p>
              <p>
              <Link href="/#chat-to-bot">Make one</Link>, edit it, then run it
              from the terminal or as a bot on Discord, Slack, a web endpoint or
              a schedule. Switching it from Claude Opus to a free model on your
              own machine means changing one word.
              </p>
            </div>
          </div>
          <div className="col-8">
            {/* The frame is unchanged -- same title bar, same copy button, same
                highlighted source. The wrapper only tilts it. */}
            <ContainerScroll>
              <CodeBlock title="triage.yaml" source={HUSK_YAML} what="husk.yaml" />
            </ContainerScroll>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- free */}
      <section className="container section" aria-labelledby="free-title" id="free">
        <div className="grid12">
          <div className="col-7">
            <Reveal>
              <p className="eyebrow">cost</p>
              <h2 id="free-title" className="h-section">
                The free version is the full version.
              </h2>
            </Reveal>
            <div className="prose" style={{ marginTop: "var(--space-6)" }}>
              <p>
              Husk was built to run on your own machine first. Docker, Podman,
              SSH and Fly plug into that same base, so nothing in Husk needs an
              account, a card or an internet connection. Nothing is locked,
              nothing expires, and there&rsquo;s no paid version with more in
              it.
              </p>
              <p>
              Husk doesn&rsquo;t collect usage data or crash reports. It only
              talks to the websites, AI providers and services your tasks
              actually use. Anything you share with your AI app is covered by
              that app&rsquo;s own policy. This website and the docs do use
              Cloudflare Web Analytics.
              </p>
              <p>
                <LinkPreview {...PREVIEWS.pricing}>
                  What a paid, hosted version would need to offer before we
                  charged for it
                </LinkPreview>
                .
              </p>
            </div>
          </div>

          <div className="col-5">
            <h3 className="footer-heading" style={{ marginTop: "var(--space-4)" }}>
              what free means here
            </h3>
            <ul className="rule-list">
              <li>
                <span className="rl-term">no account</span>
                <span className="rl-desc">
                  nothing to sign up for, nothing to log in to
                </span>
              </li>
              <li>
                <span className="rl-term">no API key</span>
                <span className="rl-desc">
                  run a free model like Gemma or Llama on your own machine with Ollama
                </span>
              </li>
              <li>
                <span className="rl-term">no Docker</span>
                <span className="rl-desc">
                  Husk works without it, and tells you what you&rsquo;re missing
                </span>
              </li>
              <li>
                <span className="rl-term">no usage tracking</span>
                <span className="rl-desc">
                  in Husk itself; this website uses basic analytics
                </span>
              </li>
              <li>
                <span className="rl-term">Apache-2.0</span>
                <span className="rl-desc">
                  fork it, ship it, run it inside your company
                </span>
              </li>
            </ul>
          </div>
        </div>
      </section>
    </main>
  );
}
