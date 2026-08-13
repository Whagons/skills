export function invitationInstructions(email: string, vaultOrigin: string): string {
  const invitedEmail = email.trim().toLowerCase();
  const vaultURL = vaultOrigin.replace(/\/$/, "");
  return `You've been invited to the Whagons Skills Vault.

1. Open ${vaultURL}
2. Sign in with Google as ${invitedEmail}
3. Accept the workspace invitation

The invitation only works with that exact Google account.`;
}
