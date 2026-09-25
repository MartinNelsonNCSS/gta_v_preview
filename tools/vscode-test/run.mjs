// Runs tools/vscode-test/suite.ts inside a real VS Code. Usage:
//   node tools/vscode-test/run.mjs <workspace-folder> [vscode-executable]
import { runTests } from '@vscode/test-electron';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import * as esbuild from 'esbuild';

const repo = resolve(new URL('../..', import.meta.url).pathname);
const workspace = resolve(process.argv[2]);
const executable = process.argv[3];
await esbuild.build({ entryPoints: [join(repo, 'tools/vscode-test/suite.ts')], outfile: join(repo, 'out/vscode-suite.js'), bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], logLevel: 'warning' });
const out = join(mkdtempSync(join(tmpdir(), 'gta-test-')), 'results.json');
const userData = mkdtempSync(join(tmpdir(), 'gta-user-'));
await runTests({
  vscodeExecutablePath: executable,
  extensionDevelopmentPath: repo,
  extensionTestsPath: join(repo, 'out/vscode-suite.js'),
  launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', `--user-data-dir=${userData}`, '--skip-welcome', '--skip-release-notes'],
  extensionTestsEnv: { GTA_TEST_OUT: out },
});
const results = JSON.parse(readFileSync(out, 'utf8'));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n      ${r.detail}` : ''}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
