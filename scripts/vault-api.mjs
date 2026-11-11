// Minimal client for the vault HTTP API (docs/cloudflare/API.md): POST
// <api>/api/<function>, API key in the Authorization header.
const base = (process.env.WHAGONS_DEV_API_URL || "https://skills.whagons.com").replace(/\/$/, "");

export async function callVault(path, args, apiKey) {
  const response = await fetch(`${base}/api/${encodeURIComponent(path)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(args ?? {}),
  });
  const body = await response.json().catch(() => ({}));
  if (body.error !== undefined || !response.ok) throw new Error(`${path}: ${body.error ?? `HTTP ${response.status}`}`);
  return body.result;
}
