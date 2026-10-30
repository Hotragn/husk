import { OG_CONTENT_TYPE, OG_SIZE, ogCard } from "@/lib/og-card";

export const alt =
  "Why agents need honest sandboxes — guardrails stop accidents. Only isolation stops a prompt-injected model.";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

/* Quoted from the page's own metadata rather than written again here. */
export default function ManifestoOpengraphImage() {
  return ogCard({
    eyebrow: "manifesto",
    title: "Why agents need honest sandboxes.",
    lead: "Guardrails stop accidents. Only isolation stops a prompt-injected model.",
    note: "A tool that will not tell you which one you have has made the choice for you",
  });
}
