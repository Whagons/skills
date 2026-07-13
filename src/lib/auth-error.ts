const fallbackAuthError = "Google login was rejected. Try again.";

export function getAuthErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const message = raw.replace(/^error:\s*/i, "").replace(/\s+/g, " ").trim();
  if (!message) return fallbackAuthError;

  const limited = message.slice(0, 240);
  const readable = limited.charAt(0).toUpperCase() + limited.slice(1);
  return /[.!?]$/.test(readable) ? readable : `${readable}.`;
}
