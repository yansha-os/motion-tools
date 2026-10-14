import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, opendir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { identifier } from './recipes.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const studioBuildIdentitySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('captured'), value: z.string().min(1).max(128), source: z.literal('roblox_version_global_deprecated') }).strict(),
  z.object({ status: z.literal('unavailable'), value: z.null().optional(), source: z.literal('unavailable') }).strict(),
]);
export type StudioBuildIdentity = z.infer<typeof studioBuildIdentitySchema>;
const unavailableStudioBuildIdentity: StudioBuildIdentity = { status: 'unavailable', value: null, source: 'unavailable' };
const sample = z.object({ at: z.number().finite().min(0).max(3), weightCurrent: z.number().finite().min(0).max(1),
  weightTarget: z.number().finite().min(0).max(1) }).strict();
const curve = z.array(sample).min(2).max(362);
const naturalCompletionSchema = z.object({
  authoredDurationSeconds: z.number().finite().min(0.01).max(30),
  animationLengthSeconds: z.number().finite().positive().max(30),
  playbackSpeed: z.number().finite().min(0.1).max(4),
  endedAfterStoppedSeconds: z.number().finite().min(0).max(3),
  samples: z.array(sample).min(1).max(362),
}).strict().superRefine((measurement, context) => {
  if (measurement.samples[0]!.at !== 0
    || Math.abs(measurement.samples.at(-1)!.at - measurement.endedAfterStoppedSeconds) > 0.001
    || Math.abs(measurement.samples.at(-1)!.weightCurrent) > 0.01
    || measurement.samples.some((item, index) => index > 0 && item.at <= measurement.samples[index - 1]!.at)
    || (measurement.endedAfterStoppedSeconds === 0 && measurement.samples.length !== 1)
    || (measurement.endedAfterStoppedSeconds > 0 && measurement.samples.length < 2)) {
    context.addIssue({ code: 'custom', path: ['samples'], message: 'Natural-completion samples must be ordered and span the observed fade from its start through zero weight.' });
  }
});
export const studioPlayRetriggerProbeSchema = z.object({ probeElapsedSeconds: z.number().finite().min(0.001).max(3),
  timePositionBefore: z.number().finite().min(0).max(30), timePositionImmediatelyAfter: z.number().finite().min(0).max(30),
  timePositionAfterStep: z.number().finite().min(0).max(30), weightCurrentBefore: z.number().finite().min(0).max(1),
  weightCurrentImmediatelyAfter: z.number().finite().min(0).max(1), weightTargetImmediatelyAfter: z.number().finite().min(0).max(1),
  observedClockBehavior: z.enum(['reset_to_zero', 'preserved', 'ambiguous']) }).strict().superRefine((probe, context) => {
  const behavior = probe.timePositionImmediatelyAfter <= 0.005 && probe.timePositionBefore > probe.probeElapsedSeconds / 2
    ? 'reset_to_zero' : Math.abs(probe.timePositionImmediatelyAfter - probe.timePositionBefore) <= 0.005 ? 'preserved' : 'ambiguous';
  if (probe.observedClockBehavior !== behavior) context.addIssue({ code: 'custom', path: ['observedClockBehavior'],
    message: 'Observed clock behavior must agree with the immediate pre/post Play time-position samples.' });
});
const profileContentSchema = z.object({ schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]), graphId: identifier, graphFingerprint: hash,
  rigId: identifier, rigSignature: z.string().min(1).max(30000), stateId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/),
  recipeFingerprint: hash, jointMapFingerprint: hash, fadeSeconds: z.number().finite().min(0.05).max(3), sampleRateHz: z.number().int().min(10).max(120),
  playIn: curve, stopOut: curve, adjustWeightIn: curve.optional(), adjustWeightOut: curve.optional(),
  playRetrigger: studioPlayRetriggerProbeSchema.optional(), naturalCompletion: naturalCompletionSchema.optional(),
  limitation: z.string().max(1000), createdAt: z.string().datetime(),
  studioBuildIdentity: studioBuildIdentitySchema.optional() }).strict();
const profileSchema = profileContentSchema.extend({ id: identifier, profileFingerprint: hash }).strict().superRefine((profile, context) => {
  if ((profile.schemaVersion >= 2) !== (profile.playRetrigger !== undefined)) {
    context.addIssue({ code: 'custom', path: ['playRetrigger'], message: 'Version 2+ calibration profiles require exactly one Play-retrigger behavior probe.' });
  }
  if (profile.schemaVersion >= 3 && (!profile.playRetrigger || !profile.naturalCompletion)) {
    context.addIssue({ code: 'custom', path: ['naturalCompletion'], message: 'Version 3+ calibration profiles require both a Play-retrigger probe and natural-completion measurement.' });
  }
  if (profile.schemaVersion < 3 && profile.naturalCompletion !== undefined) {
    context.addIssue({ code: 'custom', path: ['naturalCompletion'], message: 'Natural-completion evidence requires a version 3 calibration profile.' });
  }
  if (profile.schemaVersion === 4 && (!profile.adjustWeightIn || !profile.adjustWeightOut)) {
    context.addIssue({ code: 'custom', path: ['adjustWeightIn'], message: 'Version 4 calibration profiles require both native AdjustWeight curves.' });
  }
  if (profile.schemaVersion < 4 && (profile.adjustWeightIn !== undefined || profile.adjustWeightOut !== undefined)) {
    context.addIssue({ code: 'custom', path: ['adjustWeightIn'], message: 'Native AdjustWeight curves require a version 4 calibration profile.' });
  }
  const { profileFingerprint, ...attestedContent } = profile;
  if (digest(attestedContent) !== profileFingerprint) context.addIssue({ code: 'custom', path: ['profileFingerprint'], message: 'Fade calibration profile fingerprint does not match its content.' });
  for (const [name, samples, finalWeight] of [['playIn', profile.playIn, 1], ['stopOut', profile.stopOut, 0]] as const) {
    if (samples[0]!.at !== 0 || Math.abs(samples[0]!.weightTarget - finalWeight) > 0.0001
      || Math.abs(samples.at(-1)!.at - profile.fadeSeconds) > 0.001
      || Math.abs(samples.at(-1)!.weightCurrent - finalWeight) > 0.01
      || samples.some((item, index) => index > 0 && item.at <= samples[index - 1]!.at)) {
      context.addIssue({ code: 'custom', path: [name], message: 'Fade curve must have ordered times and verified expected endpoints.' });
    }
  }
  for (const [name, samples, finalWeight] of [['adjustWeightIn', profile.adjustWeightIn, 1], ['adjustWeightOut', profile.adjustWeightOut, 0]] as const) {
    if (!samples) continue;
    if (samples[0]!.at !== 0 || Math.abs(samples[0]!.weightTarget - finalWeight) > 0.0001
      || Math.abs(samples.at(-1)!.at - profile.fadeSeconds) > 0.001
      || Math.abs(samples.at(-1)!.weightCurrent - finalWeight) > 0.01
      || samples.some((item, index) => index > 0 && item.at <= samples[index - 1]!.at)) {
      context.addIssue({ code: 'custom', path: [name], message: 'AdjustWeight curve must have ordered times and verified start/end evidence matching its duration.' });
    }
  }
});
const catalogEntryContentSchema = z.object({ schemaVersion: z.literal(1), id: identifier, graphId: identifier, rigId: identifier,
  createdAt: z.string().datetime(), profileFingerprint: hash }).strict();
const catalogEntrySchema = catalogEntryContentSchema.extend({ entryFingerprint: hash }).strict().superRefine((entry, context) => {
  const { entryFingerprint, ...content } = entry;
  if (digest(content) !== entryFingerprint) context.addIssue({ code: 'custom', path: ['entryFingerprint'], message: 'Calibration catalog entry fingerprint mismatch.' });
});

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }

export type AnimationGraphFadeCalibration = z.infer<typeof profileSchema>;
export type AnimationGraphFadeCalibrationDraft = Omit<z.infer<typeof profileContentSchema>, 'schemaVersion' | 'createdAt'>;

export function assessAnimationGraphFadeCalibration(profile: Pick<AnimationGraphFadeCalibration,
  'fadeSeconds' | 'sampleRateHz' | 'playIn' | 'stopOut' | 'adjustWeightIn' | 'adjustWeightOut' | 'naturalCompletion'>) {
  const assessCurve = (curve: AnimationGraphFadeCalibration['playIn'], direction: 'increasing' | 'decreasing', duration: number) => {
    const expectedStartWeight = direction === 'increasing' ? 0 : 1;
    const expectedEndWeight = direction === 'increasing' ? 1 : 0;
    const expectedIntervals = Math.ceil(duration * profile.sampleRateHz);
    const expectedSamples = expectedIntervals + 1;
    const gaps = curve.slice(1).map((sample, index) => sample.at - curve[index]!.at);
    const maxSampleGapSeconds = gaps.length > 0 ? Math.max(...gaps) : duration;
    const targetWeights = curve.map(sample => sample.weightTarget);
    const targetDriftCount = targetWeights.filter(weight => Math.abs(weight - targetWeights[0]!) > 1e-4).length;
    const startWeightError = Math.abs(curve[0]!.weightCurrent - expectedStartWeight);
    const endWeightError = Math.abs(curve.at(-1)!.weightCurrent - expectedEndWeight);
    const timeSpanErrorSeconds = Math.abs(curve.at(-1)!.at - duration) + curve[0]!.at;
    const reversedSteps = curve.slice(1).map((sample, index) => direction === 'increasing'
      ? curve[index]!.weightCurrent - sample.weightCurrent : sample.weightCurrent - curve[index]!.weightCurrent)
      .filter(delta => delta > 1e-3);
    const warnings: string[] = [];
    if (curve.length < expectedSamples) warnings.push('sample_coverage_below_requested_rate');
    if (maxSampleGapSeconds > 1.5 / profile.sampleRateHz) warnings.push('large_sample_time_gap');
    if (targetDriftCount > 0) warnings.push('weight_target_changed_during_fade');
    if (reversedSteps.length > 0) warnings.push('weight_current_reversed_direction');
    if (startWeightError > 0.01) warnings.push('unexpected_start_weight');
    if (endWeightError > 0.01) warnings.push('incomplete_endpoint_weight');
    if (timeSpanErrorSeconds > 0.001) warnings.push('incomplete_fade_time_span');
    return { sampleCount: curve.length, expectedSampleCount: expectedSamples, coverage: Math.min(1, curve.length / expectedSamples),
      maxSampleGapSeconds, targetDriftCount, startWeightError, endWeightError, timeSpanErrorSeconds, reversalCount: reversedSteps.length,
      maximumReversal: reversedSteps.length > 0 ? Math.max(...reversedSteps) : 0, warnings };
  };
  const playIn = assessCurve(profile.playIn, 'increasing', profile.fadeSeconds);
  const stopOut = assessCurve(profile.stopOut, 'decreasing', profile.fadeSeconds);
  const adjustWeightIn = profile.adjustWeightIn ? assessCurve(profile.adjustWeightIn, 'increasing', profile.fadeSeconds) : undefined;
  const adjustWeightOut = profile.adjustWeightOut ? assessCurve(profile.adjustWeightOut, 'decreasing', profile.fadeSeconds) : undefined;
  const naturalCompletion = profile.naturalCompletion
    ? assessCurve(profile.naturalCompletion.samples, 'decreasing', profile.naturalCompletion.endedAfterStoppedSeconds) : undefined;
  const warningCount = playIn.warnings.length + stopOut.warnings.length + (adjustWeightIn?.warnings.length ?? 0)
    + (adjustWeightOut?.warnings.length ?? 0) + (naturalCompletion?.warnings.length ?? 0);
  return { status: warningCount === 0 ? 'clean' as const : 'review' as const,
    method: 'requested-rate coverage, observed sample spacing, target stability, and monotonic direction checks; diagnostics do not reject empirical curves',
    playIn, stopOut, ...(adjustWeightIn ? { adjustWeightIn } : {}), ...(adjustWeightOut ? { adjustWeightOut } : {}),
    ...(naturalCompletion ? { naturalCompletion } : {}) };
}

export class AnimationGraphFadeCalibrationLibrary {
  constructor(readonly directory: string) {}

  private catalogPath(profile: Pick<AnimationGraphFadeCalibration, 'graphId' | 'rigId' | 'createdAt' | 'id'>) {
    const sortableTime = profile.createdAt.replace(/[-:.]/g, '');
    return join(this.directory, 'catalog', profile.graphId, profile.rigId, `${sortableTime}_${profile.id}.json`);
  }

  private async writeCatalogEntry(profile: AnimationGraphFadeCalibration) {
    const content = catalogEntryContentSchema.parse({ schemaVersion: 1, id: profile.id, graphId: profile.graphId,
      rigId: profile.rigId, createdAt: profile.createdAt, profileFingerprint: profile.profileFingerprint });
    const entry = catalogEntrySchema.parse({ ...content, entryFingerprint: digest(content) });
    const path = this.catalogPath(profile);
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(entry)}\n`, { flag: 'wx' });
      try { await link(temporaryPath, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let existingEntry: z.infer<typeof catalogEntrySchema> | undefined;
        try { existingEntry = catalogEntrySchema.parse(JSON.parse(await readFile(path, 'utf8'))); }
        catch (readError) {
          if (!(readError instanceof SyntaxError) && !(readError instanceof z.ZodError)) throw readError;
        }
        if (!existingEntry || canonical(existingEntry) !== canonical(entry)) await rename(temporaryPath, path);
      }
    } finally { await unlink(temporaryPath).catch(() => undefined); }
  }

  private async writeCatalogReady(graphId: string, rigId: string) {
    const catalogDirectory = join(this.directory, 'catalog', graphId, rigId);
    await mkdir(catalogDirectory, { recursive: true });
    const path = join(catalogDirectory, '.ready-v1');
    await writeFile(path, '1\n');
  }

  private async hasCatalog(graphId: string, rigId: string) {
    try { return (await readFile(join(this.directory, 'catalog', graphId, rigId, '.ready-v1'), 'utf8')).trim() === '1'; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }

  private async listIndexed(filter: { graphId: string; rigId: string; limit: number }) {
    const catalogDirectory = join(this.directory, 'catalog', filter.graphId, filter.rigId);
    let names: string[];
    try { names = await readdir(catalogDirectory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { profiles: [], profilesTruncated: false,
        invalidRecordCount: 0, invalidRecords: [], invalidRecordsTruncated: false, invalidRecordScanComplete: false };
      throw error;
    }
    const entries = names.filter(name => /^\d{8}T\d{9}Z_[0-9a-f-]{36}\.json$/i.test(name)).sort((left, right) => {
      const timeOrder = right.slice(0, 19).localeCompare(left.slice(0, 19));
      return timeOrder || left.slice(20, -5).localeCompare(right.slice(20, -5));
    });
    const profiles: AnimationGraphFadeCalibration[] = [];
    const invalidRecords: { id: string; error: 'malformed_json' | 'schema_or_fingerprint_validation_failed' | 'filename_id_mismatch' | 'catalog_entry_invalid' }[] = [];
    let invalidRecordCount = 0;
    let catalogNeedsRebuild = false;
    let cursor = 0;
    while (cursor < entries.length && profiles.length < filter.limit) {
      const name = entries[cursor++]!;
      const id = name.slice(20, -5);
      let kind: 'malformed_json' | 'schema_or_fingerprint_validation_failed' | 'filename_id_mismatch' | 'catalog_entry_invalid' | undefined;
      let entry: z.infer<typeof catalogEntrySchema> | undefined;
      try {
        const parsed = JSON.parse(await readFile(join(catalogDirectory, name), 'utf8')) as unknown;
        try { entry = catalogEntrySchema.parse(parsed); }
        catch (error) { if (error instanceof z.ZodError) kind = 'catalog_entry_invalid'; else throw error; }
      } catch (error) {
        if (error instanceof SyntaxError) kind = 'malformed_json';
        else if ((error as NodeJS.ErrnoException).code === 'ENOENT') kind = 'catalog_entry_invalid';
        else throw error;
      }
      if (entry && !kind) {
        if (entry.id !== id || entry.graphId !== filter.graphId || entry.rigId !== filter.rigId) kind = 'catalog_entry_invalid';
        else {
          try {
            const profile = await this.get(entry.id);
            if (profile.graphId !== entry.graphId || profile.rigId !== entry.rigId || profile.createdAt !== entry.createdAt
              || profile.profileFingerprint !== entry.profileFingerprint) kind = 'catalog_entry_invalid';
            else profiles.push(profile);
          } catch (error) {
            if (error instanceof SyntaxError) kind = 'malformed_json';
            else if (error instanceof z.ZodError) kind = 'schema_or_fingerprint_validation_failed';
            else if (error instanceof Error && error.message === 'Fade calibration record ID does not match its file name.') kind = 'filename_id_mismatch';
            else if ((error as NodeJS.ErrnoException).code === 'ENOENT') kind = 'schema_or_fingerprint_validation_failed';
            else throw error;
          }
        }
      }
      if (kind) {
        invalidRecordCount++;
        invalidRecords.push({ id, error: kind });
        catalogNeedsRebuild = true;
      }
    }
    if (catalogNeedsRebuild) await unlink(join(catalogDirectory, '.ready-v1')).catch(() => undefined);
    return { profiles, profilesTruncated: cursor < entries.length, invalidRecordCount,
      invalidRecords: invalidRecords.slice(0, filter.limit), invalidRecordsTruncated: invalidRecordCount > filter.limit,
      invalidRecordScanComplete: false };
  }

  private async readPath(path: string, expectedId?: string): Promise<AnimationGraphFadeCalibration> {
    const profile = profileSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    if (expectedId !== undefined && profile.id !== expectedId) throw new Error('Fade calibration record ID does not match its file name.');
    return profile;
  }

  async record(draft: AnimationGraphFadeCalibrationDraft): Promise<AnimationGraphFadeCalibration> {
    const content = profileContentSchema.parse({ schemaVersion: draft.adjustWeightIn || draft.adjustWeightOut ? 4 : draft.naturalCompletion ? 3 : draft.playRetrigger ? 2 : 1, ...draft,
      studioBuildIdentity: draft.studioBuildIdentity ?? unavailableStudioBuildIdentity, createdAt: new Date().toISOString() });
    const id = randomUUID();
    const profile = profileSchema.parse({ id, ...content, profileFingerprint: digest({ id, ...content }) });
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, `${profile.id}.json`);
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(profile, null, 2)}\n`, { flag: 'wx' });
      await link(temporaryPath, path);
      await this.writeCatalogEntry(profile);
    } catch (error) {
      await unlink(path).catch(() => undefined);
      throw error;
    } finally { await unlink(temporaryPath).catch(() => undefined); }
    return profile;
  }

  async get(id: string): Promise<AnimationGraphFadeCalibration> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Fade calibration ID is invalid.');
    try { return await this.readPath(join(this.directory, `${id}.json`), id); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Fade calibration ${id} was not found.`);
      throw error;
    }
  }

  async listDetailed(filter: { graphId?: string; rigId?: string; limit?: number } = {}) {
    const limit = filter.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Fade calibration list limit must be between 1 and 100.');
    if (filter.graphId !== undefined) identifier.parse(filter.graphId);
    if (filter.rigId !== undefined) identifier.parse(filter.rigId);
    if (filter.graphId && filter.rigId && await this.hasCatalog(filter.graphId, filter.rigId)) {
      return this.listIndexed({ graphId: filter.graphId, rigId: filter.rigId, limit });
    }
    let directory;
    try { directory = await opendir(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { profiles: [], profilesTruncated: false,
        invalidRecordCount: 0, invalidRecords: [], invalidRecordsTruncated: false, invalidRecordScanComplete: true };
      throw error;
    }
    const catalogWasReady = Boolean(filter.graphId && filter.rigId && await this.hasCatalog(filter.graphId, filter.rigId));
    let catalogBuildSucceeded = true;
    const profiles: AnimationGraphFadeCalibration[] = [];
    let matchingProfileCount = 0;
    const invalidRecords: { id: string; error: 'malformed_json' | 'schema_or_fingerprint_validation_failed' | 'filename_id_mismatch' }[] = [];
    let invalidRecordCount = 0;
    const compareProfiles = (left: AnimationGraphFadeCalibration, right: AnimationGraphFadeCalibration) =>
      right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id);
    const processBatch = async (names: string[]) => {
      const batch = await Promise.all(names.map(async name => {
        const id = name.slice(0, -5);
        try { return { profile: await this.readPath(join(this.directory, name), id) } as const; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { disappeared: true } as const;
          if (error instanceof SyntaxError) return { invalid: { id, error: 'malformed_json' as const } } as const;
          if (error instanceof z.ZodError) return { invalid: { id, error: 'schema_or_fingerprint_validation_failed' as const } } as const;
          if (error instanceof Error && error.message === 'Fade calibration record ID does not match its file name.') {
            return { invalid: { id, error: 'filename_id_mismatch' as const } } as const;
          }
          throw error;
        }
      }));
      for (const result of batch) {
        if ('profile' in result && result.profile) {
          const profile = result.profile;
          if (!catalogWasReady) {
            try { await this.writeCatalogEntry(profile); }
            catch { catalogBuildSucceeded = false; }
          }
          if ((filter.graphId && profile.graphId !== filter.graphId) || (filter.rigId && profile.rigId !== filter.rigId)) continue;
          matchingProfileCount++;
          profiles.push(profile);
          profiles.sort(compareProfiles);
          if (profiles.length > limit) profiles.pop();
        } else if ('invalid' in result && result.invalid) {
          invalidRecordCount++;
          invalidRecords.push(result.invalid);
          invalidRecords.sort((left, right) => left.id.localeCompare(right.id));
          if (invalidRecords.length > limit) invalidRecords.pop();
        }
      }
    };
    let names: string[] = [];
    try {
      for await (const entry of directory) {
        if (entry.isFile() && /^[0-9a-f-]{36}\.json$/i.test(entry.name)) names.push(entry.name);
        if (names.length === 32) {
          await processBatch(names);
          names = [];
        }
      }
      if (names.length > 0) await processBatch(names);
    } finally {
      await directory.close().catch(() => undefined);
    }
    if (!catalogWasReady && filter.graphId && filter.rigId && catalogBuildSucceeded && invalidRecordCount === 0) {
      try { await this.writeCatalogReady(filter.graphId, filter.rigId); }
      catch { catalogBuildSucceeded = false; }
    }
    return { profiles, profilesTruncated: matchingProfileCount > limit,
      invalidRecordCount, invalidRecords, invalidRecordsTruncated: invalidRecordCount > limit,
      invalidRecordScanComplete: true };
  }

  async list(filter: { graphId?: string; rigId?: string; limit?: number } = {}) {
    return (await this.listDetailed(filter)).profiles;
  }
}
