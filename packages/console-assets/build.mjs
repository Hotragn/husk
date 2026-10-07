import { cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = await realpath(dirname(fileURLToPath(import.meta.url)));
const source = resolve(packageDir, '../../apps/console/dist');
const destination = resolve(packageDir, 'dist');
const within = relative(packageDir, destination);
if (within !== 'dist' || isAbsolute(within) || within.startsWith('..')) {
  throw new Error('Refusing to replace a directory outside console-assets/dist.');
}
// Validate input before touching an existing distributable.
await readFile(resolve(source, 'index.html'), 'utf8');
try {
  const actual = await realpath(destination);
  if (actual !== destination) throw new Error('Refusing to replace a linked console-assets/dist directory.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, resolve(destination, 'public'), { recursive: true });
await writeFile(resolve(destination, 'index.js'), "import { fileURLToPath } from 'node:url';\nexport const consoleAssetsPath = fileURLToPath(new URL('./public/', import.meta.url));\n");
await writeFile(resolve(destination, 'index.d.ts'), 'export declare const consoleAssetsPath: string;\n');
console.log('Packaged console assets.');
