export function withGonvexProject(rawURL: string, project: string): string {
  const url = new URL(rawURL);
  url.searchParams.set("project", project);
  return url.toString();
}
