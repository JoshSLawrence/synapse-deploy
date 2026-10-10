import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { renderReadme, renderTables, replaceSection } from '../scripts/readme-tables.ts';

const root = new URL('../', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, root), 'utf8');

describe('README generated tables', () => {
  it('match action.yml', () => {
    const readme = read('README.md');
    assert.equal(
      renderReadme(readme, read('action.yml')),
      readme,
      'README inputs/outputs tables are stale: run `mise run docs`',
    );
  });

  it('renders inputs in order, escaping pipes and leaving an empty default blank', () => {
    const yml = [
      'inputs:',
      '  zed:',
      '    description: >-',
      '      Folded',
      '      text | pipe.',
      '    required: true',
      '  alpha:',
      '    description: Second.',
      '    default: "false"',
      '    required: false',
      '  empty:',
      '    description: Blank default.',
      '    default: ""',
      'outputs:',
      '  count:',
      '    description: A number.',
    ].join('\n');
    const { inputs, outputs } = renderTables(yml);
    assert.equal(
      inputs,
      [
        '| Input   | Required | Default | Description          |',
        '| ------- | -------- | ------- | -------------------- |',
        '| `zed`   | yes      |         | Folded text \\| pipe. |',
        '| `alpha` | no       | `false` | Second.              |',
        '| `empty` | no       |         | Blank default.       |',
      ].join('\n'),
    );
    assert.equal(
      outputs,
      ['| Output  | Description |', '| ------- | ----------- |', '| `count` | A number.   |'].join(
        '\n',
      ),
    );
  });

  it('refuses a missing description', () => {
    assert.throws(() => renderTables('inputs:\n  x:\n    required: true\n'), /input x has no desc/);
  });

  it('needs exactly one marker pair', () => {
    assert.throws(() => replaceSection('no markers', 'inputs', 'x'), /inputs:start/);
    const twice = '<!-- inputs:start -->\n<!-- inputs:end -->\n<!-- inputs:start -->';
    assert.throws(() => replaceSection(twice, 'inputs', 'x'), /inputs:start/);
  });
});
