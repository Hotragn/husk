import type { Metadata } from "next";
import Link from "next/link";

import { CommandBlock } from "@/components/CodeBlock";
import { REPO_URL } from "@/lib/content";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Husk is free and Apache-2.0. There is no paid tier, no trial and no edition you are not already using. Here is why, and what a hosted tier would have to add before it was worth charging for.",
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: "Pricing — Husk",
    description:
      "Husk is free and Apache-2.0. There is no paid tier and no edition you are not already using.",
    url: "/pricing",
  },
};

export default function Pricing() {
  return (
    <main id="main">
      <section className="container section" style={{ borderTop: 0 }}>
        <div className="grid12">
          <div className="col-7">
            <p className="eyebrow">pricing</p>
            <h1 className="h-page">Husk costs nothing.</h1>
            <p className="lead" style={{ marginTop: "var(--space-6)" }}>
              Not a free tier, not a trial, not a community edition. The whole
              product is Apache-2.0 and runs on hardware you already own.
            </p>

            <div style={{ marginTop: "var(--space-8)", maxWidth: "40rem" }}>
              <CommandBlock command="npx -y @husk-ai/cli doctor" />
            </div>
            <p className="meta" style={{ marginTop: "var(--space-3)" }}>
              That is the purchase flow.
            </p>
          </div>
        </div>
      </section>

      <section className="container section" aria-labelledby="why-title">
        <div className="grid12">
          <div className="col-7">
            <h2 id="why-title" className="h-section">
              Why there is no paid tier yet.
            </h2>
            <div className="prose" style={{ marginTop: "var(--space-6)" }}>
              <p>
                Husk is a runtime that turns a machine you already own into
                something an agent can drive. Nobody has to pay for that,
                because nobody is paying for the machine twice. The local
                provider is the primitive and every hosted provider is a plugin
                behind the same interface, so there is no code path that
                requires an account — which means there is nothing to gate.
              </p>
              <p>
                Charging for a runtime with no server in it would mean building
                one artificially: a licence check, a seat count, a thing that
                phones home to ask whether you are allowed. That is a server we
                do not want to run and a network call we have promised is not
                there.
              </p>
              <p>
                It also breaks the way people evaluate a tool like this. The
                claim on the homepage is meant to be checked in ten seconds on
                the reader&rsquo;s own laptop. A signup between the claim and
                the check is not a business model, it is friction charged to the
                one person who was going to verify us.
              </p>
            </div>
          </div>

          <div className="col-5">
            <h3 className="footer-heading" style={{ marginTop: "var(--space-4)" }}>
              what you pay for, if anything
            </h3>
            <ul className="rule-list">
              <li>
                <span className="rl-term">Husk</span>
                <span className="rl-desc">nothing, ever, on any provider</span>
              </li>
              <li>
                <span className="rl-term">local models</span>
                <span className="rl-desc">
                  nothing — Ollama runs gemma, qwen or llama on your machine
                </span>
              </li>
              <li>
                <span className="rl-term">hosted models</span>
                <span className="rl-desc">
                  whatever Anthropic, OpenAI, Google or Groq charge you
                  directly. Husk never sits in that transaction
                </span>
              </li>
              <li>
                <span className="rl-term">fly</span>
                <span className="rl-desc">
                  Fly&rsquo;s metered machine time, billed by Fly, with your
                  own token
                </span>
              </li>
              <li>
                <span className="rl-term">ssh</span>
                <span className="rl-desc">
                  whatever your box costs, which for an Oracle Always Free ARM
                  instance is nothing
                </span>
              </li>
            </ul>
          </div>
        </div>
      </section>

      <section className="container section" aria-labelledby="hosted-title">
        <div className="grid12">
          <div className="col-7">
            <h2 id="hosted-title" className="h-section">
              What a hosted tier would have to add.
            </h2>
            <div className="prose" style={{ marginTop: "var(--space-6)" }}>
              <p>
                If Husk is ever charged for, it will be for work that genuinely
                costs someone money to do, and it will sit beside the free path
                rather than on top of it. Four things would qualify, and none of
                them exists today:
              </p>
            </div>
            <ul className="rule-list" style={{ marginTop: "var(--space-6)" }}>
              <li>
                <span className="rl-term">a control plane</span>
                <span className="rl-desc">
                  more than one person sharing husks, with roles, an audit log
                  and revocable credentials. v1 is single-user by design and
                  says so
                </span>
              </li>
              <li>
                <span className="rl-term">always-on triggers</span>
                <span className="rl-desc">
                  a cron husk that keeps running when your laptop is shut. That
                  is somebody&rsquo;s server, and somebody has to pay for it
                </span>
              </li>
              <li>
                <span className="rl-term">managed compute</span>
                <span className="rl-desc">
                  pooled warm machines with faster cold starts than a local
                  Docker daemon can give you
                </span>
              </li>
              <li>
                <span className="rl-term">support</span>
                <span className="rl-desc">
                  a contract, a response time, and someone whose job it is to
                  answer. That is a real cost and an honest thing to sell
                </span>
              </li>
            </ul>
            <div className="prose" style={{ marginTop: "var(--space-8)" }}>
              <p>
                The commitment that constrains all of it:{" "}
                <strong>the free path always works</strong>. No feature ships
                that makes the no-account, no-key, no-Docker path worse. The
                same <code className="inline">husk.yaml</code> that runs on your
                laptop today runs on someone else&rsquo;s machine later without
                being rewritten, and the day that stops being true is the day
                the promise has been broken.
              </p>
            </div>
          </div>

          <div className="col-5">
            <div
              className="callout"
              style={{ marginTop: "var(--space-16)" }}
            >
              <p>
                <span className="callout-code">not on the roadmap</span>
                A paid feature that removes a limit Husk invented in order to
                sell removing it. Step, cost and token ceilings exist because a
                loop that spends your money unattended is a bug; they are not
                a meter.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="container section" aria-labelledby="licence-title">
        <div className="grid12">
          <div className="col-7">
            <h2 id="licence-title" className="h-section">
              The licence is the whole agreement.
            </h2>
            <div className="prose" style={{ marginTop: "var(--space-6)" }}>
              <p>
                Apache-2.0. Fork it, ship it, run it inside your company, put it
                in a product you sell. There is no contributor licence
                assignment that quietly makes it someone else&rsquo;s, and no
                clause that turns into a licence fee at a headcount.
              </p>
              <p>
                <a href={REPO_URL} rel="noreferrer noopener">
                  Read the source
                </a>{" "}
                — or start with{" "}
                <Link href="/manifesto">why any of this is shaped this way</Link>
                .
              </p>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
