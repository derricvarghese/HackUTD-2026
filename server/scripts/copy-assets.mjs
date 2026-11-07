// Copies non-TS runtime assets (SQL migrations, the OpenAPI contract) into dist/.
import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/db', { recursive: true });
cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
cpSync('../openapi.yaml', 'dist/openapi.yaml');
