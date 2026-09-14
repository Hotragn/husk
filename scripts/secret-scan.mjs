#!/usr/bin/env node
/**
 * Look for credentials in the working tree and in every commit.
 *
 * History matters more than the working tree. Deleting a key and committing the
 * deletion leaves the key in the object store forever, and a repo that has ever
 * been pushed with one has leaked it -- so `git log -p` is scanned too, not
 * just what is on disk right now.
 *
 * Deliberately noisy-but-triaged rather than clever: every match is printed
 * with its file and line, and matches that sit in a test fixture or a
 * documentation example are marked rather than hidden, because "it's just a
 * test" is exactly what someone says about the one that was real.
 *
 * Read-only. Exits non-zero if anything unexplained is found.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const git = (args, opts = {}) => run('git', args, { cwd: root, maxBuffer: 256 * 1024 * 1024, ...opts });

/**
 * Patterns worth stopping the world for.
 *
 * Each is anchored on a provider's own documented prefix where one exists,
 * because a generic "40 hex characters" rule matches every git SHA in the repo
 * and trains you to ignore the output.
 */
const RULES = [
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'AWS secret key', re: /\baws_secret_access_key\s*[=:]\s*["']?[A-Za-z0-9/+=]{40}["']?/gi },
  { name: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  // `sk-ant-` is excluded: Anthropic's prefix belongs to the rule above.
  // Without this, every Anthropic key was reported a second time as an
  // OpenAI one -- which is how a scanner teaches you to skim its output.
  { name: 'OpenAI key', re: /sk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'Stripe key', re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { name: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: 'Fly.io token', re: /\bfo1_[A-Za-z0-9_-]{20,}/g },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'generic assigned secret', re: /\b(?:api[_-]?key|secret|passwd|password|token)\s*[:=]\s*["'][^"'\s${}]{16,}["']/gi },
  { name: 'connection string with password', re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/]+:[^@\s]{4,}@/gi },
];

/**
 * Strings that look like secrets and are not.
 *
 * Kept explicit and short. Anything added here is a decision to never be told
 * about that value again, which is worth making deliberately.
 */
const KNOWN_SAFE = [
  /sk-ant-SUPERSECRETVALUE/,           // audit-log redaction test
  /sk-ant-api03-REALLOOKINGSECRETVALUE/, // audit-log redaction test
  /\bsk-ant-xxx/i,                      // docs placeholder
  /YOUR_[A-Z_]*KEY/,                    // docs placeholder
  /<your[- ]?[a-z-]*key>/i,             // docs placeholder
  /example\.com/,                       // docs
  /\bxxx+\b/i,
];

const isSafe = (text) => KNOWN_SAFE.some((re) => re.test(text));
const isTestOrDoc = (path) =>
  /\.(test|spec)\.[tj]sx?$/.test(path) || /(^|\/)(docs|examples|__fixtures__)\//.test(path) || /\.mdx?$/.test(path);

let real = 0;
let explained = 0;
let fixtures = 0;

function report(where, line, rule, sample, context) {
  const excerpt = sample.length > 60 ? `${sample.slice(0, 60)}…` : sample;
  if (isSafe(sample)) {
    explained++;
    console.log(`  ok   ${where}${line ? `:${line}` : ''}  ${rule} -- placeholder/fixture: ${excerpt}`);
    return;
  }
  // A credential-redaction library has to contain credential-shaped strings to
  // test against. Those are shown, counted separately, and do not block -- but
  // they are never silently dropped, because "it is only a test" is exactly
  // what gets said about the one that turns out to be real.
  if (context === 'test') {
    fixtures++;
    console.log(`  test ${where}${line ? `:${line}` : ''}  ${rule} -- fixture: ${excerpt}`);
    return;
  }
  real++;
  const label = context === 'history' ? 'IN HISTORY' : 'LEAK';
  console.log(`  ${label} ${where}${line ? `:${line}` : ''}  ${rule}: ${excerpt}`);
}

// -------------------------------------------------------------- working tree
console.log('\nsecret scan\n\ntracked files');
const { stdout: listed } = await git(['ls-files', '-z']);
const files = listed.split('\0').filter(Boolean);
let scanned = 0;

for (const file of files) {
  let text;
  try {
    text = await readFile(new URL(file, `file://${root.replace(/\\/g, '/')}`), 'utf8');
  } catch {
    continue; // binary or unreadable: nothing a regex would find anyway
  }
  if (text.includes('\0')) continue;
  scanned++;

  const lines = text.split('\n');
  for (const rule of RULES) {
    for (let i = 0; i < lines.length; i++) {
      const found = lines[i].match(rule.re);
      if (!found) continue;
      for (const hit of found) report(file, i + 1, rule.name, hit, isTestOrDoc(file) ? 'test' : 'src');
    }
  }
}
console.log(`  ${scanned} text files scanned, ${files.length - scanned} binary/skipped`);

// ------------------------------------------------------------------- history
console.log('\ngit history (every commit, including deleted content)');
const { stdout: log } = await git(['log', '-p', '--all', '--no-color', '--unified=0']);
const commits = log.split(/^commit /m).filter(Boolean);
console.log(`  ${commits.length} commits`);

for (const commit of commits) {
  const sha = commit.slice(0, 12);
  const lines = commit.split('\n');

  for (const rule of RULES) {
    const found = commit.match(rule.re);
    if (!found) continue;

    for (const hit of new Set(found)) {
      // Only lines that were *added* count. A deletion contains the same string
      // and would report every secret twice: once arriving, once leaving.
      const at = lines.findIndex((l) => l.startsWith('+') && l.includes(hit));
      if (at === -1) continue;

      // Which file did it land in? The nearest `+++ b/path` above the hit.
      let path = '';
      for (let i = at; i >= 0; i--) {
        if (lines[i].startsWith('+++ b/')) {
          path = lines[i].slice(6);
          break;
        }
      }
      report(`commit ${sha} ${path}`.trim(), 0, rule.name, hit, isTestOrDoc(path) ? 'test' : 'history');
    }
  }
}

// ------------------------------------------------------------------- summary
console.log('');
if (real > 0) {
  console.log(`${real} finding${real === 1 ? '' : 's'} needing a decision (${fixtures} test fixture${fixtures === 1 ? '' : 's'} and ${explained} placeholder${explained === 1 ? '' : 's'} accounted for).
`);
  process.exit(1);
}
console.log(`clean: no credential outside a test or a doc. ${fixtures} test fixture${fixtures === 1 ? '' : 's'} and ${explained} placeholder${explained === 1 ? '' : 's'} matched, all accounted for.
`);
