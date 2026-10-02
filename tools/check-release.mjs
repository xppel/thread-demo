import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import ts from 'typescript';

const publicationFiles = [
  ".gitattributes",
  ".github/workflows/pages.yml",
  ".gitignore",
  "README.md",
  "index.html",
  "package-lock.json",
  "package.json",
  "playwright.config.ts",
  "public/THIRD-PARTY-NOTICES.txt",
  "public/favicon.png",
  "public/favicon.svg",
  "src/App.tsx",
  "src/appearance/settings.test.ts",
  "src/appearance/settings.ts",
  "src/appearance/theme.ts",
  "src/audio/chordAudition.test.ts",
  "src/audio/chordAudition.ts",
  "src/audio/effect.test.ts",
  "src/audio/effect.ts",
  "src/audio/patches.ts",
  "src/audio/performanceAudio.test.ts",
  "src/audio/performanceAudio.ts",
  "src/audio/textureCompensation.ts",
  "src/audio/wav.test.ts",
  "src/audio/wav.ts",
  "src/components/ChordBank.tsx",
  "src/components/ColorPicker.tsx",
  "src/components/Controls.tsx",
  "src/components/Help.tsx",
  "src/components/Icons.tsx",
  "src/components/SoundControls.tsx",
  "src/components/Tape.tsx",
  "src/components/Wordmark.tsx",
  "src/components/accentPulse.ts",
  "src/hooks/usePerformance.ts",
  "src/main.tsx",
  "src/midi/tapeFile.test.ts",
  "src/midi/tapeFile.ts",
  "src/music/arpeggiator.test.ts",
  "src/music/arpeggiator.ts",
  "src/music/chordControls.test.ts",
  "src/music/chordControls.ts",
  "src/music/loop.test.ts",
  "src/music/loop.ts",
  "src/music/performanceSequence.test.ts",
  "src/music/performanceSequence.ts",
  "src/music/performanceTypes.ts",
  "src/music/randomize.ts",
  "src/music/scale.ts",
  "src/music/types.ts",
  "src/state/session.test.ts",
  "src/state/session.ts",
  "src/style.css",
  "tests/audio-events.spec.ts",
  "tests/audio-lifecycle.spec.ts",
  "tests/audioProbe.ts",
  "tests/instrument.spec.ts",
  "tests/ownership.spec.ts",
  "tests/polish.spec.ts",
  "tools/check-release.mjs",
  "tsconfig.json",
  "vite.config.ts"
];
const root = resolve(process.argv.find((arg, index) => index > 1 && !arg.startsWith('--')) ?? '.');
const sourceMode = process.argv.includes('--source');
const allowed = new Set(publicationFiles);
const generated = new Set(['.git', 'node_modules', 'dist', 'test-results', 'playwright-report']);
const errors = [];
function scan(directory = '') {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    if (!directory && (generated.has(entry.name) || entry.name.endsWith('.tsbuildinfo'))) continue;
    if (sourceMode && !directory && !['src', 'tests', 'tools', 'public', '.github'].includes(entry.name) && !allowed.has(path)) continue;
    if (sourceMode && directory === 'tools' && !allowed.has(path)) continue;
    if (entry.isSymbolicLink()) { errors.push(`Symlink: ${path}`); continue; }
    if (entry.isDirectory()) { scan(path); continue; }
    if (!allowed.has(path)) errors.push(`Unexpected publication file: ${path}`);
  }
}
scan();
const sources = new Map();
for (const file of publicationFiles) {
  if (!existsSync(join(root, file))) { errors.push(`Missing file: ${file}`); continue; }
  const bytes = readFileSync(join(root, file));
  if (file.endsWith('.png')) {
    if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) errors.push(`Invalid PNG: ${file}`);
    continue;
  }
  const text = bytes.toString('utf8'); sources.set(file, text);
  if (/\/Users\/[A-Za-z0-9_-]+\//.test(text) || /\/private\/tmp\/[A-Za-z0-9_-]+/.test(text)) errors.push(`Local path in ${file}`);
  if (/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}/.test(text)) errors.push(`Credential pattern in ${file}`);
}
// Only imports reachable from the app can retain production modules.
const reached = new Set();
function visit(file) {
  if (reached.has(file)) return;
  reached.add(file);
  const text = sources.get(file); if (!text || file.endsWith('.css')) return;
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  function dependency(name) {
    if (!name.startsWith('.')) return;
    const base = join(dirname(file), name);
    const target = [base, `${base}.ts`, `${base}.tsx`, `${base}.css`].find(candidate => sources.has(candidate));
    if (!target) errors.push(`Unlisted import: ${file} -> ${name}`); else visit(target);
  }
  function walk(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) dependency(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) dependency(node.arguments[0].text);
    ts.forEachChild(node, walk);
  }
  walk(ast);
}
visit('src/main.tsx');
for (const file of publicationFiles) if (file.startsWith('src/') && !file.endsWith('.test.ts') && !reached.has(file)) errors.push(`Unused production module: ${file}`);
for (const file of ['vite.config.ts', 'playwright.config.ts']) if (!sources.get(file)?.includes('/thread-demo/')) errors.push(`Wrong Pages base: ${file}`);
if (!sources.get('vite.config.ts')?.includes('sourcemap: false')) errors.push('Production source maps must be disabled.');
const workflow = sources.get('.github/workflows/pages.yml') ?? '';
if (!workflow.includes('install --with-deps chromium webkit')) errors.push('CI must install both browsers.');
if ((workflow.match(/if: github.event_name == 'workflow_dispatch'/g) ?? []).length !== 2) errors.push('Upload and deployment must require manual dispatch.');
const schema = sources.get('src/music/performanceTypes.ts') ?? '';
const sessionAst = ts.createSourceFile('schema.ts', schema, ts.ScriptTarget.Latest, true);
const sessionType = sessionAst.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'Session');
const sessionFields = ['version', 'voice', 'key', 'scale', 'keyLocked', 'bank', 'padCount', 'loop', 'quantize', 'countIn', 'bass', 'arp', 'sound'];
if (!sessionType || sessionType.members.length !== sessionFields.length || sessionType.members.some(member => !sessionFields.includes(member.name?.getText(sessionAst)))) errors.push('Unexpected session schema.');
if (!existsSync(join(root, 'dist/index.html'))) errors.push('Build before auditing.');
else {
  const html = readFileSync(join(root, 'dist/index.html'), 'utf8');
  if (!html.includes('/thread-demo/assets/')) errors.push('Built assets use the wrong base.');
  for (const icon of ['favicon.svg', 'favicon.png']) {
    if (!html.includes(`/thread-demo/${icon}`) || !existsSync(join(root, 'dist', icon))) errors.push(`Missing deployed favicon: ${icon}`);
  }
  const walkBuild = directory => { for (const entry of readdirSync(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) walkBuild(path); else if (path.endsWith('.map')) errors.push(`Source map: ${path}`); } };
  walkBuild(join(root, 'dist'));
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`Audited ${publicationFiles.length} publication files; production imports, demo schema, Pages paths and manual deployment passed.`);
