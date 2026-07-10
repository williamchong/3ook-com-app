// EAS builds triggered server-side (.eas/workflows) read eas.json, not .nvmrc,
// so the Node pin has to be duplicated there. Fail loudly if the two drift.
import { readFileSync } from 'node:fs';

const nvmrc = readFileSync('.nvmrc', 'utf8').trim();
const want = nvmrc.replace(/^v/, '');

if (!/^\d+\.\d+\.\d+$/.test(want)) {
  console.error(`.nvmrc must pin an exact version, got "${nvmrc}".`);
  console.error("eas.json's node field takes no aliases or ranges.");
  process.exit(1);
}

const { build } = JSON.parse(readFileSync('eas.json', 'utf8'));
const profiles = Object.keys(build ?? {});

if (profiles.length === 0) {
  console.error('eas.json declares no build profiles — nothing to check.');
  process.exit(1);
}

// Mirror how eas-json resolves a profile: node may be inherited via extends.
function resolveNode(name, seen = new Set()) {
  if (seen.has(name)) return undefined;
  seen.add(name);
  const profile = build[name];
  if (!profile) return undefined;
  if (profile.node) return profile.node.replace(/^v/, '');
  return profile.extends ? resolveNode(profile.extends, seen) : undefined;
}

const drifted = profiles.filter((name) => resolveNode(name) !== want);

if (drifted.length > 0) {
  console.error(`.nvmrc pins Node ${want}, but these eas.json build profiles disagree:`);
  for (const name of drifted) {
    console.error(`  ${name}: ${resolveNode(name) ?? '(unset)'}`);
  }
  process.exit(1);
}

console.log(`eas.json build profiles all pin Node ${want}`);
