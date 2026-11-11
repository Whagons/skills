// Gonvex backend (the current production deployment on Coolify). Selected by
// the "@backend" alias unless VITE_SKILLS_BACKEND=cloudflare.
import type { ReactNode } from "react";
import { GonvexClient } from "../../gonvex/_generated/client";
import { GonvexProvider } from "../../gonvex/_generated/react";
import { withGonvexProject } from "../lib/gonvex-url";

export { api } from "../../gonvex/_generated/api";
export { useConvex, useMutation, useSync } from "../../gonvex/_generated/react";

const gonvexWSURL = import.meta.env.VITE_GONVEX_WS_URL ?? "wss://gonvex.whagons.com/ws";
const gonvexProjectID = import.meta.env.VITE_GONVEX_PROJECT_ID ?? "01f1974b-dcda-6fc3-b16d-9acf5f3b4192";

function devJWT() {
  const encode = (value: object) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ sub: "skills-vault", email: "skills@whagons.local" })}.vault`;
}

const gonvex = new GonvexClient(withGonvexProject(gonvexWSURL, gonvexProjectID), {
  project: gonvexProjectID,
  token: devJWT(),
  tenant: gonvexProjectID,
  queryCache: false,
  errorReporting: false,
});

export function BackendProvider({ children }: { children: ReactNode }) {
  return <GonvexProvider client={gonvex}>{children}</GonvexProvider>;
}

export const backendLabel = "Gonvex runtime";
export const backendStatus = "Gonvex live";
export const backendFeatures = { accessLog: false };
export const backendHost = "gonvex.whagons.com";

function agentExample() {
  return `import { GonvexClient } from "@gonvex/client";

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = \`\${encode({ alg: "none", typ: "JWT" })}.\${encode({
  sub: "agent",
  email: "agent@whagons.local",
})}.agent\`;

const client = new GonvexClient("wss://gonvex.whagons.com/ws?project=01f1974b-dcda-6fc3-b16d-9acf5f3b4192", {
  token,
  tenant: "01f1974b-dcda-6fc3-b16d-9acf5f3b4192",
});

const apiKey = process.env.WHAGONS_DEV_API_KEY;
if (!apiKey) throw new Error("WHAGONS_DEV_API_KEY is required");

const skills = await client.query(
  { kind: "query", path: "agent.skills.list" },
  { apiKey }
);

await client.mutation(
  { kind: "mutation", path: "agent.skills.upload" },
  {
    apiKey,
    id: "local-my-skill",
    name: "my-skill",
    summary: "Short trigger description",
    content: skillMarkdown,
  }
);

const skill = await client.query(
  { kind: "query", path: "agent.skills.get" },
  { apiKey, name: "whagons-monitor" }
);

const credentials = await client.query(
  { kind: "query", path: "agent.credentials.list" },
  { apiKey }
);

const credential = await client.query(
  { kind: "query", path: "agent.credentials.get" },
  { apiKey, name: "coolify-whagons" }
);

client.close();`;
}

export function scriptAPIGuide() {
  return `Direct Gonvex API path for custom scripts:
1. npm install @gonvex/client
2. Runtime: ${gonvexWSURL}  ·  project/tenant: ${gonvexProjectID}
3. Call agent endpoints with the API key:
${agentExample()}`;
}
