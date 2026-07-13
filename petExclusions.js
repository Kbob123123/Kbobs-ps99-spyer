import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.join(process.cwd(), 'data');
const EXCLUSIONS_PATH = path.join(DATA_DIR, 'petExclusions.json');

// Names in this list are excluded from tier classification entirely — they
// won't show up in tracker posts, alerts, or /pet tier tags. Add to
// data/petExclusions.json (auto-created on first run) to exclude more
// without touching code. Match is case-insensitive and exact (the full pet
// name as it appears in the Pets collection, e.g. "Titanic Pixel M-2 PROTOTYPE").
const DEFAULT_EXCLUSIONS = ['Titanic Pixel M-2 PROTOTYPE'];

// Auto-exclude anything that looks like a dev/test/placeholder entry even if
// it's not in the explicit list — these patterns show up in prototype/WIP
// pets that sometimes leak into the public collection data.
const AUTO_EXCLUDE_PATTERNS = [/\bprototype\b/i, /\btest\b/i, /\bplaceholder\b/i, /\bwip\b/i, /\bdebug\b/i];

let cache = null;

function ensureLoaded() {
  if (cache) return cache;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(EXCLUSIONS_PATH)) {
    cache = { excludedNames: DEFAULT_EXCLUSIONS };
    save();
    return cache;
  }
  try {
    cache = JSON.parse(readFileSync(EXCLUSIONS_PATH, 'utf-8'));
    if (!Array.isArray(cache.excludedNames)) cache.excludedNames = [];
  } catch (err) {
    console.error('[petExclusions] Failed to parse petExclusions.json, using defaults:', err.message);
    cache = { excludedNames: DEFAULT_EXCLUSIONS };
  }
  return cache;
}

function save() {
  writeFileSync(EXCLUSIONS_PATH, JSON.stringify(cache, null, 2), 'utf-8');
}

export function isPetExcluded(name) {
  if (!name) return false;
  const { excludedNames } = ensureLoaded();
  const lower = name.toLowerCase();

  if (excludedNames.some((n) => n.toLowerCase() === lower)) return true;
  if (AUTO_EXCLUDE_PATTERNS.some((pattern) => pattern.test(name))) return true;

  return false;
}

export function addExclusion(name) {
  const data = ensureLoaded();
  if (!data.excludedNames.some((n) => n.toLowerCase() === name.toLowerCase())) {
    data.excludedNames.push(name);
    save();
  }
}

export function removeExclusion(name) {
  const data = ensureLoaded();
  data.excludedNames = data.excludedNames.filter((n) => n.toLowerCase() !== name.toLowerCase());
  save();
}

export function listExclusions() {
  return ensureLoaded().excludedNames;
}
