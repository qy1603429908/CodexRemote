import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const settingsPath = path.join(root, 'android', 'capacitor.settings.gradle');
const original = await readFile(settingsPath, 'utf8');
const dependencyPathPattern = /new File\('[^'\n]*node_modules\//g;
const matches = original.match(dependencyPathPattern);
if (!matches?.length) {
  throw new Error(`Could not find Capacitor node_modules paths in ${settingsPath}`);
}
const patched = original.replace(dependencyPathPattern, "new File('../../../node_modules/");
await writeFile(settingsPath, patched, 'utf8');
console.log(`Patched ${matches.length} Capacitor workspace dependency paths.`);
