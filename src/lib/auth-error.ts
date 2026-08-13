const fallbackAuthError = "Google login was rejected. Try again.";

export function getAuthErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const message = raw.replace(/^error:\s*/i, "").replace(/\s+/g, " ").trim();
  if (!message) return fallbackAuthError;

  if (/google account is not allowed for this vault/i.test(message)) {
    return "This Google account does not have vault access. If you were invited, sign out of Google and use the exact email address on the invitation.";
  }

  const limited = message.slice(0, 240);
  const readable = limited.charAt(0).toUpperCase() + limited.slice(1);
  return /[.!?]$/.test(readable) ? readable : `${readable}.`;
}
