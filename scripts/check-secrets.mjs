import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Report locations only. Never echo matched credential values into logs.
const rules = [
  ['GitHub credential', /(?:github_pat_[A-Za-z0-9_]{40,}|gh[pousr]_[A-Za-z0-9]{30,})/g],
  ['OpenAI API key', /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}/g],
  ['Google API key', /AIza[A-Za-z0-9_-]{30,}/g],
  ['AWS access key', /(?:AKIA|ASIA)[A-Z0-9]{16}/g],
  ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['Credential in URL', /https?:\/\/[^\s/@:]+:[^\s/@]+@/g],
];
const files = [...new Set(execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean))];
const findings = new Set();
for (const path of files) {
  const versions = [];
  try { versions.push(['working tree', readFileSync(path).toString('utf8')]); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    versions.push(['Git index', execFileSync('git', ['show', `:${path}`], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })]);
  } catch (error) {
    // A staged deletion has no index blob. Do not hide unrelated git errors.
    const tracked = execFileSync('git', ['ls-files', '--stage', '--', path], { encoding: 'utf8' });
    if (tracked.trim()) throw error;
  }
  for (const [version, text] of versions) {
    for (const [kind, pattern] of rules) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const line = text.slice(0, match.index).split('\n').length;
        const finding = `${path}:${line}: ${kind}`;
        if (findings.has(finding)) continue;
        findings.add(finding);
        console.error(`${finding} (${version})`);
      }
    }
  }
}
const failures = findings.size;
if (failures) {
  console.error(`Credential scan failed: ${failures} finding(s). No matched values were logged.`);
  process.exitCode = 1;
} else {
  console.log(`Credential scan passed: ${files.length} tracked/staged files; no recognized credential patterns.`);
}
