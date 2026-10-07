import type { Metadata } from "next";
import Link from "next/link";

import { CommandBlock } from "@/components/CodeBlock";
import { REPO_URL } from "@/lib/content";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Husk is free and open source. There’s no paid plan and no trial. Here’s why, and what a hosted version would need to offer before we charged for it.",
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: "Pricing — Husk",
    description:
      "Husk is free and open source, with no paid plan and no trial.",
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
              There&rsquo;s no paid plan, no trial and no cut-down free version.
              All of Husk is open source and runs on a computer you already own.
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
              Why there&rsquo;s no paid plan yet.
            </h2>
            <div className="prose" style={{ marginTop: "var(--space-6)" }}>
              <p>
                Husk lets your AI use a computer you already own. There&rsquo;s
                nothing to pay for there, because you&rsquo;ve already paid for the
                computer. Everything in Husk is built on that local setup, and
                nothing in it needs an account, so there&rsquo;s nothing to put
                behind a paywall.
              </p>
              <p>
                Charging for something with no server behind it would mean adding
                one just to charge: a licence check, a seat count, a thing that
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
                  nothing, if you run a model like Gemma or Llama on your own machine with Ollama
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
                  whatever that machine costs, which for a free Oracle Cloud server
                  is nothing
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
              What a paid, hosted version would need.
            </h2>
            <div className="prose" style={{ marginTop: "var(--space-6)" }}>
              <p>
                If Husk ever costs money, it will be for work that costs someone
                money to do, and it will sit next to the free version rather than
                replace it. Four things would qualify, and none of
                them exists today:
              </p>
            </div>
            <ul className="rule-list" style={{ marginTop: "var(--space-6)" }}>
              <li>
                <span className="rl-term">team features</span>
                <span className="rl-desc">
                  several people sharing the same bots, with roles, a record of who
                  did what, and access you can take back. Husk is built for one
                  person today, and says so
                </span>
              </li>
              <li>
                <span className="rl-term">bots that run while you&rsquo;re away</span>
                <span className="rl-desc">
                  a scheduled bot that keeps running when your laptop is closed.
                  That needs a server, and someone has to pay for it
                </span>
              </li>
              <li>
                <span className="rl-term">faster machines</span>
                <span className="rl-desc">
                  machines kept ready, so they start faster than Docker can on
                  your own computer
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
                The rule behind all of this:{" "}
                <strong>the free version always works</strong>. Nothing ships
                that makes Husk worse for someone with no account, no API key and
                no Docker. The
                same <code className="inline">husk.yaml</code> that runs on your
                laptop today will run on someone else&rsquo;s machine later without
                changes. If that ever stops being true, we&rsquo;ve broken the
                promise.
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
