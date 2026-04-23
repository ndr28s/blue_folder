#!/usr/bin/env node
/**
 * Build standalone Blue Folder exe (Windows).
 *
 * Steps:
 *  1. Build all paperclip packages (pnpm build from repo root)
 *  2. pnpm deploy @paperclipai/server -> dist/server-pnpm
 *  3. Flatten symlinks -> dist/server
 *  4. Hoist/nest transitive deps + apply publishConfig
 *  5. tsc compile electron main process
 *  6. electron-builder -> dist/win-unpacked or nsis installer
 */

import { execSync } from 'child_process';
import { rmSync, mkdirSync, cpSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const electronDir = resolve(__dirname, '..');
// blue_folder root (one level above electron/)
const appRoot = resolve(electronDir, '..');
// paperclip repo root (sibling of blue_folder)
const repoRoot = resolve(appRoot, '..', 'paperclip');

if (!existsSync(resolve(repoRoot, 'pnpm-workspace.yaml'))) {
  console.error(`ERROR: paperclip repo not found at ${repoRoot}`);
  console.error('Expected directory structure: <parent>/paperclip  and  <parent>/blue_folder');
  process.exit(1);
}

const pnpmDeployDir = resolve(electronDir, 'dist', 'server-pnpm');
const serverFlatDir = resolve(electronDir, 'dist', 'server');

function run(cmd, cwd) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd: cwd || electronDir, stdio: 'inherit' });
}

function getVersion(pkgDir) {
  try { return JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf-8')).version; }
  catch { return null; }
}

function parsePnpmEntryName(entryName) {
  if (entryName.startsWith('@')) {
    const m = entryName.match(/^(@[^+]+)\+([^@_]+)@/);
    return m ? `${m[1]}/${m[2]}` : null;
  }
  const i = entryName.indexOf('@');
  return i > 0 ? entryName.slice(0, i) : null;
}

function hoistTransitiveDeps(nodeModulesDir) {
  const pnpmDir = resolve(nodeModulesDir, '.pnpm');
  if (!existsSync(pnpmDir)) return;
  let hoisted = 0;
  for (const entry of readdirSync(pnpmDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const entryMods = resolve(pnpmDir, entry.name, 'node_modules');
    if (!existsSync(entryMods)) continue;
    for (const pkg of readdirSync(entryMods, { withFileTypes: true })) {
      if (!pkg.isDirectory() || pkg.name === '.bin' || pkg.name === '.modules.yaml') continue;
      if (pkg.name.startsWith('@')) {
        const scopeDir = resolve(entryMods, pkg.name);
        if (!existsSync(scopeDir)) continue;
        for (const scoped of readdirSync(scopeDir, { withFileTypes: true })) {
          if (!scoped.isDirectory()) continue;
          const dest = resolve(nodeModulesDir, pkg.name, scoped.name);
          if (!existsSync(dest)) {
            mkdirSync(resolve(nodeModulesDir, pkg.name), { recursive: true });
            cpSync(resolve(scopeDir, scoped.name), dest, { recursive: true });
            hoisted++;
          }
        }
      } else {
        const dest = resolve(nodeModulesDir, pkg.name);
        if (!existsSync(dest)) {
          cpSync(resolve(entryMods, pkg.name), dest, { recursive: true });
          hoisted++;
        }
      }
    }
  }
  console.log(`  Hoisted ${hoisted} transitive dep(s)`);
}

function nestVersionConflicts(nodeModulesDir) {
  const pnpmDir = resolve(nodeModulesDir, '.pnpm');
  const workspacePnpm = resolve(repoRoot, 'node_modules', '.pnpm');
  if (!existsSync(pnpmDir)) return;
  let nested = 0;

  for (const entry of readdirSync(pnpmDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const primaryName = parsePnpmEntryName(entry.name);
    if (!primaryName) continue;

    const primaryParts = primaryName.split('/');
    const primaryTopDir = primaryParts.length === 2
      ? resolve(nodeModulesDir, primaryParts[0], primaryParts[1])
      : resolve(nodeModulesDir, primaryName);
    if (!existsSync(primaryTopDir)) continue;

    const entryMods = resolve(pnpmDir, entry.name, 'node_modules');
    if (!existsSync(entryMods)) continue;

    const processDepPair = (depName, srcDir) => {
      if (depName === primaryName) return;
      const depParts = depName.split('/');
      const topLevelDir = depParts.length === 2
        ? resolve(nodeModulesDir, depParts[0], depParts[1])
        : resolve(nodeModulesDir, depName);
      if (!existsSync(topLevelDir)) return;

      const topVer = getVersion(topLevelDir);
      const srcVer = getVersion(srcDir);
      if (!topVer || !srcVer) return;
      if (topVer.split('.')[0] === srcVer.split('.')[0]) return;

      const nestBase = depParts.length === 2
        ? resolve(primaryTopDir, 'node_modules', depParts[0])
        : resolve(primaryTopDir, 'node_modules');
      const nestDest = depParts.length === 2
        ? resolve(nestBase, depParts[1])
        : resolve(nestBase, depName);
      if (existsSync(nestDest)) return;

      mkdirSync(nestBase, { recursive: true });
      cpSync(srcDir, nestDest, { recursive: true });
      console.log(`  Nested ${depName}@${srcVer} into ${primaryName}/`);
      nested++;
    };

    for (const dep of readdirSync(entryMods, { withFileTypes: true })) {
      if (!dep.isDirectory() || dep.name === '.bin') continue;
      if (dep.name.startsWith('@')) {
        const scopeDir = resolve(entryMods, dep.name);
        if (!existsSync(scopeDir)) continue;
        for (const scoped of readdirSync(scopeDir, { withFileTypes: true })) {
          if (scoped.isDirectory()) {
            processDepPair(`${dep.name}/${scoped.name}`, resolve(scopeDir, scoped.name));
          }
        }
      } else {
        processDepPair(dep.name, resolve(entryMods, dep.name));
      }
    }
  }

  // Fix peer dep major-version conflicts from workspace store
  for (const e of readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === '.pnpm' || e.name === '.bin') continue;
    const pkgNames = e.name.startsWith('@')
      ? readdirSync(resolve(nodeModulesDir, e.name), { withFileTypes: true })
          .filter(s => s.isDirectory())
          .map(s => `${e.name}/${s.name}`)
      : [e.name];

    for (const pkgName of pkgNames) {
      const pkgParts = pkgName.split('/');
      const pkgDir = pkgParts.length === 2
        ? resolve(nodeModulesDir, pkgParts[0], pkgParts[1])
        : resolve(nodeModulesDir, pkgName);
      let pkg;
      try { pkg = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf-8')); } catch { continue; }
      const peers = pkg.peerDependencies || {};
      for (const [peer, range] of Object.entries(peers)) {
        const m = range.match(/\^?>=?\s*(\d+)/);
        if (!m) continue;
        const requiredMajor = parseInt(m[1]);
        const peerParts = peer.split('/');
        const topPeerDir = peerParts.length === 2
          ? resolve(nodeModulesDir, peerParts[0], peerParts[1])
          : resolve(nodeModulesDir, peer);
        if (!existsSync(topPeerDir)) continue;
        const topVer = getVersion(topPeerDir);
        if (!topVer || parseInt(topVer.split('.')[0]) >= requiredMajor) continue;

        let src = null;
        if (existsSync(workspacePnpm)) {
          for (const wEntry of readdirSync(workspacePnpm, { withFileTypes: true })) {
            if (!wEntry.isDirectory() || parsePnpmEntryName(wEntry.name) !== peer) continue;
            const candidate = peerParts.length === 2
              ? resolve(workspacePnpm, wEntry.name, 'node_modules', peerParts[0], peerParts[1])
              : resolve(workspacePnpm, wEntry.name, 'node_modules', peer);
            const v = getVersion(candidate);
            if (v && parseInt(v.split('.')[0]) >= requiredMajor) { src = candidate; break; }
          }
        }
        if (!src) continue;

        const nestBase = peerParts.length === 2
          ? resolve(pkgDir, 'node_modules', peerParts[0])
          : resolve(pkgDir, 'node_modules');
        const nestDest = peerParts.length === 2
          ? resolve(nestBase, peerParts[1])
          : resolve(nestBase, peer);
        if (!existsSync(nestDest)) {
          mkdirSync(nestBase, { recursive: true });
          cpSync(src, nestDest, { recursive: true });
          console.log(`  Nested peer ${peer}@${getVersion(src)} into ${pkgName}/`);
          nested++;
        }
      }
    }
  }
  console.log(`  Nested ${nested} version-conflict dep(s)`);
}

function applyPublishConfig(nodeModulesDir) {
  const paperclipDir = resolve(nodeModulesDir, '@paperclipai');
  if (!existsSync(paperclipDir)) return;
  for (const pkgName of readdirSync(paperclipDir, { withFileTypes: true })) {
    if (!pkgName.isDirectory()) continue;
    const pkgJsonPath = resolve(paperclipDir, pkgName.name, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    if (!pkg.publishConfig) continue;
    Object.assign(pkg, pkg.publishConfig);
    delete pkg.publishConfig;
    writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`  Applied publishConfig for @paperclipai/${pkgName.name}`);
  }
}

console.log('=== Building Blue Folder standalone exe ===');

console.log('\n[1/4] Building all paperclip packages...');
run('pnpm run build', repoRoot);

console.log('\n[2/4] Creating production server bundle...');
rmSync(pnpmDeployDir, { recursive: true, force: true });
rmSync(serverFlatDir, { recursive: true, force: true });
mkdirSync(resolve(electronDir, 'dist'), { recursive: true });

// Copy UI dist into server/ui-dist before deploy (prepack step)
const uiDistSrc = resolve(repoRoot, 'ui', 'dist');
const uiDistDest = resolve(repoRoot, 'server', 'ui-dist');
if (existsSync(uiDistSrc)) {
  console.log('  Copying UI dist -> server/ui-dist...');
  rmSync(uiDistDest, { recursive: true, force: true });
  cpSync(uiDistSrc, uiDistDest, { recursive: true });
} else {
  console.warn('  WARNING: ui/dist not found; server will not serve the frontend');
}

run(`pnpm deploy --filter @paperclipai/server --prod "${pnpmDeployDir}"`, repoRoot);

// Remove temporary ui-dist copy
rmSync(uiDistDest, { recursive: true, force: true });

console.log('  Flattening symlinks (dereference)...');
cpSync(pnpmDeployDir, serverFlatDir, { recursive: true, dereference: true });
rmSync(pnpmDeployDir, { recursive: true, force: true });

console.log('  Hoisting transitive dependencies...');
hoistTransitiveDeps(resolve(serverFlatDir, 'node_modules'));

console.log('  Nesting version-conflict deps...');
nestVersionConflicts(resolve(serverFlatDir, 'node_modules'));

rmSync(resolve(serverFlatDir, 'node_modules', '.pnpm'), { recursive: true, force: true });

console.log('  Fixing @paperclipai/* publishConfig...');
applyPublishConfig(resolve(serverFlatDir, 'node_modules'));

console.log('\n[3/4] Compiling Electron main process (TypeScript)...');
run('npm run build', electronDir);

console.log('\n[4/4] Packaging Electron app...');
try {
  execSync(
    'powershell -NoProfile -Command "Stop-Process -Name \'Blue Folder\' -Force -ErrorAction SilentlyContinue"',
    { stdio: 'ignore' },
  );
} catch (_) {}
run('npm run electron:pack', electronDir);

console.log('\n=== Done! ===');
console.log(`  Unpacked app : dist/win-unpacked/Blue\\ Folder.exe`);
