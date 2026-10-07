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
  title: "Husk — a place to keep your AI work",
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
              Your AI work, ready to return to.
            </h1>
            <p className="lead" style={{ marginTop: "var(--space-6)" }}>
              Save your sources. Ask your AI for a brief, comparison, or action
              list. Review and download the result, then reopen the same workspace
              tomorrow. Add computer tools when your task needs them.
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
            <div style={{ marginTop: "var(--space-8)", maxWidth: "42rem" }}>
              <p className="small">Workspaces are available in the unsigned{" "}
                <a href={PREVIEW_RELEASE_URL}>0.2.0 public preview</a>. Start with
                the guide for installation and your first task.</p>
            </div>

            <div className="hero-actions" style={{ marginTop: "var(--space-4)" }}>
              <a className="btn btn-primary btn-lg" href={WORKSPACE_GUIDE_URL}>
                Make your first brief
              </a>
              <LinkPreview {...PREVIEWS.source} className="btn btn-secondary btn-lg">
                Explore the source
              </LinkPreview>
            </div>

            <p className="meta" style={{ marginTop: "var(--space-6)" }}>
              No Husk account or extra API key for workspace tasks. Apache-2.0.
              Your AI app’s usage limits still apply.
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
          That ran on a Windows laptop with no Docker and no API key. The local
          provider found WSL2 and gave it a real kernel and a real{" "}
          <code className="inline">/work</code>. Then it refused a command that
          would not have been recoverable, and said what to change if the refusal
          was wrong.
        </p>
      </section>

      {/* ------------------------------------------------------- the bridge */}
      {/* The animated form of the two sections either side of it, so it gets
          no heading and no eyebrow of its own. With JS off it is a plain
          transcript of the same three facts, which is what a crawler sees. */}
      <ScrollNarrative />

      {/* ---------------------------------------------------------- two jobs */}
      <section className="container section" aria-labelledby="jobs-title">
        <Reveal>
          <div className="section-head">
            <p className="eyebrow">what it does</p>
            <h2 id="jobs-title" className="h-section">
              Husk does two things.
            </h2>
            <p className="prose" style={{ marginTop: "var(--space-4)" }}>
              One binary. The first job hands a machine to an agent that does not
              have one. The second takes a conversation you already finished and
              keeps it running.
            </p>
          </div>
        </Reveal>

        <div className="stack-16">
          <div className="grid12">
            <div className="col-5">
              <h3 className="h-sub">It gives an agent a computer.</h3>
              <div className="prose" style={{ marginTop: "var(--space-4)" }}>
                <p>
                  A computer is a disposable Linux machine: shell, filesystem,
                  ports, snapshots. Nothing is spun up until a tool actually
                  needs one, and a stable key maps a conversation to the same
                  machine, so its files survive across tool calls without you
                  tracking ids.
                </p>
                <p>
                  A cold <code className="inline">docker version</code> takes
                  about 800 ms, so provider probes are cached for 30 seconds. An
                  agent that creates four machines in a row pays that once.
                </p>
              </div>
            </div>
            <div className="col-7">
              <StaticTerminal
                title="husk doctor · first run"
                lines={DOCTOR}
                label="Output of husk with no arguments on a machine that has never run it"
              />
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
                  Husk reads a Claude Code, ChatGPT or Cursor transcript, walks{" "}
                  <code className="inline">parentUuid</code> back from the last
                  leaf to get the conversation as it actually ran rather than
                  every dead end, and writes a{" "}
                  <code className="inline">husk.yaml</code> you can diff.
                </p>
                <p>
                  The distiller runs with no API key. It mines the instructions
                  you kept repeating, the answers you did not correct, and the
                  tools you actually used, then reports what it could not
                  determine instead of inventing it.
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
              <p className="eyebrow">the whole install</p>
              <h2 id="mcp-title" className="h-section">
                One line gives your client a machine.
              </h2>
            </Reveal>

            <div style={{ marginTop: "var(--space-8)" }}>
              <InstallSelector size="lg" idPrefix="mcp-install" />
            </div>

            <div className="prose" style={{ marginTop: "var(--space-6)" }}>
              <p>
                In Claude Code and Codex there is no second step and no config
                file to edit. Cursor, Zed and Antigravity have no add command
                of their own, so those get the block to paste and the path to
                paste it into — the tab above switches between them. Either
                way the client gets workspace and computer tools —
                a shell, the filesystem, ports, and a browser — and that
                filesystem persists for the rest of the conversation.
              </p>
              <p>
                The first tool result tells the model how isolated it is,
                because a model that believes it is contained when it is not
                will take risks it otherwise would not.
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
              {BROWSER_TOOL_COUNT} in all. A real Chromium inside the computer,
              driven by structured page text rather than pixels — which is why an
              agent can use it without seeing.
            </p>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------ onboarding */}
      <section className="container section" aria-labelledby="start-title" id="start">
        <Reveal>
          <div className="section-head">
            <p className="eyebrow">after the one line</p>
            <h2 id="start-title" className="h-section">
              Three things to ask it first.
            </h2>
            <p className="prose" style={{ marginTop: "var(--space-4)" }}>
              The install is one line and then nothing tells you what changed.
              These are the three that show you the computer is real, in the
              order that makes the point fastest.
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
            <p className="eyebrow">containment</p>
            <h2 id="providers-title" className="h-section">
              <code className="inline">husk doctor</code> tells you which one you
              have.
            </h2>
            <p className="prose" style={{ marginTop: "var(--space-4)" }}>
              Two of the five providers are not isolated in any meaningful sense.{" "}
              <code className="inline">Availability.isolated</code> is on the
              provider interface so that no part of this product ever has to be
              vague about which two.
            </p>
          </div>
        </Reveal>

        <div className="table-scroll" tabIndex={0} role="region" aria-labelledby="providers-title">
          <table className="data">
            <caption>
              Isolation, cost and the mechanism behind each claim. Never the
              word &ldquo;secure&rdquo; on its own.
            </caption>
            <thead>
              <tr>
                <th scope="col">provider</th>
                <th scope="col">isolation</th>
                <th scope="col">mechanism</th>
                <th scope="col">cost</th>
                <th scope="col">when it wins</th>
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
          Husk never silently substitutes a weaker provider for the one you
          asked for. Asking for <code className="inline">--provider docker</code>{" "}
          with the daemon down is an error, not a downgrade.
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
                The local provider pins the working directory, resolves every
                path through <code className="inline">realpath</code> and refuses
                escapes, strips credential-shaped environment variables, caps
                output, and kills the process tree on timeout. That stops
                accidents. It will not stop an adversary, and a prompt-injected
                model is closer to an adversary than to an accident.
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
              <p className="eyebrow">the unit of value</p>
              <h2 id="yaml-title" className="h-section">
                What comes out is a file you can read.
              </h2>
            </Reveal>
            <div className="prose" style={{ marginTop: "var(--space-4)" }}>
              <p>
                Deliberate key order, block scalars, and a provenance header
                naming the transcript it came from. The file is optimised for
                review rather than for machines, because the first thing you
                will do with it is disagree with a line and change it.
              </p>
              <p>
                <Link href="/#chat-to-bot">Distil one</Link>, edit it, then run
                it on the CLI or serve it over HTTP, Discord, Slack or cron. The
                same file runs against Opus or against a local Gemma by changing
                one word.
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
                The free path is the same path everything else is built on.
              </h2>
            </Reveal>
            <div className="prose" style={{ marginTop: "var(--space-6)" }}>
              <p>
                The local provider is the primitive. Docker, Podman, SSH and Fly
                are plugins behind the same interface, which means there is no
                code path in Husk that requires an account, a card or a network
                connection. Nothing is gated, nothing expires, and there is no
                edition of this product you are not already using.
              </p>
              <p>
                The installed Husk runtime has no product telemetry or crash
                reporter. It contacts the websites, model providers, registries,
                and services your tasks use. Text shared with your AI follows
                that app’s policies. This website and the docs use Vercel Web Analytics.
              </p>
              <p>
                <LinkPreview {...PREVIEWS.pricing}>
                  What a hosted tier would have to add before it was worth
                  charging for
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
                <span className="rl-term">no key</span>
                <span className="rl-desc">
                  Ollama runs gemma, qwen or llama on your machine for nothing
                </span>
              </li>
              <li>
                <span className="rl-term">no Docker</span>
                <span className="rl-desc">
                  the local provider works without it, and says what you gave up
                </span>
              </li>
              <li>
                <span className="rl-term">no product telemetry</span>
                <span className="rl-desc">
                  in the installed runtime; the hosted sites use web analytics
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
