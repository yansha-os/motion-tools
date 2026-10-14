export type DossierStatus = 'passed' | 'failed' | 'unknown' | 'not_requested' | 'stale';
export type DossierCheck = { id: string; status: DossierStatus; detail: string; evidence?: unknown };

export function summarizeAnimationReleaseDossier(checks: DossierCheck[]) {
  const required = new Set(['recipe_integrity', 'native_export', 'studio_acceptance']);
  const requiredChecks = checks.filter(check => required.has(check.id));
  const checksById = new Map<string, DossierCheck[]>();
  for (const check of requiredChecks) checksById.set(check.id, [...(checksById.get(check.id) ?? []), check]);
  const duplicateIds = [...required].filter(id => (checksById.get(id)?.length ?? 0) > 1);
  const failed = duplicateIds.length > 0 || requiredChecks.some(check => check.status === 'failed' || check.status === 'stale');
  const complete = [...required].every(id => {
    const matching = checksById.get(id);
    return matching?.length === 1 && matching[0]?.status === 'passed';
  });
  const technicalStatus = failed ? 'blocked' as const : complete ? 'technically_verified' as const : 'incomplete' as const;
  const nextActions = [...required].flatMap(id => {
    const matching = checksById.get(id) ?? [];
    if (matching.length === 0) return [`${id}: required evidence is missing; collect it for the exact current animation revision and intended rig.`];
    if (matching.length > 1) return [`${id}: duplicate required-check entries make this evidence ambiguous; resolve the duplicates and rerun the dossier.`];
    const check = matching[0]!;
    if (check.status === 'passed') return [];
    if (check.status === 'failed' || check.status === 'stale') return [`${id}: resolve the reported failure or refresh stale evidence, then rerun that check.`];
    if (check.status === 'not_requested') return [`${id}: provide the evidence identifier or target rig needed to evaluate this check.`];
    return [`${id}: collect fresh evidence for the exact current animation revision and intended rig.`];
  });
  if (!nextActions.length) nextActions.push('Technical checks are recorded for the exact current recipe. Review the actual animation in Studio and obtain explicit user approval before saving or publishing.');
  return {
    technicalStatus,
    requiredChecks: [...required],
    humanApproval: 'required' as const,
    canPublish: false as const,
    nextActions,
    limitation: 'This dossier assembles recipe integrity, native conversion and declared Studio acceptance evidence. It does not judge artistic quality, rendered skinning, gameplay context, all Roblox runtime behavior, publishing permissions, or user approval. Visual assessments and AI workflow reviews are reported separately and never substitute for human sign-off.',
  };
}
