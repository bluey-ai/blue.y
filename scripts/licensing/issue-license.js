#!/usr/bin/env node
// BlueOnion internal — NEVER commit private keys to git.
// Usage: node scripts/licensing/issue-license.js <command> [options]
//
// Commands:
//   setup    Generate RSA-2048 keypair + auto-patch src/admin/license.ts
//   issue    Sign and print a license JWT
//   verify   Verify an existing license JWT
//
// Private key precedence (for 'issue'):
//   1. BLUEY_LICENSE_PRIVATE_KEY env var (PEM, \n-escaped — good for CI/1Password)
//   2. scripts/licensing/bluey-license-private.pem file

'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// jsonwebtoken is a project dependency — require from project root
const jwt = require(path.join(__dirname, '../../node_modules/jsonwebtoken'));

const PRIVATE_KEY_FILE = path.join(__dirname, 'bluey-license-private.pem');
const PUBLIC_KEY_FILE  = path.join(__dirname, 'bluey-license-public.pem');
const LICENSE_TS       = path.join(__dirname, '../../src/admin/license.ts');

const VALID_PLANS = ['community', 'premium', 'enterprise'];

// ── helpers ───────────────────────────────────────────────────────────────────

function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const m = args[i].match(/^--([^=]+)(?:=(.+))?$/);
    if (m) result[m[1]] = m[2] !== undefined ? m[2] : (args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true);
  }
  return result;
}

function loadPrivateKey() {
  const fromEnv = process.env.BLUEY_LICENSE_PRIVATE_KEY;
  if (fromEnv) return fromEnv.replace(/\\n/g, '\n');
  if (fs.existsSync(PRIVATE_KEY_FILE)) return fs.readFileSync(PRIVATE_KEY_FILE, 'utf8');
  console.error(
    'Error: no private key found.\n' +
    '  Option 1: run setup first to generate one locally\n' +
    '  Option 2: set BLUEY_LICENSE_PRIVATE_KEY env var (PEM with \\n-escaped newlines)'
  );
  process.exit(1);
}

function loadPublicKey() {
  if (fs.existsSync(PUBLIC_KEY_FILE)) return fs.readFileSync(PUBLIC_KEY_FILE, 'utf8');
  // Fall back: extract embedded key from license.ts
  const src = fs.readFileSync(LICENSE_TS, 'utf8');
  const m   = src.match(/`(-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----)`/);
  if (m) return m[1];
  console.error('Error: public key not found. Run setup first.');
  process.exit(1);
}

// ── setup ─────────────────────────────────────────────────────────────────────

function cmdSetup() {
  if (fs.existsSync(PRIVATE_KEY_FILE)) {
    console.error(
      `Private key already exists at ${PRIVATE_KEY_FILE}\n` +
      'Delete it manually if you need to regenerate (this is destructive!).'
    );
    process.exit(1);
  }

  console.log('Generating RSA-2048 keypair…');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength:      2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  fs.writeFileSync(PRIVATE_KEY_FILE, privateKey, { mode: 0o600 });
  fs.writeFileSync(PUBLIC_KEY_FILE,  publicKey);
  console.log(`  Private key → ${PRIVATE_KEY_FILE}  (keep secret — back up to 1Password)`);
  console.log(`  Public key  → ${PUBLIC_KEY_FILE}`);

  // Patch the embedded public key in license.ts
  let src = fs.readFileSync(LICENSE_TS, 'utf8');
  const keyBlock = publicKey.trim();
  const patched = src.replace(
    /const LICENSE_PUBLIC_KEY = process\.env\.LICENSE_PUBLIC_KEY \?\? `[\s\S]*?`;/,
    `const LICENSE_PUBLIC_KEY = process.env.LICENSE_PUBLIC_KEY ?? \`${keyBlock}\`;`,
  );
  if (patched === src) {
    console.error('\nWarning: could not auto-patch license.ts — pattern not found. Paste the public key manually.');
  } else {
    fs.writeFileSync(LICENSE_TS, patched, 'utf8');
    console.log(`\n  Patched public key into ${LICENSE_TS}`);
  }

  console.log('\nNext steps:');
  console.log('  1. git add src/admin/license.ts');
  console.log('     git commit -m "feat(BLY-61): embed license public key"');
  console.log('  2. Copy bluey-license-private.pem to 1Password / private S3 NOW');
  console.log('  3. Delete bluey-license-private.pem from this machine after backing up');
  console.log('  4. On CI/production: set BLUEY_LICENSE_PRIVATE_KEY env var from 1Password\n');
}

// ── issue ─────────────────────────────────────────────────────────────────────

function cmdIssue(args) {
  const opts     = parseArgs(args);
  const customer = opts.customer;
  const plan     = opts.plan    ?? 'premium';
  const seats    = parseInt(opts.seats ?? '25', 10);
  const expires  = opts.expires; // ISO date string or omit for perpetual

  if (!customer)                      { console.error('Error: --customer is required (email or org ID)'); process.exit(1); }
  if (!VALID_PLANS.includes(plan))    { console.error(`Error: --plan must be one of: ${VALID_PLANS.join(', ')}`); process.exit(1); }
  if (isNaN(seats) || seats < 1)     { console.error('Error: --seats must be a positive integer'); process.exit(1); }
  if (seats > 10000)                  { console.error('Error: --seats seems too high (>10000) — double-check'); process.exit(1); }
  if (expires && isNaN(Date.parse(expires))) {
    console.error('Error: --expires must be a valid ISO date (e.g. 2027-03-16)'); process.exit(1);
  }
  if (expires && new Date(expires) < new Date()) {
    console.error('Error: --expires is in the past'); process.exit(1);
  }

  const privateKey = loadPrivateKey();

  const payload = {
    iss:      'bluey-license',
    plan,
    seats,
    customer,
    ...(expires ? { expires } : {}),
  };

  const token = jwt.sign(payload, privateKey, { algorithm: 'RS256' });

  const line = '─'.repeat(50);
  console.log(`\n${line}`);
  console.log('  BLUE.Y License Key');
  console.log(line);
  console.log(`  Customer  : ${customer}`);
  console.log(`  Plan      : ${plan}`);
  console.log(`  Seats     : ${seats}`);
  console.log(`  Expires   : ${expires ?? 'perpetual'}`);
  console.log(line);
  console.log('\n' + token + '\n');
  console.log('Deliver via:');
  console.log(`  kubectl create secret generic blue-y-secrets --from-literal=ADMIN_LICENSE_KEY="${token}" ...`);
  console.log('  (or add ADMIN_LICENSE_KEY to the existing secret)\n');
}

// ── verify ────────────────────────────────────────────────────────────────────

function cmdVerify(args) {
  const [token] = args;
  if (!token) { console.error('Usage: issue-license.js verify <token>'); process.exit(1); }

  const publicKey = loadPublicKey();
  try {
    const payload = jwt.verify(token, publicKey, { algorithms: ['RS256'] });
    const expired = payload.expires && new Date(payload.expires) < new Date();
    console.log('\n' + (expired ? '⚠️  Expired license (still cryptographically valid):' : '✅ Valid license:'));
    console.log(JSON.stringify(payload, null, 2) + '\n');
    if (expired) process.exit(1);
  } catch (e) {
    console.error('\n❌ Invalid license:', e.message, '\n');
    process.exit(1);
  }
}

// ── dispatch ──────────────────────────────────────────────────────────────────

const [,, cmd, ...rest] = process.argv;

switch (cmd) {
  case 'setup':  cmdSetup();        break;
  case 'issue':  cmdIssue(rest);    break;
  case 'verify': cmdVerify(rest);   break;
  default:
    console.log(`
BLUE.Y License Issuer — BlueOnion internal tool

Commands:
  setup
      Generate RSA-2048 keypair and auto-patch src/admin/license.ts.
      Run once. Back up private key to 1Password immediately.

  issue --customer <email|orgId> --plan <plan> --seats <n> [--expires <YYYY-MM-DD>]
      Sign and print a new license JWT. Omit --expires for a perpetual license.
      Plans: community | premium | enterprise
      Private key: BLUEY_LICENSE_PRIVATE_KEY env var, or local .pem file.

  verify <token>
      Verify a license JWT against the embedded public key.

Examples:
  node scripts/licensing/issue-license.js setup

  node scripts/licensing/issue-license.js issue \\
    --customer acme@example.com --plan premium --seats 50 --expires 2027-03-16

  node scripts/licensing/issue-license.js issue \\
    --customer internal --plan enterprise --seats 999

  node scripts/licensing/issue-license.js verify eyJhbGci...
`);
}
