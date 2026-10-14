import { randomUUID, timingSafeEqual } from 'node:crypto';
import { runningBuildIdentity } from './build-identity.js';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { dirname } from 'node:path';
import { z } from 'zod';
import { deterministicImportAssetId, importSourceIdentitySchema, type Library } from './library.js';
import type { PoseLibrary } from './pose-library.js';
import { listSchema, readSchema, type MotionApp } from './app.js';
import { identifier, recipeSchema } from './recipes.js';
import { captureFocusEligibleJointNames, retargetProfileSchema } from './retarget.js';

type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'expired' | 'unknown' | 'cancelled';
export interface Job { id: string; sessionId: string; operation: string; payload?: unknown; status: JobStatus; createdAt: number; deliveredAt?: number; result?: unknown; recoveredFromJournal?: boolean; lastKnownStatus?: JobStatus }
export function jobNextAction(job: Pick<Job, 'status' | 'recoveredFromJournal' | 'lastKnownStatus'>) {
  if (job.recoveredFromJournal) {
    if (job.lastKnownStatus === 'queued') return 'The command had not been delivered before restart. Check whether it is still needed, then submit a fresh job only if so.';
    if (job.lastKnownStatus === 'running' || job.lastKnownStatus === 'unknown') return 'The command may have been applied before the interruption. Reconcile the current Studio state before any retry; do not resubmit based on this status alone.';
    return 'Only terminal status survived restart; the result is unavailable. Perform a fresh read/inspection before relying on the outcome or repeating a potentially state-changing command.';
  }
  switch (job.status) {
    case 'queued':
    case 'running': return 'This job is still active. Poll this same job ID; do not submit a duplicate.';
    case 'succeeded': return 'Use the returned result and its next-step guidance; do not rerun the command just to retrieve the outcome.';
    case 'failed': return 'Review the returned error/result and inspect Studio state before deciding whether to retry; a failed command may have partially applied changes.';
    case 'expired':
    case 'cancelled': return 'This command was not delivered to Studio. Submit a fresh job only if the operation is still needed.';
    case 'unknown': return 'Studio may have applied this command but its acknowledgement is missing. Reconcile the current Studio state before any retry.';
  }
}
const journalJobSchema = z.object({ id: z.string().uuid(), sessionId: z.string().uuid(), operation: z.string().min(1).max(100),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'expired', 'unknown', 'cancelled']), createdAt: z.number().finite().nonnegative(), deliveredAt: z.number().finite().nonnegative().optional(),
  recoveredFromJournal: z.boolean().optional(), lastKnownStatus: z.enum(['queued', 'running', 'succeeded', 'failed', 'expired', 'unknown', 'cancelled']).optional() }).strict();
const journalSchema = z.object({ schemaVersion: z.literal(1), jobs: z.array(journalJobSchema).max(256) }).strict();
export class Queue {
  private sessions = new Map<string, { seenAt: number; snapshot: Record<string, unknown> }>();
  private jobs = new Map<string, Job>();
  constructor(private now = Date.now, private journalPath?: string) {
    if (!journalPath) return;
    let contents: string;
    try { contents = readFileSync(journalPath, 'utf8'); }
    catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    const journal = journalSchema.parse(JSON.parse(contents));
    if (new Set(journal.jobs.map(job => job.id)).size !== journal.jobs.length) throw new Error('Studio job journal contains duplicate job IDs; refusing ambiguous recovery.');
    for (const persisted of journal.jobs) {
      const previouslyRecovered = persisted.recoveredFromJournal === true;
      const status = previouslyRecovered ? persisted.status
        : persisted.status === 'queued' ? 'expired' : persisted.status === 'running' ? 'unknown' : persisted.status;
      this.jobs.set(persisted.id, { ...persisted, status, recoveredFromJournal: true,
        lastKnownStatus: previouslyRecovered ? persisted.lastKnownStatus ?? persisted.status : persisted.status });
    }
    this.persistJournal();
  }
  private persistJournal() {
    if (!this.journalPath) return;
    const jobs = [...this.jobs.values()].slice(-256).map(({ id, sessionId, operation, status, createdAt, deliveredAt, recoveredFromJournal, lastKnownStatus }) => ({
      id, sessionId, operation, status, createdAt, ...(deliveredAt === undefined ? {} : { deliveredAt }),
      ...(recoveredFromJournal ? { recoveredFromJournal: true, lastKnownStatus } : {}),
    }));
    const temporaryPath = `${this.journalPath}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.journalPath), { recursive: true });
      writeFileSync(temporaryPath, JSON.stringify({ schemaVersion: 1, jobs }), { flag: 'wx' });
      renameSync(temporaryPath, this.journalPath);
    } catch (error) {
      try { unlinkSync(temporaryPath); } catch { /* Temporary record may not exist. */ }
      throw error;
    }
  }
  heartbeat(id: string, snapshot: Record<string, unknown>) {
    for (const [key, s] of this.sessions) if (this.now() - s.seenAt > 300000) this.sessions.delete(key);
    if (!this.sessions.has(id) && this.sessions.size >= 16) throw new Error('Too many Studio sessions.');
    this.sessions.set(id, { seenAt: this.now(), snapshot: structuredClone(snapshot) });
  }
  listSessions() {
    const now = this.now();
    let expiredAny = false;
    return [...this.sessions].map(([id, session]) => {
      const ageMs = Math.max(0, now - session.seenAt);
      const jobs = [...this.jobs.values()].filter(job => job.sessionId === id);
      for (const job of jobs) expiredAny = this.expire(job) || expiredAny;
      const counts = { queued: 0, running: 0, unknown: 0 };
      let oldestPendingAgeMs = 0;
      for (const job of jobs) {
        if (job.status !== 'queued' && job.status !== 'running' && job.status !== 'unknown') continue;
        counts[job.status] += 1;
        oldestPendingAgeMs = Math.max(oldestPendingAgeMs, now - (job.status === 'queued' ? job.createdAt : job.deliveredAt ?? job.createdAt));
      }
      return {
        id,
        online: ageMs < 10000,
        snapshot: structuredClone(session.snapshot),
        seenAt: session.seenAt,
        seenAtIso: new Date(session.seenAt).toISOString(),
        heartbeatAgeMs: ageMs,
        jobs: { ...counts, oldestPendingAgeMs },
      };
    }).map((session, index, sessions) => {
      if (index === sessions.length - 1 && expiredAny) this.persistJournal();
      return session;
    });
  }
  listJobs(sessionId: string, limit = 20, includeTerminal = false) {
    const now = this.now();
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Unknown Studio session. Call motion_studio_sessions to find a connected session.');
    let expiredAny = false;
    const jobs = [...this.jobs.values()]
      .filter(job => job.sessionId === sessionId)
      .map(job => { expiredAny = this.expire(job) || expiredAny; return job; })
      .filter(job => includeTerminal || job.status === 'queued' || job.status === 'running' || job.status === 'unknown')
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, limit)
      .map(job => ({
        id: job.id,
        operation: job.operation,
        status: job.status,
        ageMs: Math.max(0, now - job.createdAt),
        queuedAt: job.createdAt,
        ...(job.deliveredAt === undefined ? {} : {
          deliveredAt: job.deliveredAt,
          queueWaitMs: Math.max(0, job.deliveredAt - job.createdAt),
        }),
        ...(job.status === 'running' || job.status === 'unknown'
          ? { runningForMs: Math.max(0, now - (job.deliveredAt ?? job.createdAt)) }
          : {}),
        nextAction: jobNextAction(job),
        ...(job.recoveredFromJournal ? { recoveredFromJournal: true, lastKnownStatus: job.lastKnownStatus,
          resultAvailable: job.result !== undefined } : {}),
      }));
    if (expiredAny) this.persistJournal();
    return {
      sessionId,
      online: now - session.seenAt < 10000,
      heartbeatAgeMs: Math.max(0, now - session.seenAt),
      returned: jobs.length,
      jobs,
      next: jobs.some(job => job.status === 'unknown')
        ? 'For unknown jobs, inspect Studio and check the specific job with motion_studio_job before retrying; the command may have completed without its acknowledgement.'
        : 'Use motion_studio_job with a returned ID to retrieve a terminal result. Queued or running jobs are not completed.',
    };
  }
  getInspectionProfile(sessionId: string, rigId: string, maxAgeMs = 300000) {
    const session = this.sessions.get(sessionId);
    if (!session || this.now() - session.seenAt >= 10000) throw new Error('Studio session is offline. Reconnect the plugin before using cached rig inspections.');
    const inspections = [...this.jobs.values()].reverse()
      .filter(job => job.sessionId === sessionId && job.operation === 'inspect' && job.status === 'succeeded' && this.now() - job.createdAt <= maxAgeMs)
      .sort((left, right) => right.createdAt - left.createdAt);
    for (const job of inspections) {
      if (!job.result || typeof job.result !== 'object' || Array.isArray(job.result)) continue;
      const result = job.result as Record<string, unknown>;
      if (result.id !== rigId || !result.retargetProfile) continue;
      let profile;
      try { profile = retargetProfileSchema.parse(result.retargetProfile); }
      catch { continue; }
      if (profile.rigId !== rigId || (typeof result.rigSignature === 'string' && profile.rigSignature !== result.rigSignature)) continue;
      const focusNames = captureFocusEligibleJointNames(profile, result.animatedNames);
      return { profile: structuredClone(profile), captureFocusEligibleNames: focusNames,
        inspectedAt: new Date(job.createdAt).toISOString(), ageMs: Math.max(0, this.now() - job.createdAt) };
    }
    throw new Error(`No successful inspection profile for rig ${rigId} was found in this live Studio session within the last ${Math.round(maxAgeMs / 1000)} seconds. Run motion_studio_inspect and confirm its job first.`);
  }
  enqueue(sessionId: string | undefined, operation: string, payload: unknown) {
    const online = this.listSessions().filter(s => s.online);
    if (!sessionId) {
      if (online.length !== 1) throw new Error('Connect one Studio plugin, or specify sessionId from motion_studio_sessions.');
      sessionId = online[0]!.id;
    }
    if (!online.some(s => s.id === sessionId)) throw new Error('Studio session offline. Open the paired plugin and click Connect.');
    const previousJobs = new Map(this.jobs);
    for (const [id, job] of this.jobs) if (this.now() - job.createdAt > 1800000) this.jobs.delete(id);
    if (this.jobs.size >= 256) {
      const terminalStatuses = new Set<JobStatus>(['succeeded', 'failed', 'expired', 'cancelled']);
      const terminalJobs = [...this.jobs.values()].filter(job => terminalStatuses.has(job.status)).sort((left, right) => left.createdAt - right.createdAt);
      for (const job of terminalJobs) {
        if (this.jobs.size < 256) break;
        this.jobs.delete(job.id);
      }
      if (this.jobs.size >= 256) {
        try { this.persistJournal(); } catch (error) { this.jobs = previousJobs; throw error; }
        throw new Error('Studio job queue is full of queued, running, or unknown work. Inspect and resolve outstanding jobs before submitting more commands.');
      }
    }
    const job: Job = { id: randomUUID(), sessionId, operation, payload, status: 'queued', createdAt: this.now() };
    this.jobs.set(job.id, job);
    try { this.persistJournal(); } catch (error) { this.jobs = previousJobs; throw error; }
    return { ...job };
  }
  private expire(job: Job) {
    if (job.status === 'queued' && this.now() - job.createdAt > 30000) { job.status = 'expired'; return true; }
    if (job.status === 'running' && this.now() - job.deliveredAt! > 60000) { job.status = 'unknown'; return true; }
    return false;
  }
  poll(sessionId: string) {
    let expiredAny = false;
    for (const job of this.jobs.values()) {
      expiredAny = this.expire(job) || expiredAny;
      if (job.sessionId === sessionId && job.status === 'queued') {
        job.status = 'running'; job.deliveredAt = this.now();
        try { this.persistJournal(); } catch (error) { job.status = 'queued'; delete job.deliveredAt; throw error; }
        return { ...job };
      }
    }
    if (expiredAny) this.persistJournal();
    return null;
  }
  cancelQueued(id: string) {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'queued') return false;
    job.status = 'cancelled';
    try { this.persistJournal(); } catch (error) { job.status = 'queued'; throw error; }
    return true;
  }
  complete(sessionId: string, id: string, ok: boolean, result: unknown) {
    const job = this.jobs.get(id);
    if (!job || job.sessionId !== sessionId) throw new Error('Job does not belong to this session.');
    if (job.status === 'succeeded' || job.status === 'failed') { this.persistJournal(); return; } // Lost HTTP acknowledgement can be retried.
    if (job.status !== 'running' && job.status !== 'unknown') throw new Error('Job was not delivered.');
    const previousStatus = job.status, previousResult = job.result;
    const previousRecovered = job.recoveredFromJournal, previousLastKnownStatus = job.lastKnownStatus;
    job.status = ok ? 'succeeded' : 'failed'; job.result = result;
    delete job.recoveredFromJournal; delete job.lastKnownStatus;
    try { this.persistJournal(); } catch (error) {
      job.status = previousStatus; job.result = previousResult;
      job.recoveredFromJournal = previousRecovered; job.lastKnownStatus = previousLastKnownStatus;
      throw error;
    }
  }
  get(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Unknown job ID. It is not present in the retained local Studio job journal.');
    if (this.expire(job)) this.persistJournal();
    return { ...job };
  }
  listRecoveredJobs(limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Recovered job history limit must be 1–100.');
    const jobs = [...this.jobs.values()].filter(job => job.recoveredFromJournal)
      .sort((left, right) => right.createdAt - left.createdAt).slice(0, limit)
      .map(job => ({ id: job.id, sessionId: job.sessionId, operation: job.operation, status: job.status,
        lastKnownStatus: job.lastKnownStatus ?? null, createdAt: job.createdAt, deliveredAt: job.deliveredAt ?? null,
        resultAvailable: false, nextAction: jobNextAction(job), recoveryNote: job.lastKnownStatus === 'queued'
          ? 'This command had not been delivered before restart and is expired; explicitly reissue only if still needed.'
          : job.lastKnownStatus === 'running' ? 'This command had been delivered before restart. Studio may have applied it; inspect the scene before any retry.'
            : 'Only terminal status was persisted; payload and result were intentionally omitted. Start a fresh inspection if result data is needed.' }));
    return { total: [...this.jobs.values()].filter(job => job.recoveredFromJournal).length, jobs };
  }
}

const pollSchema = z.object({ sessionId: z.string().uuid(), snapshot: z.record(z.unknown()) }).strict();
const resultSchema = z.object({ sessionId: z.string().uuid(), id: z.string().uuid(), ok: z.boolean(), result: z.unknown() }).strict();
const librarySaveSchema = z.object({ recipe: recipeSchema, parentId: identifier.optional(), sourceRigProfile: retargetProfileSchema.optional() }).strict();
const libraryImportSchema = z.object({ recipe: recipeSchema, sourceRigProfile: retargetProfileSchema, sourceIdentity: importSourceIdentitySchema }).strict();
async function body(req: IncomingMessage, limit = 512000) {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error(`Request exceeds ${limit} bytes.`);
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function startBridge(queue: Queue, token: string, port: number, options?: { library: Library; poses?: PoseLibrary; app: MotionApp; files: Record<string, { type: string; content: string }> }) {
  const server = createServer(async (req, res) => {
    const respond = (code: number, value: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      if (!/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host ?? '')) return respond(403, { error: 'Invalid local host.' });
      const localOrigin = `http://${req.headers.host}`;
      const staticFile = options?.files[req.url ?? ''];
      if (req.method === 'GET' && staticFile) {
        res.writeHead(200, { 'Content-Type': staticFile.type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" });
        res.end(staticFile.content); return;
      }
      const auth = Buffer.from(req.headers.authorization ?? '');
      if (options && req.url?.startsWith('/app-api/')) {
        const expectedApp = Buffer.from(`Bearer ${options.app.token}`);
        if ((req.headers.origin && req.headers.origin !== localOrigin) || auth.length !== expectedApp.length || !timingSafeEqual(auth, expectedApp)) return respond(403, { error: 'Open Motion Tools using npm run app to connect this browser.' });
        if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) return respond(405, { error: 'Use JSON POST.' });
        return respond(200, await options.app.handle(req.url, await body(req, req.url === '/app-api/review-image' ? 2_100_000 : 512000)));
      }
      const expected = Buffer.from(`Bearer ${token}`);
      if (options && req.url?.startsWith('/studio-api/')) {
        if (req.headers.origin || auth.length !== expected.length || !timingSafeEqual(auth, expected)) return respond(403, { error: 'Invalid Studio pairing token.' });
        if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) return respond(405, { error: 'Use JSON POST.' });
        return respond(200, await options.app.handleStudio(req.url, await body(req)));
      }
      if (req.headers.origin || !/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host ?? '') || auth.length !== expected.length || !timingSafeEqual(auth, expected)) return respond(403, { error: 'Invalid local pairing token, host, or browser origin.' });
      if (req.method === 'GET' && req.url === '/health') return respond(200, { name: 'roblox-motion', version: 1, release: '1.0.0',
        ...(runningBuildIdentity ? { buildIdentity: runningBuildIdentity } : {}), ...(options ? { app: true, animationLibrary: true, motionReview: true } : {}) });
      if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) return respond(404, { error: 'Use the Studio plugin.' });
      if (req.url === '/poll') {
        const data = pollSchema.parse(await body(req));
        queue.heartbeat(data.sessionId, data.snapshot);
        return respond(200, { command: queue.poll(data.sessionId) });
      }
      if (req.url === '/result') {
        const data = resultSchema.parse(await body(req, 4_000_000));
        queue.complete(data.sessionId, data.id, data.ok, data.result);
        return respond(200, { accepted: true });
      }
      if (options && req.url === '/library/list') {
        const { offset, limit, kind } = listSchema.parse(await body(req));
        return respond(200, await options.library.list(offset, limit, kind));
      }
      if (options && req.url === '/library/read') return respond(200, await options.library.get(readSchema.parse(await body(req)).id));
      if (options && req.url === '/library/save') {
        const data = librarySaveSchema.parse(await body(req));
        return respond(200, await options.library.save(data.recipe, data.parentId, data.sourceRigProfile));
      }
      if (options && req.url === '/library/import-save') {
        const data = libraryImportSchema.parse(await body(req));
        return respond(200, await options.library.saveImportedIdempotent(data.recipe, deterministicImportAssetId(data.sourceIdentity, data.recipe, data.sourceRigProfile), data.sourceRigProfile, data.sourceIdentity));
      }
      if (options?.poses && req.url === '/poses/list') return respond(200, await options.poses.list(await body(req)));
      if (options?.poses && req.url === '/poses/read') {
        const data = z.object({ id: identifier }).strict().parse(await body(req));
        return respond(200, await options.poses.get(data.id));
      }
      if (options?.poses && req.url === '/poses/save') return respond(200, await options.poses.save(await body(req)));
      respond(404, { error: 'Unknown endpoint.' });
    } catch (error) { respond(400, { error: error instanceof Error ? error.message : String(error) }); }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}
