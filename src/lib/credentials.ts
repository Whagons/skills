export type CredentialListItem = {
  id: string;
  name: string;
  updated_at: string;
};

function credentialNameKey(name: string) {
  return name.trim().toLocaleLowerCase();
}

export function dedupeCredentials<T extends CredentialListItem>(credentials: T[]): T[] {
  const byName = new Map<string, T>();

  for (const credential of credentials) {
    const key = credentialNameKey(credential.name);
    const current = byName.get(key);
    if (!current || Date.parse(credential.updated_at) > Date.parse(current.updated_at)) {
      byName.set(key, credential);
    }
  }

  return [...byName.values()].sort((left, right) => {
    const nameOrder = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    if (nameOrder !== 0) return nameOrder;
    return Date.parse(right.updated_at) - Date.parse(left.updated_at);
  });
}
