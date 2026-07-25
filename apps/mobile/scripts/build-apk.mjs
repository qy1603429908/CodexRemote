import { access, cp, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = 'debug';
const task = 'assembleDebug';
const source = path.join(root, 'android', 'app', 'build', 'outputs', 'apk', mode, 'app-debug.apk');
const outputDir = path.join(root, 'artifacts');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = packageJson.version;
const destination = path.join(outputDir, `codex-mobile-remote-${mode}.apk`);
const versionedDestination = path.join(outputDir, `codex-mobile-remote-v${version}-${mode}.apk`);
const buildEnv = { ...process.env };
const defaultAndroidSdk = path.join(os.homedir(), 'Library', 'Android', 'sdk');
const defaultJavaHome = '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home';
if (!buildEnv.ANDROID_HOME) buildEnv.ANDROID_HOME = defaultAndroidSdk;
if (!buildEnv.ANDROID_SDK_ROOT) buildEnv.ANDROID_SDK_ROOT = buildEnv.ANDROID_HOME;
if (!buildEnv.JAVA_HOME && process.platform === 'darwin') {
  try {
    await access(defaultJavaHome);
    buildEnv.JAVA_HOME = defaultJavaHome;
  } catch {}
}

function run(command, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: false, env: buildEnv });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

await run('npm', ['run', 'build']);
const capName = process.platform === 'win32' ? 'cap.cmd' : 'cap';
const capCandidates = [
  path.join(root, 'node_modules', '.bin', capName),
  path.resolve(root, '..', '..', 'node_modules', '.bin', capName),
];
let cap;
for (const candidate of capCandidates) {
  try {
    await access(candidate);
    cap = candidate;
    break;
  } catch {}
}
if (!cap) throw new Error(`Capacitor CLI not found. Checked: ${capCandidates.join(', ')}`);
await run(cap, ['sync', 'android']);
await run('node', [path.join(root, 'scripts', 'fix-capacitor-workspace-paths.mjs')]);
const gradle = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
await run(gradle, [task], path.join(root, 'android'));
await mkdir(outputDir, { recursive: true });
await cp(source, destination);
await cp(source, versionedDestination);
console.log(`\nAPK: ${destination}`);
console.log(`Versioned APK: ${versionedDestination}`);
