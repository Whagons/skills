type SkillRevision = {
  id: string;
  updated_at: string;
};

export function isCurrentSkillRevision(
  metadata: SkillRevision | null | undefined,
  detail: SkillRevision | null | undefined,
): boolean {
  return Boolean(
    metadata
    && detail
    && metadata.id === detail.id
    && metadata.updated_at === detail.updated_at,
  );
}
