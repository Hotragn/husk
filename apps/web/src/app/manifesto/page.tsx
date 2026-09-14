import type { Metadata } from "next";
import Link from "next/link";

import { CommandBlock } from "@/components/CodeBlock";

export const metadata: Metadata = {
  title: "Why agents need honest sandboxes",
  description:
    "Guardrails stop accidents. Only isolation stops a prompt-injected model. A tool that will not tell you which one you have has made the choice for you.",
  alternates: { canonical: "/manifesto" },
  openGraph: {
    title: "Why agents need honest sandboxes — Husk",
    description:
      "Guardrails stop accidents. Only isolation stops a prompt-injected model.",
    url: "/manifesto",
  },
};

export default function Manifesto() {
  return (
    <main id="main">
      {/* Determinate progress against a real measured quantity: how far
          through the essay you are. UI-PRINCIPLES.md §3 allows exactly this
          and bans everything that only looks like it. */}
      <div className="read-progress" aria-hidden="true">
        <span />
      </div>

      <article className="container container-md section" style={{ borderTop: 0 }}>
        <p className="eyebrow">manifesto</p>
        <h1 className="h-page">Why agents need honest sandboxes.</h1>
        <p className="lead" style={{ marginTop: "var(--space-6)" }}>
          Guardrails stop accidents. Only isolation stops a prompt-injected
          model. A tool that will not tell you which one you have has already
          made that choice on your behalf.
        </p>

        <div className="prose" style={{ marginTop: "var(--space-12)" }}>
          <p>
            You are not defending against a malicious user. You are the user.
            You are defending against your own agent doing something
            irreversible, and it happens for three reasons. It writes{" "}
            <code className="inline">rm -rf $BUILD_DIR</code> and{" "}
            <code className="inline">BUILD_DIR</code> is empty. It believes it
            is in <code className="inline">/work</code> and is actually in your
            home directory. Or it read a file, a web page or an issue comment
            that told it to do something, and it complied.
          </p>
          <p>
            The third one is different in kind, not degree. An injected model
            is not making a mistake. It is following instructions competently,
            toward someone else&rsquo;s goal, using the tools you handed it. A
            deny list is a hint to a system that is trying to comply with you.
            It is nothing at all to a system that is trying to comply with
            someone else.
          </p>

          <h2 className="h-sub">Two modes, and the word that hides them</h2>
          <p>
            Almost every product in this category uses one word for both modes.
            &ldquo;Sandboxed.&rdquo; &ldquo;Isolated.&rdquo;
            &ldquo;Secure.&rdquo; Those words are doing no work unless a
            mechanism is attached to them, and the mechanisms are not
            comparable.
          </p>
          <p>
            A container is a kernel boundary: dropped capabilities, no
            new privileges, a read-only root, a pid ceiling, a locked root
            account, the network policy you declared. An injected model in that
            mode can wreck the container. It cannot reach your home directory,
            your SSH keys, your Docker socket or your other containers.
          </p>
          <p>
            A guarded working directory is a different thing wearing the same
            word. Husk&rsquo;s local provider resolves every filesystem call
            through <code className="inline">realpath</code> and rejects
            anything that leaves the workspace, including through a symlink
            created inside it. It strips credential-shaped environment
            variables. It refuses a short list of unrecoverable commands. It
            caps captured output and kills the whole process group on timeout.
            Those are real controls and they are tested. The agent still shares
            your kernel, your network and your user account, and the command
            policy is a deny list, and deny lists are bypassable by anyone who
            is trying.
          </p>
          <p>
            <strong>
              Both of those are worth shipping. Calling them the same thing is
              not.
            </strong>
          </p>

          <h2 className="h-sub">Vagueness is a design decision</h2>
          <p>
            When a product will not say which mode you are in, that is not an
            oversight in the documentation. It is a product decision, made
            because the honest sentence is unflattering and the vague one
            converts better. The cost is paid later, by someone who believed
            they had containment, in a postmortem.
          </p>
          <p>
            So the isolation guarantee has to be a value in the program, not a
            paragraph on a website. In Husk it is a field on the provider
            interface. <code className="inline">husk doctor</code> prints it.
            The CLI says it the first time you use a provider that does not
            have it. The MCP server puts it in the model&rsquo;s first tool
            result, because a model that believes it is contained when it is
            not will take risks it otherwise would not.
          </p>

          <div style={{ margin: "var(--space-8) 0" }}>
            <CommandBlock command="husk doctor" />
          </div>

          <p>
            It names your provider, whether that provider is isolated, and what
            to do about it. It never silently substitutes a weaker provider for
            the one you asked for: asking for{" "}
            <code className="inline">--provider docker</code> with the daemon
            down is an error, not a downgrade.
          </p>

          <h2 className="h-sub">Why the deny list stays short</h2>
          <p>
            An over-eager deny list gets switched off, and a switched-off deny
            list protects nobody. The bar for inclusion is narrow on purpose:
            no legitimate agent task needs this, and running it by accident is
            unrecoverable. <code className="inline">rm -rf ./build</code> is
            allowed. <code className="inline">rm -rf /</code> is not.{" "}
            <code className="inline">grep -r &quot;sudo&quot; .</code> is
            allowed, because matching the word{" "}
            <code className="inline">sudo</code> anywhere on a command line
            rather than in command position is exactly the false positive that
            teaches people to pass a flag that turns the guardrails off.
          </p>
          <p>
            Every rule is anchored to command position — the start of a line, or
            after a pipe, a semicolon, a logical operator, or a substitution.
            That is less clever than a scanner and considerably harder to
            annoy someone with.
          </p>

          <h2 className="h-sub">The free path is part of the argument</h2>
          <p>
            An honest sandbox story only matters if people can reach it. Most
            products in this space start at a hosted control plane and add a
            local option later, which inverts the trust and cost story for the
            people most likely to try it first: someone with no budget and a
            laptop.
          </p>
          <p>
            Husk goes the other way. The local provider is the primitive and
            everything hosted is a plugin behind the same interface. There is no
            account, no card, and no telemetry — absent from the codebase, not
            disabled by a flag. That is not generosity. It is what makes the
            honesty checkable: you can read the code that decides whether you
            are isolated, on the machine you are asking about, in the time it
            takes to clone a repository.
          </p>

          <h2 className="h-sub">What we concede</h2>
          <p>
            Husk is single-user in v1 with no hosted control plane. It does not
            do GPUs. Cold starts on Docker are Docker&rsquo;s cold starts. The
            local provider is not a security boundary. Saying these first is
            cheaper than being caught omitting them, and it is the same
            discipline the isolation flag exists to enforce.
          </p>
          <p>
            We supply the body. The agent supplies the mind. The least we can do
            is tell you which room it is standing in.
          </p>
        </div>

        <hr
          style={{
            border: 0,
            borderTop: "var(--border-width-hairline) solid var(--color-border)",
            margin: "var(--space-16) 0 var(--space-8)",
          }}
        />

        <p className="small">
          The mechanics behind every claim above are in{" "}
          <Link href="/#providers">the provider table</Link> and in the
          repository&rsquo;s security model.
        </p>
      </article>
    </main>
  );
}
