import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

interface ActionEntry {
  description?: unknown;
  required?: unknown;
  default?: unknown;
}

interface ActionFile {
  inputs?: Record<string, ActionEntry>;
  outputs?: Record<string, ActionEntry>;
}

const REPO = new URL('..', import.meta.url);

function describe(kind: string, name: string, entry: ActionEntry | undefined): string {
  if (typeof entry?.description !== 'string' || entry.description.trim() === '') {
    throw new Error(
      `action.yml: ${kind} ${name} has no description; add one, because the README table is generated from it.`,
    );
  }
  return entry.description.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function table(header: string[], rows: string[][]): string {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: string[]) =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join(' | ')} |`;
  return [
    line(header),
    `| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`,
    ...rows.map(line),
  ].join('\n');
}

/** The README's inputs and outputs tables, written from action.yml's text. */
export function renderTables(actionYml: string): { inputs: string; outputs: string } {
  const action = parse(actionYml) as ActionFile;
  const inputs = Object.entries(action.inputs ?? {}).map(([name, entry]) => {
    const fallback = entry.default;
    const shown =
      (typeof fallback === 'string' && fallback !== '') ||
      typeof fallback === 'number' ||
      typeof fallback === 'boolean'
        ? `\`${String(fallback)}\``
        : '';
    return [
      `\`${name}\``,
      entry.required === true ? 'yes' : 'no',
      shown,
      describe('input', name, entry),
    ];
  });
  const outputs = Object.entries(action.outputs ?? {}).map(([name, entry]) => [
    `\`${name}\``,
    describe('output', name, entry),
  ]);
  return {
    inputs: table(['Input', 'Required', 'Default', 'Description'], inputs),
    outputs: table(['Output', 'Description'], outputs),
  };
}

/** Replaces what is between the `<name>` start and end markers with the wrapped table. */
export function replaceSection(readme: string, name: string, body: string): string {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  for (const marker of [start, end]) {
    if (readme.split(marker).length !== 2) {
      throw new Error(
        `README.md must contain the marker ${marker} exactly once; restore it where the ${name} table belongs.`,
      );
    }
  }
  const from = readme.indexOf(start);
  const to = readme.indexOf(end);
  if (to < from) {
    throw new Error(`README.md: the ${end} marker comes before ${start}; swap them.`);
  }
  const wrapped = [
    '',
    '<!-- markdownlint-disable MD013 -->',
    '',
    body,
    '',
    '<!-- markdownlint-enable MD013 -->',
    '',
  ].join('\n');
  return readme.slice(0, from + start.length) + wrapped + readme.slice(to);
}

/** README.md with both generated sections brought up to date. */
export function renderReadme(readme: string, actionYml: string): string {
  const tables = renderTables(actionYml);
  return replaceSection(replaceSection(readme, 'inputs', tables.inputs), 'outputs', tables.outputs);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const readmePath = new URL('README.md', REPO);
  const actionYml = readFileSync(new URL('action.yml', REPO), 'utf8');
  writeFileSync(readmePath, renderReadme(readFileSync(readmePath, 'utf8'), actionYml));
}
