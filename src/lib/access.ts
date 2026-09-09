export type AccessRole = {
  id: string; name: string; description: string; scopes: string[];
  all_skills: boolean; skill_ids: string[];
  all_credentials: boolean; credential_ids: string[];
};
export type AccessState = { role: AccessRole; roles: AccessRole[]; assignments: Record<string, string> };
export const accessAPI = {
  state: { kind: "query", path: "access.state" },
  vault: { kind: "query", path: "access.vault" },
  saveRole: { kind: "mutation", path: "access.saveRole" },
  deleteRole: { kind: "mutation", path: "access.deleteRole" },
  assignRole: { kind: "mutation", path: "access.assignRole" },
} as const;
export function canAccess(role: AccessRole | undefined, scope: string, id = "") {
  if (!role?.scopes?.includes(scope)) return false;
  if (scope.startsWith("skills:")) return role.all_skills || role.skill_ids?.includes(id);
  if (scope.startsWith("credentials:")) return role.all_credentials || role.credential_ids?.includes(id);
  return true;
}
export function newRole(): AccessRole {
  return { id: "", name: "", description: "", scopes: ["skills:read"], all_skills: false, skill_ids: [], all_credentials: false, credential_ids: [] };
}
export function resourceSummary(role: AccessRole, kind: "skills" | "credentials") {
  if (!role.scopes?.includes(`${kind}:read`)) return `No ${kind}`;
  const count = (kind === "skills" ? role.skill_ids : role.credential_ids)?.length ?? 0;
  const all = kind === "skills" ? role.all_skills : role.all_credentials;
  return `${all ? "All" : count} ${!all && count === 1 ? kind.slice(0, -1) : kind}${role.scopes.includes(`${kind}:write`) ? " · can edit" : " · read only"}`;
}
