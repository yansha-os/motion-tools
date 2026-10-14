import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { label } from './recipes.js';

export const targetPathSampleSchema = z.object({
  time: z.number().finite().min(0).max(30),
  position: z.tuple([
    z.number().finite().min(-10000).max(10000),
    z.number().finite().min(-10000).max(10000),
    z.number().finite().min(-10000).max(10000),
  ]),
}).strict();
export const targetPathSamplesSchema = z.array(targetPathSampleSchema).min(2).max(32).superRefine((samples, ctx) => {
  for (let index = 1; index < samples.length; index++) {
    if (samples[index - 1]!.time >= samples[index]!.time) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'time'], message: 'Target-path sample times must be strictly increasing.' });
    }
  }
});
export const ikTargetPathInterpolationSchema = z.enum(['linear', 'centripetal_catmull_rom']);
export type IKTargetPathInterpolation = z.infer<typeof ikTargetPathInterpolationSchema>;

export const ikTargetPathInputShape = {
  name: label,
  description: z.string().max(1000).default(''),
  tags: z.array(label).max(20).default([]),
  samples: targetPathSamplesSchema,
};
export const ikTargetPathInputSchema = z.object(ikTargetPathInputShape).strict().superRefine((path, ctx) => {
  if (new Set(path.tags.map(tag => tag.toLowerCase())).size !== path.tags.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tags'], message: 'Target-path tags must be unique, ignoring case.' });
  }
});

export const ikTargetPathListSchema = z.object({
  query: z.string().max(120).default(''),
  tag: label.optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(30),
}).strict();

export type IKTargetPath = z.infer<typeof ikTargetPathInputSchema>;
export interface IKTargetPathAsset {
  id: string;
  createdAt: string;
  fingerprint: string;
  path: IKTargetPath;
}

function contentFingerprint(path: IKTargetPath) {
  return createHash('sha256').update(JSON.stringify(path)).digest('hex');
}

function distance(left: readonly number[], right: readonly number[]) {
  return Math.hypot(left[0]! - right[0]!, left[1]! - right[1]!, left[2]! - right[2]!);
}

function lerpPoint(left: readonly number[], right: readonly number[], alpha: number): [number, number, number] {
  return [0, 1, 2].map(axis => left[axis]! + (right[axis]! - left[axis]!) * alpha) as [number, number, number];
}

/** Keep target-curve evaluation aligned with studio/IKContact.lua. */
export function sampleIKTargetPath(samplesInput: unknown, time: number, interpolation: IKTargetPathInterpolation = 'linear') {
  interpolation = ikTargetPathInterpolationSchema.parse(interpolation);
  const samples = targetPathSamplesSchema.parse(samplesInput);
  if (!Number.isFinite(time) || time < samples[0]!.time || time > samples.at(-1)!.time) throw new Error('IK target path does not cover the requested sample time.');
  if (samples.length === 2 && interpolation === 'centripetal_catmull_rom') interpolation = 'linear';
  for (let rightIndex = 1; rightIndex < samples.length; rightIndex++) {
    const left = samples[rightIndex - 1]!, right = samples[rightIndex]!;
    if (time > right.time) continue;
    const alpha = (time - left.time) / (right.time - left.time);
    if (interpolation === 'linear') return lerpPoint(left.position, right.position, alpha);
    const previous = samples[rightIndex - 2]?.position ?? left.position.map((value, axis) => 2 * value - right.position[axis]!) as [number, number, number];
    const following = samples[rightIndex + 1]?.position ?? right.position.map((value, axis) => 2 * value - left.position[axis]!) as [number, number, number];
    if (distance(previous, left.position) < 1e-8 || distance(left.position, right.position) < 1e-8 || distance(right.position, following) < 1e-8) {
      return lerpPoint(left.position, right.position, alpha);
    }
    const t0 = 0;
    const t1 = t0 + Math.sqrt(distance(previous, left.position));
    const t2 = t1 + Math.sqrt(distance(left.position, right.position));
    const t3 = t2 + Math.sqrt(distance(right.position, following));
    const t = t1 + (t2 - t1) * alpha;
    const blend = (a: readonly number[], b: readonly number[], ta: number, tb: number) => lerpPoint(a, b, (t - ta) / Math.max(tb - ta, 1e-9));
    const a1 = blend(previous, left.position, t0, t1);
    const a2 = blend(left.position, right.position, t1, t2);
    const a3 = blend(right.position, following, t2, t3);
    const b1 = lerpPoint(a1, a2, (t - t0) / Math.max(t2 - t0, 1e-9));
    const b2 = lerpPoint(a2, a3, (t - t1) / Math.max(t3 - t1, 1e-9));
    return lerpPoint(b1, b2, alpha);
  }
  return [...samples.at(-1)!.position] as [number, number, number];
}

/** Measure a target curve without asserting that it is reachable or physically valid. */
export function analyzeIKTargetPath(samplesInput: unknown, interpolation: IKTargetPathInterpolation = 'linear', sampleRateHz: 15 | 30 | 60 = 30) {
  interpolation = ikTargetPathInterpolationSchema.parse(interpolation);
  if (sampleRateHz !== 15 && sampleRateHz !== 30 && sampleRateHz !== 60) throw new Error('IK target path sampleRateHz must be 15, 30, or 60.');
  const samples = targetPathSamplesSchema.parse(samplesInput);
  const startTime = samples[0]!.time, endTime = samples.at(-1)!.time, duration = endTime - startTime;
  if (!(duration > 0)) throw new Error('IK target path must have positive duration.');
  const intervals = Math.ceil(duration * sampleRateHz);
  const times = [...new Set([
    ...Array.from({ length: intervals + 1 }, (_, index) => index === intervals ? endTime : startTime + duration * index / intervals),
    ...samples.map(sample => sample.time),
  ])].sort((left, right) => left - right);
  const points = times.map(time => ({ time, position: sampleIKTargetPath(samples, time, interpolation) }));
  let pathLengthStuds = 0, peakSampledSpeedStudsPerSecond = 0, peakSampledAccelerationStudsPerSecondSquared = 0;
  let peakSpeedTime = startTime, peakAccelerationTime = startTime;
  const velocities: Array<{ time: number; value: [number, number, number] }> = [];
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1]!, current = points[index]!, deltaTime = current.time - previous.time;
    if (deltaTime <= 0) continue;
    const velocity = current.position.map((value, axis) => (value - previous.position[axis]!) / deltaTime) as [number, number, number];
    const speed = Math.hypot(...velocity);
    pathLengthStuds += distance(current.position, previous.position);
    velocities.push({ time: (previous.time + current.time) / 2, value: velocity });
    if (speed > peakSampledSpeedStudsPerSecond) { peakSampledSpeedStudsPerSecond = speed; peakSpeedTime = current.time; }
  }
  for (let index = 1; index < velocities.length; index++) {
    const previous = velocities[index - 1]!, current = velocities[index]!;
    const deltaTime = current.time - previous.time;
    if (deltaTime <= 0) continue;
    const acceleration = Math.hypot(...current.value.map((value, axis) => value - previous.value[axis]!)) / deltaTime;
    if (acceleration > peakSampledAccelerationStudsPerSecondSquared) { peakSampledAccelerationStudsPerSecondSquared = acceleration; peakAccelerationTime = current.time; }
  }
  const waypointSegments = samples.slice(1).map((right, index) => {
    const left = samples[index]!, lengthStuds = distance(left.position, right.position), segmentDuration = right.time - left.time;
    let maximumDeviationFromChordStuds = 0, maximumDeviationTime = left.time;
    for (const point of points) {
      if (point.time < left.time || point.time > right.time) continue;
      const alpha = (point.time - left.time) / segmentDuration;
      const deviation = distance(point.position, lerpPoint(left.position, right.position, alpha));
      if (deviation > maximumDeviationFromChordStuds) {
        maximumDeviationFromChordStuds = deviation;
        maximumDeviationTime = point.time;
      }
    }
    return { startTime: left.time, endTime: right.time, durationSeconds: segmentDuration, chordLengthStuds: lengthStuds,
      averageChordSpeedStudsPerSecond: lengthStuds / segmentDuration, maximumDeviationFromChordStuds, maximumDeviationTime };
  });
  const maximumDeviationFromWaypointChordsStuds = Math.max(...waypointSegments.map(segment => segment.maximumDeviationFromChordStuds));
  const maximumDeviationSegment = waypointSegments.find(segment => segment.maximumDeviationFromChordStuds === maximumDeviationFromWaypointChordsStuds);
  return {
    interpolation, sampleRateHz, sampleCount: points.length, startTime, endTime, durationSeconds: duration,
    pathLengthStuds, averagePathSpeedStudsPerSecond: pathLengthStuds / duration,
    peakSampledSpeedStudsPerSecond, peakSpeedTime,
    peakSampledAccelerationStudsPerSecondSquared, peakAccelerationTime,
    maximumDeviationFromWaypointChordsStuds, maximumDeviationTime: maximumDeviationSegment?.maximumDeviationTime ?? startTime,
    maximumDeviationSegment: maximumDeviationSegment ? { startTime: maximumDeviationSegment.startTime, endTime: maximumDeviationSegment.endTime } : null,
    waypointSegments,
    limitation: 'Metrics are sampled geometry in Studio world studs. This analysis does not test limb reachability, CCD convergence, collisions, moving-frame attachment, authored animation quality, or motion between analysis samples.',
  };
}

/** Immutable local library for authored world-space IK targets. */
export class IKTargetPathLibrary {
  constructor(readonly directory: string) {}

  async save(input: unknown): Promise<IKTargetPathAsset> {
    const path = ikTargetPathInputSchema.parse(input);
    await mkdir(this.directory, { recursive: true });
    const asset: IKTargetPathAsset = { id: randomUUID(), createdAt: new Date().toISOString(), fingerprint: contentFingerprint(path), path };
    await writeFile(join(this.directory, `${asset.id}.json`), JSON.stringify(asset, null, 2), { flag: 'wx' });
    return asset;
  }

  async get(id: string): Promise<IKTargetPathAsset> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid IK target-path asset ID.');
    const asset = JSON.parse(await readFile(join(this.directory, `${id}.json`), 'utf8')) as IKTargetPathAsset;
    if (asset.id !== id) throw new Error('IK target-path identity mismatch.');
    asset.path = ikTargetPathInputSchema.parse(asset.path);
    const currentFingerprint = contentFingerprint(asset.path);
    if (asset.fingerprint !== currentFingerprint) throw new Error('IK target-path contents changed after save; refusing to use a corrupted asset.');
    return asset;
  }

  async list(input: z.input<typeof ikTargetPathListSchema> = {}) {
    const options = ikTargetPathListSchema.parse(input);
    await mkdir(this.directory, { recursive: true });
    const names = (await readdir(this.directory)).filter(name => /^[0-9a-f-]{36}\.json$/i.test(name));
    const query = options.query.trim().toLowerCase();
    const matches: Array<Omit<IKTargetPathAsset, 'path'> & { name: string; description: string; tags: string[]; sampleCount: number; startTime: number; endTime: number }> = [];
    for (let start = 0; start < names.length; start += 16) {
      const assets = await Promise.all(names.slice(start, start + 16).map(name => this.get(name.slice(0, -5))));
      for (const { path, ...asset } of assets) {
        if (options.tag && !path.tags.some(tag => tag.toLowerCase() === options.tag!.toLowerCase())) continue;
        if (query && !`${path.name} ${path.description} ${path.tags.join(' ')}`.toLowerCase().includes(query)) continue;
        matches.push({ ...asset, name: path.name, description: path.description, tags: path.tags, sampleCount: path.samples.length,
          startTime: path.samples[0]!.time, endTime: path.samples.at(-1)!.time });
      }
    }
    matches.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
    return { total: matches.length, offset: options.offset, paths: matches.slice(options.offset, options.offset + options.limit),
      nextOffset: options.offset + options.limit < matches.length ? options.offset + options.limit : null,
      coordinateSpace: 'Roblox Studio world-space studs', limitation: 'Reuse only in the same place/world coordinate frame; paths are not attached to a moving part or normalized to a rig.' };
  }
}
