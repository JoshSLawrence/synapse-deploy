import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  evaluateTemplate,
  loadTemplate,
  parseDependency,
  SKIP_DEFAULT,
  SKIP_INFRASTRUCTURE,
} from '../src/template.ts';
import type { TemplateSource } from '../src/template.ts';
import { quietly } from './support/parity.ts';

type Obj = Record<string, unknown>;

function template(parameters: Obj, resources: Obj[], variables: Obj = {}): string {
  return JSON.stringify({
    parameters: { workspaceName: { type: 'string' }, ...parameters },
    variables: {
      workspaceId: "[concat('Microsoft.Synapse/workspaces/', parameters('workspaceName'))]",
      ...variables,
    },
    resources,
  });
}

function pipeline(name: string, extra: Obj = {}, dependsOn: unknown[] = []): Obj {
  return {
    name: `[concat(parameters('workspaceName'), '/${name}')]`,
    type: 'Microsoft.Synapse/workspaces/pipelines',
    apiVersion: '2019-06-01-preview',
    properties: { activities: [], ...extra },
    dependsOn,
  };
}

function load(
  templateText: string,
  extra: Partial<TemplateSource> = {},
): { artifacts: ReturnType<typeof evaluateTemplate>['artifacts']; output: string } {
  const written: string[] = [];
  const { artifacts } = quietly(
    () => evaluateTemplate({ workspaceName: 'myworkspace', templateText, ...extra }),
    written,
  );
  return { artifacts, output: written.join('') };
}

const file = (parameters: Obj, name = 'p.json') => ({
  name,
  text: JSON.stringify({
    parameters: Object.fromEntries(Object.entries(parameters).map(([k, v]) => [k, { value: v }])),
  }),
});

function body(artifacts: ReturnType<typeof load>['artifacts']): Obj {
  return (artifacts[0]?.body.properties ?? {}) as Obj;
}

describe('template: parameters', () => {
  const t = template({ p: { type: 'string', defaultValue: 'from-default' } }, [
    pipeline('pl', { description: "[parameters('p')]" }),
  ]);

  it('uses the default, then files in order, then parameters lines', () => {
    assert.equal(body(load(t).artifacts)['description'], 'from-default');
    assert.equal(
      body(
        load(t, { parameterFiles: [file({ p: 'one' }, 'a.json'), file({ p: 'two' }, 'b.json')] })
          .artifacts,
      )['description'],
      'two',
    );
    assert.equal(
      body(
        load(t, {
          parameterFiles: [file({ p: 'one' })],
          overrides: [{ name: 'P', value: 'three' }],
        }).artifacts,
      )['description'],
      'three',
    );
  });

  it('applies a default that refers to another parameter', () => {
    const text = template(
      {
        a: { type: 'string', defaultValue: 'x' },
        b: { type: 'string', defaultValue: "[concat(parameters('a'), '-y')]" },
      },
      [pipeline('pl', { description: "[parameters('b')]" })],
    );
    assert.equal(body(load(text).artifacts)['description'], 'x-y');
  });

  it('fails on a default that refers to itself', () => {
    const text = template({ a: { type: 'string', defaultValue: "[parameters('a')]" } }, []);
    assert.throws(() => load(text), /Parameter a: .*refers to itself/);
  });

  it('forces workspaceName to the workspace-name input', () => {
    const { artifacts, output } = load(template({}, [pipeline('pl')]), {
      parameterFiles: [file({ workspaceName: 'otherws' })],
    });
    assert.equal(artifacts[0]?.body['name'], 'pl');
    assert.equal(artifacts[0]?.body['dependsOn'] instanceof Array, true);
    assert.match(
      output,
      /Parameter workspaceName is otherws.*using the workspace-name input myworkspace/,
    );
  });

  it('types parameters lines by the declared type', () => {
    const text = template(
      {
        s: { type: 'string' },
        n: { type: 'int' },
        b: { type: 'bool' },
        o: { type: 'object' },
        a: { type: 'array' },
      },
      [
        pipeline('pl', {
          s: "[parameters('s')]",
          n: "[parameters('n')]",
          b: "[parameters('b')]",
          o: "[parameters('o')]",
          a: "[parameters('a')]",
        }),
      ],
    );
    const { artifacts } = load(text, {
      overrides: [
        { name: 's', value: '45.0' },
        { name: 'n', value: '7' },
        { name: 'b', value: 'true' },
        { name: 'o', value: '{"k": [1]}' },
        { name: 'a', value: '[1, "x"]' },
      ],
    });
    assert.deepEqual(body(artifacts), {
      activities: [],
      s: '45.0',
      n: 7,
      b: true,
      o: { k: [1] },
      a: [1, 'x'],
    });
  });

  it('rejects a value of the wrong type without echoing it', () => {
    const text = template(
      { n: { type: 'int' }, b: { type: 'bool' }, o: { type: 'object' }, a: { type: 'array' } },
      [],
    );
    const bad = (name: string, value: string) =>
      assert.throws(
        () => load(text, { overrides: [{ name, value }] }),
        (error: Error) =>
          error.message.includes(`Parameter ${name}`) && !error.message.includes(value),
      );
    bad('n', '7.5');
    bad('b', 'yes');
    bad('o', '[1]');
    bad('o', 'not-json-secret');
    bad('a', '{"k":1}');
  });

  it('fails on an undeclared parameter, listing the declared ones', () => {
    const text = template({ p: { type: 'string', defaultValue: '' } }, []);
    assert.throws(
      () => load(text, { parameterFiles: [file({ nope: 'x' })] }),
      /sets nope, which the template does not declare\. Declared: workspaceName, p\./,
    );
    assert.throws(
      () => load(text, { overrides: [{ name: 'nope', value: 'x' }] }),
      /parameters input sets nope/,
    );
  });

  it('lists at most 20 declared names', () => {
    const many = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [`p${i}`, { type: 'string', defaultValue: '' }]),
    );
    assert.throws(
      () => load(template(many, []), { overrides: [{ name: 'nope', value: 'x' }] }),
      /and 6 more/,
    );
  });

  it('fails on a declared parameter with no value and no default', () => {
    const text = template({ a: { type: 'string' }, b: { type: 'int' } }, []);
    assert.throws(() => load(text), /No value for parameter\(s\) a, b/);
  });

  it('refuses a Key Vault reference', () => {
    const text = template({ p: { type: 'securestring' } }, []);
    assert.throws(
      () =>
        load(text, {
          parameterFiles: [
            {
              name: 'kv.json',
              text: JSON.stringify({ parameters: { p: { reference: { secretName: 's' } } } }),
            },
          ],
        }),
      /Key Vault references only work in ARM deployments; pass the value in the parameters input instead/,
    );
  });

  it('fails on files that are not JSON or not parameters files', () => {
    const text = template({}, []);
    assert.throws(
      () => load(text, { parameterFiles: [{ name: 'x.json', text: '{' }] }),
      /Parameters file x.json is not valid JSON/,
    );
    assert.throws(
      () => load(text, { parameterFiles: [{ name: 'x.json', text: '{}' }] }),
      /no "parameters" object/,
    );
    assert.throws(() => load('{', {}), /Template file is not valid JSON/);
    assert.throws(() => load('{}', {}), /no "resources" array/);
  });
});

describe('template: masking', () => {
  const masks = (output: string): string[] =>
    output
      .split('\n')
      .filter((line) => line.startsWith('::add-mask::'))
      .map((line) => line.slice('::add-mask::'.length));

  it('masks secure values of three or more characters, never empty or short ones', () => {
    const text = template(
      {
        a: { type: 'securestring' },
        b: { type: 'securestring' },
        c: { type: 'securestring' },
        d: { type: 'securestring' },
        e: { type: 'string' },
        f: { type: 'secureobject' },
      },
      [],
    );
    const { output } = load(text, {
      parameterFiles: [
        file({
          a: '',
          b: 'x',
          c: 'xy',
          d: 'xyz',
          e: 'public-value',
          f: { k: 'secret-leaf', n: 5, nested: ['deep-leaf', 'ab'] },
        }),
      ],
    });
    assert.deepEqual(masks(output).sort(), ['deep-leaf', 'secret-leaf', 'xyz']);
  });

  it('masks before an error can be logged', () => {
    const text = template({ a: { type: 'securestring' } }, [
      pipeline('pl', { x: "[parameters('nope')]" }),
    ]);
    const written: string[] = [];
    assert.throws(() =>
      quietly(
        () =>
          evaluateTemplate({
            workspaceName: 'myworkspace',
            templateText: text,
            overrides: [{ name: 'a', value: 'super-secret' }],
          }),
        written,
      ),
    );
    assert.deepEqual(masks(written.join('')), ['super-secret']);
  });
});

describe('template: expressions in resources', () => {
  it('keeps [x], [[x], [dbo].[t] and [print(x) for x in xs] literal', () => {
    const literals = [
      '[x]',
      '[[x]',
      '[dbo].[t]',
      '[print(x) for x in xs]',
      '[1, 2, 3]',
      "SELECT [n] FROM [dbo].[t] WHERE a = 'it''s [x]'",
    ];
    const { artifacts } = load(template({}, [pipeline('pl', { items: literals })]));
    assert.deepEqual(body(artifacts)['items'], literals);
  });

  it('fails a malformed supported-function string with the resource, path and fix', () => {
    const text = template({}, [pipeline('pl', { items: ['ok', "[concat('a', string(1))]"] })]);
    assert.throws(
      () => load(text),
      (error: Error) =>
        error.message.includes('resources[0]') &&
        error.message.includes('properties.items[1]') &&
        error.message.includes("[concat('a', string(1))]") &&
        error.message.includes('end it with a space or ";"'),
    );
  });

  it('fails [concat(a) for a in x], as documented', () => {
    const text = template({}, [pipeline('pl', { code: '[concat(a) for a in x]' })]);
    assert.throws(() => load(text), /properties\.code: cannot evaluate/);
  });

  it('never evaluates object keys', () => {
    const { artifacts } = load(
      template({}, [pipeline('pl', { "[parameters('workspaceName')]": 1 })]),
    );
    assert.deepEqual(body(artifacts), { activities: [], "[parameters('workspaceName')]": 1 });
  });

  it('does not rewrite text that merely contains parameters(...)', () => {
    const { artifacts } = load(
      template({}, [pipeline('pl', { code: "x = parameters('workspaceName')" })]),
    );
    assert.equal(body(artifacts)['code'], "x = parameters('workspaceName')");
  });

  it('keeps a string parameter that looks like a number a string', () => {
    const text = template({ p: { type: 'string' } }, [pipeline('pl', { v: "[parameters('p')]" })]);
    assert.equal(
      body(load(text, { overrides: [{ name: 'p', value: '45.0' }] }).artifacts)['v'],
      '45.0',
    );
  });

  it('evaluates variables, nested, and fails a variable cycle', () => {
    const ok = template({}, [pipeline('pl', { v: "[variables('b')]" })], {
      a: "[concat('x-', parameters('workspaceName'))]",
      b: "[concat(variables('a'), '-y')]",
    });
    assert.equal(body(load(ok).artifacts)['v'], 'x-myworkspace-y');
    const cycle = template({}, [pipeline('pl', { v: "[variables('a')]" })], {
      a: "[variables('b')]",
      b: "[variables('a')]",
    });
    assert.throws(() => load(cycle), /refers to itself/);
  });

  it('reports every failing resource', () => {
    const text = template({}, [
      pipeline('one', { v: "[parameters('nope')]" }),
      { ...pipeline('two'), type: 'Microsoft.Synapse/workspaces/widgets' },
    ]);
    assert.throws(
      () => load(text),
      (error: Error) =>
        error.message.includes('resources[0]') &&
        error.message.includes('resources[1]') &&
        error.message.includes('unsupported type'),
    );
  });
});

describe('template: names, kinds and dependencies', () => {
  it('takes the last segment as the name, with or without /default/', () => {
    const text = template({}, [
      pipeline('pl'),
      {
        name: "[concat(parameters('workspaceName'), '/default/pe1')]",
        type: 'Microsoft.Synapse/workspaces/managedVirtualNetworks/managedPrivateEndpoints',
        properties: {},
        dependsOn: ["[concat(variables('workspaceId'), '/managedVirtualNetworks/default')]"],
      },
    ]);
    const { artifacts } = load(text);
    assert.deepEqual(
      artifacts.map((a) => a.key),
      ['pipelines/pl', 'managedPrivateEndpoints/pe1'],
    );
    assert.deepEqual(artifacts[1]?.dependsOn, ['managedVirtualNetworks/default']);
  });

  it('fails a bad name', () => {
    for (const name of [
      "[parameters('workspaceName')]",
      'a/b/c/d',
      'ws//x',
      "[parameters('workspaceName')]/",
    ]) {
      assert.throws(
        () => load(template({}, [{ ...pipeline('pl'), name }])),
        /name must evaluate to <workspace>/,
        name,
      );
    }
    assert.throws(
      () =>
        load(
          template({ n: { type: 'int', defaultValue: 1 } }, [
            { ...pipeline('pl'), name: "[parameters('n')]" },
          ]),
        ),
      /not an integer|not a string|a string/,
    );
  });

  it('fails an unsupported type naming it', () => {
    assert.throws(
      () =>
        load(template({}, [{ ...pipeline('pl'), type: 'Microsoft.Synapse/workspaces/widgets' }])),
      /unsupported type Microsoft.Synapse\/workspaces\/widgets/,
    );
  });

  it('fails a duplicate resource', () => {
    assert.throws(() => load(template({}, [pipeline('pl'), pipeline('PL')])), /defined twice/);
  });

  it('marks defaults and infrastructure kinds as skipped', () => {
    const text = template({}, [
      {
        name: "[concat(parameters('workspaceName'), '/devws-WorkspaceDefaultStorage')]",
        type: 'Microsoft.Synapse/workspaces/linkedServices',
        properties: {},
      },
      {
        name: "[concat(parameters('workspaceName'), '/pool')]",
        type: 'Microsoft.Synapse/workspaces/bigDataPools',
        properties: {},
      },
      pipeline('pl'),
    ]);
    const { artifacts } = load(text);
    assert.deepEqual(
      artifacts.map((a) => [a.key, a.skip]),
      [
        ['linkedServices/myworkspace-workspacedefaultstorage', SKIP_DEFAULT],
        ['bigDataPools/pool', SKIP_INFRASTRUCTURE],
        ['pipelines/pl', undefined],
      ],
    );
    assert.equal(artifacts[0]?.body['name'], 'myworkspace-WorkspaceDefaultStorage');
  });

  it('remaps default names in references and dependencies', () => {
    const text = template({}, [
      pipeline(
        'pl',
        { ls: { referenceName: 'devws-WorkspaceDefaultStorage', type: 'LinkedServiceReference' } },
        ["[concat(variables('workspaceId'), '/linkedServices/devws-WorkspaceDefaultStorage')]"],
      ),
    ]);
    const { artifacts } = load(text);
    assert.deepEqual(artifacts[0]?.dependsOn, [
      'linkedServices/myworkspace-workspacedefaultstorage',
    ]);
    assert.deepEqual(
      (body(artifacts)['ls'] as Obj)['referenceName'],
      'myworkspace-WorkspaceDefaultStorage',
    );
  });

  it('accepts resourceId in dependsOn and a plain string', () => {
    const text = template({}, [
      pipeline('pl', {}, [
        "[resourceId('Microsoft.Synapse/workspaces/notebooks', parameters('workspaceName'), 'nb')]",
        'Microsoft.Synapse/workspaces/myworkspace/datasets/ds',
        "[concat(variables('workspaceId'))]",
      ]),
    ]);
    assert.deepEqual(load(text).artifacts[0]?.dependsOn, ['notebooks/nb', 'datasets/ds']);
  });

  it('fails a dependsOn entry that is not a Synapse resource', () => {
    for (const entry of [
      'Microsoft.Storage/storageAccounts/x',
      'Microsoft.Synapse/workspaces/ws/widgets/x',
      'Microsoft.Synapse/workspaces/ws/pipelines',
    ]) {
      assert.throws(
        () => load(template({}, [pipeline('pl', {}, [entry])])),
        /dependsOn entry/,
        entry,
      );
    }
  });

  it('parses dependency strings', () => {
    assert.equal(parseDependency('Microsoft.Synapse/workspaces/ws'), 'workspace');
    assert.equal(
      parseDependency('microsoft.synapse/workspaces/ws/linkedServices/Ls'),
      'linkedServices/ls',
    );
    assert.equal(
      parseDependency(
        'Microsoft.Synapse/workspaces/ws/managedVirtualNetworks/default/managedPrivateEndpoints/Pe',
      ),
      'managedPrivateEndpoints/pe',
    );
  });

  it('requires the main file of a Spark job definition', () => {
    const job = (jobProperties: Obj) => ({
      name: "[concat(parameters('workspaceName'), '/job')]",
      type: 'Microsoft.Synapse/workspaces/sparkJobDefinitions',
      properties: { jobProperties },
    });
    assert.throws(() => load(template({}, [job({})])), /needs properties\.jobProperties\.file/);
    assert.equal(load(template({}, [job({ file: 'abfss://x' })])).artifacts.length, 1);
  });
});

describe('template: exported string defaults', () => {
  it('warns when a string default was exported as another JSON type', () => {
    const text = template({}, [
      pipeline('pl', {
        parameters: {
          arr: { type: 'string', defaultValue: [1, 2, 3] },
          num: { type: 'String', defaultValue: 4 },
          ok: { type: 'string', defaultValue: '[1, 2, 3]' },
          real: { type: 'array', defaultValue: [1] },
          none: { type: 'string' },
        },
        variables: { v: { type: 'string', defaultValue: { a: 1 } } },
      }),
    ]);
    const { output } = load(text);
    const warnings = output.split('\n').filter((line) => line.startsWith('::warning'));
    assert.equal(warnings.length, 3);
    assert.ok(warnings.every((line) => line.startsWith('::warning title=pipelines/pl::')));
    assert.match(
      warnings[0] ?? '',
      /properties\.parameters\.arr\.defaultValue: The export changed this string default to an array/,
    );
    assert.match(warnings[1] ?? '', /properties\.parameters\.num\.defaultValue.*to an integer/);
    assert.match(warnings[2] ?? '', /properties\.variables\.v\.defaultValue.*to an object/);
    assert.match(warnings[0] ?? '', /Change the default in Studio/);
  });
});

describe('template: review fixes', () => {
  it('reports every parameter problem in one message', () => {
    const text = template({ p: { type: 'int' }, q: { type: 'securestring' } }, []);
    assert.throws(
      () =>
        load(text, {
          parameterFiles: [
            {
              name: 'a.json',
              text: JSON.stringify({
                parameters: { nope: { value: 1 }, p: 'x', q: { reference: { secretName: 's' } } },
              }),
            },
          ],
          overrides: [{ name: 'p', value: 'abc' }],
        }),
      (error: Error) =>
        error.message.startsWith('The parameters cannot be used:') &&
        error.message.includes('sets nope, which the template does not declare') &&
        error.message.includes('Parameter p in a.json must be {"value": ...}') &&
        error.message.includes('Parameter q in a.json is a Key Vault reference') &&
        error.message.includes('Parameter p is declared int'),
    );
  });

  it('masks a supplied secure value even when a default then fails', () => {
    const text = template(
      { s: { type: 'securestring' }, bad: { type: 'string', defaultValue: "[parameters('zzz')]" } },
      [],
    );
    const written: string[] = [];
    assert.throws(() =>
      quietly(
        () =>
          evaluateTemplate({
            workspaceName: 'myworkspace',
            templateText: text,
            overrides: [{ name: 's', value: 'top-secret' }],
          }),
        written,
      ),
    );
    assert.match(written.join(''), /::add-mask::top-secret/);
  });

  it('includes the value in the string-default warning, truncated, but not a secret one', () => {
    const long = 'x'.repeat(150);
    const text = template({ s: { type: 'securestring' } }, [
      pipeline('pl', {
        parameters: {
          a: { type: 'string', defaultValue: [long] },
          b: { type: 'string', defaultValue: ["[parameters('s')]"] },
        },
      }),
    ]);
    const { output } = load(text, { overrides: [{ name: 's', value: 'hush-hush' }] });
    const warnings = output.split('\n').filter((line) => line.startsWith('::warning'));
    assert.equal(warnings.length, 2);
    assert.ok((warnings[0] ?? '').includes(`(value: ["${'x'.repeat(98)}...)`));
    assert.ok(!(warnings[1] ?? '').includes('value:'));
    assert.ok(!(warnings[1] ?? '').includes('hush-hush'));
  });

  it('allows resourceId in names and dependsOn only', () => {
    const ok = template({}, [
      pipeline('pl', {}, [
        "[resourceId('Microsoft.Synapse/workspaces/notebooks', parameters('workspaceName'), 'nb')]",
      ]),
    ]);
    assert.deepEqual(load(ok).artifacts[0]?.dependsOn, ['notebooks/nb']);
    const bad = template({}, [
      pipeline('pl', { v: "[resourceId('Microsoft.Synapse/workspaces/notebooks', 'ws', 'nb')]" }),
    ]);
    assert.throws(
      () => load(bad),
      /properties\.v: .*only supported in a resource name and in dependsOn/,
    );
  });

  it('does not reuse a variable accepted in dependsOn for a property', () => {
    const rid = "[resourceId('Microsoft.Synapse/workspaces/notebooks', 'ws', 'nb')]";
    const user = pipeline('first', {}, ["[variables('rid')]"]);
    const other = pipeline('second', { v: "[variables('rid')]" });
    const text = template({}, [user, other], { rid });
    assert.throws(
      () => load(text),
      /second.*properties\.v: .*only supported in a resource name and in dependsOn/s,
    );
    assert.throws(() => load(template({}, [other, user], { rid })), /properties\.v/);
  });

  it('labels an error with the evaluated resource name', () => {
    const text = template({}, [pipeline('pl_named', { v: "[parameters('nope')]" })]);
    assert.throws(() => load(text), /resources\[0\] pl_named|resources\[0\] myworkspace\/pl_named/);
  });
});

describe('template: loadTemplate', () => {
  const dir = join(import.meta.dirname, 'fixtures', 'templates', 'types');

  it('reads the template and parameter files', async () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    };
    try {
      const { artifacts } = await loadTemplate({
        workspaceName: 'myworkspace',
        templateFile: join(dir, 'template.json'),
        parameterFiles: [join(dir, 'parameters.json')],
        parameters: [{ name: 'p_int', value: '9' }],
      });
      assert.equal((body(artifacts)['typeProperties'] as Obj)['count'], 9);
    } finally {
      process.stdout.write = original;
    }
  });

  it('names a file that cannot be read', async () => {
    await assert.rejects(
      loadTemplate({
        workspaceName: 'myworkspace',
        templateFile: join(dir, 'missing.json'),
        parameterFiles: [],
        parameters: [],
      }),
      /Cannot read the template file .*missing\.json.*Check the path/,
    );
  });
});
