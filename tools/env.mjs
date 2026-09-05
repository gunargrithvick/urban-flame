/*
 * tools/env.mjs - a .env reader, shared by the tools that need one.
 *
 * Not dotenv: this understands exactly what .env.example contains, which is
 * KEY=value one per line with # for comments, and it never overwrites a
 * variable the environment already set. Vercel injects real environment
 * variables, so this file only matters on a developer's machine.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadEnvFile(repoRoot, name) {
  const file = resolve(repoRoot, name || '.env');
  if (!existsSync(file)) return false;

  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }

  return true;
}
