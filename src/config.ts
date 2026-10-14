import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';

export const connectionSchema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/), port: z.number().int().min(1024).max(65535) }).strict();
export async function config(root: string) {
  const directory = join(root, '.local');
  const path = join(directory, 'connection.json');
  await mkdir(directory, { recursive: true });
  try { return connectionSchema.parse(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Invalid .local/connection.json. Restore it or run setup after removing that file and reinstall the paired plugin.');
  }
  const value = connectionSchema.parse({ token: randomBytes(32).toString('hex'), port: Number(process.env.MOTION_PORT ?? 7331) });
  try { await writeFile(path, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return connectionSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  }
  return value;
}
