import { OG_CONTENT_TYPE, OG_SIZE, ogCard } from "@/lib/og-card";

export const alt =
  "Pricing — Husk is free and open source, with no paid plan and no trial.";
export const dynamic = "force-static";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

/* Quoted from the page's own metadata rather than written again here. */
export default function PricingOpengraphImage() {
  return ogCard({
    eyebrow: "pricing",
    title: "There is no paid tier.",
    lead: "Husk is free and open source. There’s no paid plan and no trial.",
    note: "What a hosted tier would have to add before it was worth charging for",
  });
}
