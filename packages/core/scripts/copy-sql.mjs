// Post-build: copy src/db/migrations/*.sql into dist/db/migrations/
// tsc doesn't emit non-TS files, so the runner's readFileSync would fail
// without this.
import { cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src/db/migrations');
const dst = join(root, 'dist/db/migrations');
cpSync(src, dst, { recursive: true });
