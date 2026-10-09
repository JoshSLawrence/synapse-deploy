import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Json } from '../../src/expression.ts';
import { evaluateTemplate, SKIP_DEFAULT } from '../../src/template.ts';
import type { Artifact } from '../../src/template.ts';
import { parseDependency } from '../../src/template.ts';

export const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'templates');
export const WORKSPACE = 'myworkspace';

/** The reasons a difference from the predecessor may carry (design section 1). */
export const REASONS = [
  'issue #94 typing',
  'issue #98 backslashes',
  'literal text no longer rewritten',
  'comma- and quote-safe concat',
  'template defaults now applied',
  'endpoint fqdns kept for private link services',
  'anchored defaults',
  'name encoding',
  'variables evaluated as expressions (legacy: single-pass text substitution; nested variables unresolved, brackets kept)',
  'default remapping (3.6)',
] as const;

export interface LegacyArtifact {
  name: string;
  type: string;
  isDefault: boolean;
  content: Json;
  dependson: string[];
  batch: number;
}

export interface Difference {
  artifact: string;
  path: string;
  legacy?: Json;
  current?: Json;
  reason: string;
}

/**
 * Runs `action` with stdout captured: masking and warnings are workflow
 * commands, and the runner running these tests would act on them.
 */
export function quietly<T>(action: () => T, written: string[] = []): T {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  };
  try {
    return action();
  } finally {
    process.stdout.write = original;
  }
}

export function caseNames(): string[] {
  return readdirSync(FIXTURES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(FIXTURES, entry.name, 'legacy.json')))
    .map((entry) => entry.name)
    .sort();
}

export function readCase(name: string): {
  legacy: LegacyArtifact[];
  current: Artifact[];
  differences: Difference[];
} {
  const dir = join(FIXTURES, name);
  const legacy = JSON.parse(readFileSync(join(dir, 'legacy.json'), 'utf8')) as LegacyArtifact[];
  const diffFile = join(dir, 'differences.json');
  const differences = existsSync(diffFile)
    ? (JSON.parse(readFileSync(diffFile, 'utf8')) as Difference[])
    : [];
  const { artifacts } = quietly(() =>
    evaluateTemplate({
      workspaceName: WORKSPACE,
      templateText: readFileSync(join(dir, 'template.json'), 'utf8'),
      parameterFiles: [
        { name: 'parameters.json', text: readFileSync(join(dir, 'parameters.json'), 'utf8') },
      ],
    }),
  );
  // The predecessor never listed pools or the virtual network.
  return { legacy, current: artifacts.filter((a) => a.kind.plane !== 'skip'), differences };
}

function isObj(v: unknown): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Every leaf-level mismatch between two JSON values, as `{path, legacy, current}`. */
export function diffJson(
  legacy: Json | undefined,
  current: Json | undefined,
  path: string,
  out: { path: string; legacy?: Json; current?: Json }[] = [],
): typeof out {
  if (Array.isArray(legacy) && Array.isArray(current)) {
    for (let i = 0; i < Math.max(legacy.length, current.length); i += 1) {
      diffJson(legacy[i], current[i], `${path}[${i}]`, out);
    }
  } else if (isObj(legacy) && isObj(current)) {
    for (const key of new Set([...Object.keys(legacy), ...Object.keys(current)])) {
      diffJson(legacy[key], current[key], path ? `${path}.${key}` : key, out);
    }
  } else if (JSON.stringify(legacy) !== JSON.stringify(current)) {
    const entry: { path: string; legacy?: Json; current?: Json } = { path };
    if (legacy !== undefined) entry.legacy = legacy;
    if (current !== undefined) entry.current = current;
    out.push(entry);
  }
  return out;
}

function currentView(a: Artifact): Json {
  return {
    type: a.type,
    isDefault: a.skip === SKIP_DEFAULT,
    content: a.body,
    dependson: a.dependsOn,
  };
}

function legacyView(l: LegacyArtifact): Json {
  return {
    type: l.type,
    isDefault: l.isDefault,
    content: l.content,
    dependson: l.dependson
      .map((dependency) => parseDependency(dependency))
      .filter((key) => key !== 'workspace'),
  };
}

/**
 * Pairs the legacy and current artifacts: by type and name, then by the
 * `name` differences the case lists. Whatever stays unpaired is a
 * difference in itself.
 */
export function compareCase(
  legacy: LegacyArtifact[],
  current: Artifact[],
  differences: Difference[],
): { artifact: string; path: string; legacy?: Json; current?: Json }[] {
  const out: { artifact: string; path: string; legacy?: Json; current?: Json }[] = [];
  const usedCurrent = new Set<Artifact>();
  const pairs: [LegacyArtifact, Artifact][] = [];
  const renamed = new Map(
    differences.filter((d) => d.path === 'name').map((d) => [d.artifact, d.current as string]),
  );
  for (const l of legacy) {
    const wanted = renamed.get(l.name) ?? l.name;
    const match = current.find(
      (c) =>
        !usedCurrent.has(c) && c.type.toLowerCase() === l.type.toLowerCase() && c.name === wanted,
    );
    if (match) {
      usedCurrent.add(match);
      pairs.push([l, match]);
    } else {
      out.push({ artifact: l.name, path: '', legacy: l.name });
    }
  }
  for (const c of current) {
    if (!usedCurrent.has(c)) {
      out.push({ artifact: c.name, path: '', current: c.name });
    }
  }
  for (const [l, c] of pairs) {
    if (l.name !== c.name) {
      out.push({ artifact: l.name, path: 'name', legacy: l.name, current: c.name });
    }
    for (const d of diffJson(legacyView(l), currentView(c), '')) {
      out.push({ artifact: l.name, ...d });
    }
  }
  return out;
}
