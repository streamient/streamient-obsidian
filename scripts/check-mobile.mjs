import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = fileURLToPath(new URL('../src/', import.meta.url));
const forbiddenImports = /(?:from\s+|import\s*\(|require\s*\()\s*['"](?:node:|electron['"]|fs['"]|path['"]|crypto['"]|os['"]|stream['"])/;

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(target) : target.endsWith('.ts') ? [target] : [];
  });
}

for (const file of sourceFiles(sourceDirectory)) {
  const source = fs.readFileSync(file, 'utf8');
  if (forbiddenImports.test(source)) throw new Error(`Desktop-only API import found in ${path.relative(process.cwd(), file)}`);
}

const bundle = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
if (/require\(['"](?:electron|fs|path|crypto|os|stream)['"]\)/.test(bundle)) throw new Error('Desktop-only API import found in main.js');
if (!/isDesktopOnly"?:\s*false/.test(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'))) throw new Error('manifest.json must set isDesktopOnly to false');

console.log('Verified mobile-compatible Obsidian API usage.');
