import { existsSync, readFileSync } from 'fs';

/** Loads KEY=VALUE lines from `.env` (if present) into process.env; variables already set in the shell win. */
export function loadDotEnv(file = '.env'): void {
    if (!existsSync(file)) {
        return;
    }
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (!match || line.trim().startsWith('#')) {
            continue;
        }
        const [, key, raw] = match as unknown as [string, string, string];
        if (process.env[key] === undefined) {
            process.env[key] = raw.replace(/^(['"])(.*)\1$/, '$2');
        }
    }
}
