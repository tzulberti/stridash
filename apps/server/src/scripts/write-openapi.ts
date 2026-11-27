/**
 * Write docs/openapi.json from the shared OpenAPI source. Run:
 *   npm run openapi:generate -w @stridash/server
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openapiDocument } from '../openapi.js';

const target = fileURLToPath(new URL('../../../../docs/openapi.json', import.meta.url));
const version = process.env.STRIDASH_VERSION ?? '0.1.0-dev';
await writeFile(target, `${JSON.stringify(openapiDocument(version), null, 2)}\n`, 'utf8');
console.log(`Wrote ${target}`);
