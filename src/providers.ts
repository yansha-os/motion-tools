import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const providerId = z.enum(['claude', 'deepseek', 'glm']);
type ProviderId = z.infer<typeof providerId>;
export const providers = {
  claude: { name: 'Claude', model: 'claude-sonnet-5', url: 'https://api.anthropic.com/v1/messages', keysUrl: 'https://platform.claude.com/settings/keys', env: 'ANTHROPIC_API_KEY' },
  deepseek: { name: 'DeepSeek', model: 'deepseek-v4-flash', url: 'https://api.deepseek.com/chat/completions', keysUrl: 'https://platform.deepseek.com/api_keys', env: 'DEEPSEEK_API_KEY' },
  glm: { name: 'GLM (Z.ai)', model: 'glm-5.3', url: 'https://api.z.ai/api/paas/v4/chat/completions', keysUrl: 'https://z.ai/manage-apikey/apikey-list', env: 'ZAI_API_KEY' },
} as const;
export const modelId = z.string().trim().min(1).max(160).regex(/^[a-zA-Z0-9._:/-]+$/);
export const connectionSchema = z.object({
  provider: providerId, model: modelId, apiKey: z.string().trim().min(8).max(2048).regex(/^[\x21-\x7e]+$/).optional(),
  workspace: z.string().max(100).regex(/^[a-zA-Z0-9_-]*$/).default(''), remember: z.boolean().default(false),
}).strict();
type Connection = { model: string; workspace: string; encryptedKey?: string };
export type Credential = { provider: ProviderId; model: string; workspace: string; apiKey: string };
export interface SecretCodec { protect(value: string): Promise<string>; unprotect(value: string): Promise<string> }

// DPAPI binds remembered keys to this Windows user. Secrets travel over stdin, never command arguments.
export class WindowsSecrets implements SecretCodec {
  private transform(value: string, decode: boolean): Promise<string> {
    if (process.platform !== 'win32') throw new Error('Remembered keys require Windows. Use a session key or an environment variable on this OS.');
    const script = `Add-Type -AssemblyName System.Security
$value = [Console]::In.ReadToEnd()
$bytes = ${decode ? '[Convert]::FromBase64String($value)' : '[Text.Encoding]::UTF8.GetBytes($value)'}
$result = [Security.Cryptography.ProtectedData]::${decode ? 'Unprotect' : 'Protect'}($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write(${decode ? '[Text.Encoding]::UTF8.GetString($result)' : '[Convert]::ToBase64String($result)'})`;
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => child.kill(), 10000);
      child.stdout.on('data', chunk => chunks.push(chunk));
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.on('error', () => { clearTimeout(timer); reject(new Error('Could not access Windows key storage.')); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(new Error('Could not unlock the saved API key. Reconnect with a new key.')); });
      child.stdin.end(value);
    });
  }
  protect(value: string) { return this.transform(value, false); }
  unprotect(value: string) { return this.transform(value, true); }
}

export class Connections {
  private sessions = new Map<ProviderId, string>();
  private pending = Promise.resolve();
  constructor(private path: string, private codec: SecretCodec = new WindowsSecrets(), private env: NodeJS.ProcessEnv = process.env) {}
  private async read(): Promise<Partial<Record<ProviderId, Connection>>> {
    try { return z.record(providerId, z.object({ model: modelId, workspace: z.string(), encryptedKey: z.string().optional() }).strict()).parse(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new Error('Could not read provider settings.'); }
  }
  private mutate(action: (settings: Partial<Record<ProviderId, Connection>>) => Promise<(() => void) | void>) {
    const operation = this.pending.then(async () => {
      const settings = await this.read();
      const committed = await action(settings);
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(settings, null, 2), { mode: 0o600, flag: 'wx' });
      await rename(temp, this.path);
      committed?.();
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async list() {
    await this.pending;
    const settings = await this.read();
    return Object.entries(providers).map(([id, defaults]) => {
      const provider = id as ProviderId, saved = settings[provider];
      const source = saved?.encryptedKey ? 'remembered' : this.sessions.has(provider) ? 'session' : this.env[defaults.env] ? 'environment' : 'none';
      return { id, name: defaults.name, model: saved?.model ?? defaults.model, workspace: saved?.workspace ?? '', keysUrl: defaults.keysUrl, source, connected: source !== 'none', canRemember: process.platform === 'win32' };
    });
  }
  async save(input: unknown) {
    const data = connectionSchema.parse(input);
    await this.mutate(async settings => {
      const old = settings[data.provider];
      const key = data.apiKey ?? this.sessions.get(data.provider) ?? (old?.encryptedKey ? await this.codec.unprotect(old.encryptedKey) : this.env[providers[data.provider].env]);
      if (!key) throw new Error('Enter an API key before connecting.');
      const encryptedKey = data.remember ? await this.codec.protect(key) : undefined;
      settings[data.provider] = { model: data.model, workspace: data.workspace, ...(encryptedKey ? { encryptedKey } : {}) };
      return () => { this.sessions.set(data.provider, key); };
    });
    return { saved: true };
  }
  async remove(id: ProviderId) {
    await this.mutate(async settings => { delete settings[id]; return () => { this.sessions.delete(id); }; });
    return { removed: true, environmentStillConfigured: Boolean(this.env[providers[id].env]) };
  }
  async credential(id: ProviderId): Promise<Credential> {
    await this.pending;
    const saved = (await this.read())[id];
    const key = this.sessions.get(id) ?? (saved?.encryptedKey ? await this.codec.unprotect(saved.encryptedKey) : this.env[providers[id].env]);
    if (!key) throw new Error('Connect this provider with an API key first.');
    return { provider: id, model: saved?.model ?? providers[id].model, workspace: saved?.workspace ?? '', apiKey: key };
  }
}

export type Completion = { text: string; usage: { inputTokens: number; outputTokens: number } };
export type ProviderImage = { base64: string; mimeType: 'image/png' };
export type Complete = (credential: Credential, system: string, prompt: string, maxTokens: number, signal: AbortSignal, images?: ProviderImage[]) => Promise<Completion>;
const usageSchema = z.object({ input_tokens: z.number().optional(), output_tokens: z.number().optional(), prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() }).passthrough();
const claudeResponseSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).optional(),
  stop_reason: z.string().nullable().optional(),
  usage: usageSchema.optional(),
}).passthrough();
const compatibleResponseSchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.string().nullable().optional(),
    message: z.object({ content: z.string().nullable().optional() }).passthrough().optional(),
  }).passthrough()).optional(),
  usage: usageSchema.optional(),
}).passthrough();

export function providerClient(fetcher: typeof fetch = fetch): Complete {
  return async (credential, system, prompt, maxTokens, signal, images = []) => {
    const { provider, model, apiKey, workspace } = credential;
    const claude = provider === 'claude';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (claude) {
      headers['x-api-key'] = apiKey; headers['anthropic-version'] = '2023-06-01';
      if (workspace) headers['anthropic-workspace-id'] = workspace;
    } else headers.Authorization = `Bearer ${apiKey}`;
    let response: Response;
    try {
      response = await fetcher(providers[provider].url, {
        method: 'POST', headers, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
        body: JSON.stringify({ model, max_tokens: maxTokens, stream: false,
          ...(claude ? { system, messages: [{ role: 'user', content: images.length ? [...images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.base64 } })), { type: 'text', text: prompt }] : prompt }] } : {
            messages: [{ role: 'system', content: system }, { role: 'user', content: images.length ? [{ type: 'text', text: prompt }, ...images.map(image => ({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}` } }))] : prompt }],
            thinking: { type: 'disabled' }, response_format: { type: 'json_object' },
          }),
        }),
      });
    } catch { throw new Error(signal.aborted ? 'Generation cancelled.' : 'Provider request failed or timed out. Check your connection and try again.'); }
    if (!response.ok) {
      await response.body?.cancel();
      const help = response.status === 401 || response.status === 403 ? 'Check the API key and account permissions.' : response.status === 429 ? 'Check your provider balance or rate limit.' : response.status === 400 || response.status === 404 ? 'Check the model ID, token limit, and optional Claude workspace ID.' : 'Try again later.';
      throw new Error(`${providers[provider].name} returned HTTP ${response.status}. ${help}`);
    }
    // Do not log provider bodies: they can echo prompt content or credentials.
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Provider returned an empty response.');
    const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.length;
      if (bytes > 2_000_000) { await reader.cancel(); throw new Error('Provider response exceeded 2 MB. Request a shorter draft.'); }
      chunks.push(next.value);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Provider returned invalid JSON.'); }
    let text: string | null | undefined;
    let truncated = false;
    let inputTokens: unknown;
    let outputTokens: unknown;
    if (claude) {
      const payloadShape = claudeResponseSchema.safeParse(parsed);
      if (!payloadShape.success) throw new Error('Provider returned an unexpected response shape. Check the model ID and try again.');
      const data = payloadShape.data;
      truncated = data.stop_reason === 'max_tokens';
      text = data.content?.filter(block => block.type === 'text').flatMap(block => block.text === undefined ? [] : [block.text]).join('\n');
      inputTokens = data.usage?.input_tokens;
      outputTokens = data.usage?.output_tokens;
    } else {
      const payloadShape = compatibleResponseSchema.safeParse(parsed);
      if (!payloadShape.success) throw new Error('Provider returned an unexpected response shape. Check the model ID and try again.');
      const data = payloadShape.data;
      truncated = data.choices?.[0]?.finish_reason === 'length';
      text = data.choices?.[0]?.message?.content;
      inputTokens = data.usage?.prompt_tokens;
      outputTokens = data.usage?.completion_tokens;
    }
    if (truncated) throw new Error('Draft reached the output token limit. Increase the limit or request a shorter animation.');
    if (typeof text !== 'string' || !text.trim()) throw new Error('Provider returned no draft text.');
    const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
    return { text, usage: { inputTokens: count(inputTokens), outputTokens: count(outputTokens) } };
  };
}
