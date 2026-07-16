export type VaultTab = "skills" | "apiKeys" | "credentials" | "team";

const tabQueryValue: Record<VaultTab, string> = {
  skills: "skills",
  apiKeys: "api-keys",
  credentials: "credentials",
  team: "team",
};

const tabByQueryValue = new Map(
  Object.entries(tabQueryValue).map(([tab, value]) => [value, tab as VaultTab]),
);

function currentURL(input: string | URL) {
  return input instanceof URL ? new URL(input) : new URL(input, "https://skills.whagons.com");
}

function relativeURL(url: URL) {
  return `${url.pathname}${url.search}${url.hash}`;
}

export function readVaultTab(input: string | URL): VaultTab {
  const value = currentURL(input).searchParams.get("tab") ?? "";
  return tabByQueryValue.get(value) ?? "skills";
}

export function vaultURLForTab(input: string | URL, tab: VaultTab) {
  const url = currentURL(input);
  if (tab === "skills") {
    url.searchParams.delete("tab");
  } else {
    url.searchParams.set("tab", tabQueryValue[tab]);
  }
  return relativeURL(url);
}

export function vaultURLForSkill(input: string | URL, skillID: string) {
  const url = currentURL(input);
  url.hash = skillID;
  return relativeURL(url);
}

export function vaultURLWithoutCLIAuth(input: string | URL) {
  const url = currentURL(input);
  url.searchParams.delete("cli_callback");
  url.searchParams.delete("cli_state");
  url.searchParams.delete("cli_name");
  return relativeURL(url);
}
