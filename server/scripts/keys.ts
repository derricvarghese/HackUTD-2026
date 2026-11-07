import fs from 'node:fs';
import { generateKeyPair } from '../src/crypto/keys';

// usage: npm run keys            -> prints env lines
//        npm run keys -- --write -> appends them to .env (refuses if keys already present)
const enc = generateKeyPair();
const sign = generateKeyPair();
const lines = [
  `BACKEND_ENC_PRIVATE_KEY=${enc.privateKey}`,
  `BACKEND_SIGN_PRIVATE_KEY=${sign.privateKey}`,
];
if (process.argv.includes('--write')) {
  const cur = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';
  if (/^BACKEND_(ENC|SIGN)_PRIVATE_KEY=.+/m.test(cur)) {
    console.error('.env already contains backend keys; not overwriting (rotating keys breaks phones that cached the old public key).');
    process.exit(1);
  }
  fs.writeFileSync('.env', cur.replace(/^BACKEND_(ENC|SIGN)_PRIVATE_KEY=.*\n?/gm, '') + (cur && !cur.endsWith('\n') ? '\n' : '') + lines.join('\n') + '\n');
  console.log('wrote keys to .env');
} else {
  console.log(lines.join('\n'));
}
console.log(`\n# Public halves (served by GET /v1/server-info):`);
console.log(`encryption_public_key=${enc.publicKey}`);
console.log(`signing_public_key=${sign.publicKey}`);
