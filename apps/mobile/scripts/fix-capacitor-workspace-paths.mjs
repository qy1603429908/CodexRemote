import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const settingsPath = path.join(root, 'android', 'capacitor.settings.gradle');
const original = await readFile(settingsPath, 'utf8');
const patched = original.replaceAll("new File('../node_modules/", "new File('../../../node_modules/");
if (patched === original && !original.includes("new File('../../../node_modules/")) {
  throw new Error(`Could not find Capacitor node_modules paths in ${settingsPath}`);
}
await writeFile(settingsPath, patched, 'utf8');
console.log('Patched Capacitor workspace dependency paths.');
