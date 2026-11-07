import { MCP_COMMAND } from "@/lib/content";
import { OG_CONTENT_TYPE, OG_SIZE, ogCard } from "@/lib/og-card";

export const alt =
  "Husk — your AI chat gets a computer. claude mcp add husk -- npx -y @husk-ai/mcp";
export const dynamic = "force-static";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function OpengraphImage() {
  return ogCard({
    title: "Your AI chat gets a computer.",
    lead: "Files, a browser, and somewhere to run code. Free. No account, no card.",
    command: MCP_COMMAND,
    note: "Apache-2.0 · docker, podman, local, ssh, fly · husk doctor tells you which one you got",
  });
}
