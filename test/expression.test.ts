import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classify, evaluateString, ExpressionError } from '../src/expression.ts';
import type { EvalContext, Json } from '../src/expression.ts';

const parameters: Record<string, Json> = {
  workspaceName: 'myworkspace',
  count: 7,
  flag: true,
  obj: { a: 1 },
  arr: [1, 2],
  text: '45.0',
};
const variables: Record<string, Json> = { workspaceId: 'Microsoft.Synapse/workspaces/myworkspace' };

const context: EvalContext = {
  parameter(name) {
    const found = Object.entries(parameters).find(
      ([key]) => key.toLowerCase() === name.toLowerCase(),
    );
    if (!found) throw new ExpressionError(`unknown parameter ${name}`);
    return found[1];
  },
  variable(name) {
    const value = variables[name];
    if (value === undefined) throw new ExpressionError(`unknown variable ${name}`);
    return value;
  },
};

const evaluate = (text: string) => evaluateString(text, context);

describe('expression: strings that stay literal', () => {
  for (const text of [
    '[x]',
    '[[x]',
    '[dbo].[t]',
    '[1, 2, 3]',
    '[print(x) for x in xs]',
    '[f(x) for x in y]',
    'SELECT [name] FROM [dbo].[t]',
    "name = parameters('workspaceName')",
    "[string('a')]",
    '',
    '[',
  ]) {
    it(`${JSON.stringify(text)}`, () => {
      assert.deepEqual(classify(text), { kind: 'literal' });
      assert.equal(evaluate(text), text);
    });
  }
});

describe('expression: evaluation', () => {
  it('evaluates parameters, variables and concat', () => {
    assert.equal(evaluate("[parameters('workspaceName')]"), 'myworkspace');
    assert.equal(
      evaluate("[variables('workspaceId')]"),
      'Microsoft.Synapse/workspaces/myworkspace',
    );
    assert.equal(evaluate("[concat(parameters('workspaceName'), '/pl')]"), 'myworkspace/pl');
  });

  it('keeps the type of a whole-string expression', () => {
    assert.equal(evaluate("[parameters('count')]"), 7);
    assert.equal(evaluate("[parameters('flag')]"), true);
    assert.deepEqual(evaluate("[parameters('obj')]"), { a: 1 });
    assert.deepEqual(evaluate("[parameters('arr')]"), [1, 2]);
    assert.equal(evaluate("[parameters('text')]"), '45.0');
  });

  it('copies object values so callers cannot change a parameter', () => {
    const first = evaluate("[parameters('obj')]") as { a: number };
    first.a = 99;
    assert.deepEqual(evaluate("[parameters('obj')]"), { a: 1 });
  });

  it('is case-insensitive about function names', () => {
    assert.equal(evaluate("[CONCAT(Parameters('workspaceName'), '/x')]"), 'myworkspace/x');
  });

  it('allows whitespace between tokens', () => {
    assert.equal(evaluate("[ concat( 'a' , 'b' ) ]"), 'ab');
    assert.equal(evaluate("[concat ('a',\n'b')]"), 'ab');
  });

  it('keeps commas and doubled quotes in literals', () => {
    assert.equal(evaluate("[concat('a, b', ' | ', 'it''s, ok')]"), "a, b | it's, ok");
    assert.equal(evaluate("[concat('''')]"), "'");
    assert.equal(evaluate("[concat('x', ',', 'y')]"), 'x,y');
  });

  it('joins integers as decimals', () => {
    assert.equal(evaluate("[concat('v', 12, -3, parameters('count'))]"), 'v12-37');
  });

  it('builds resource ids from a type and names', () => {
    assert.equal(
      evaluate(
        "[resourceId('Microsoft.Synapse/workspaces/pipelines', parameters('workspaceName'), 'pl')]",
      ),
      'Microsoft.Synapse/workspaces/myworkspace/pipelines/pl',
    );
    assert.equal(
      evaluate(
        "[resourceId('Microsoft.Synapse/workspaces/managedVirtualNetworks/managedPrivateEndpoints', 'ws', 'default', 'pe')]",
      ),
      'Microsoft.Synapse/workspaces/ws/managedVirtualNetworks/default/managedPrivateEndpoints/pe',
    );
  });
});

describe('expression: failures', () => {
  it('fails a malformed supported-function string with an actionable message', () => {
    for (const text of [
      "[concat('a', string(1))]",
      "[parameters('x').y]",
      "[concat('a', ]",
      "[concat('a)]",
      "[parameters('a')] and [parameters('b')]",
      '[concat(a) for a in x]',
    ]) {
      assert.equal(classify(text).kind, 'invalid', text);
      assert.throws(
        () => evaluate(text),
        (error: Error) =>
          error instanceof ExpressionError &&
          error.message.includes(text) &&
          error.message.includes('end it with a space or ";"'),
        text,
      );
    }
  });

  it('names the unsupported function', () => {
    assert.throws(() => evaluate("[concat('a', string(1))]"), /string is not supported/);
  });

  it('fails concat of anything but strings and integers', () => {
    assert.throws(() => evaluate("[concat('a', parameters('obj'))]"), /argument 2 is an object/);
    assert.throws(() => evaluate("[concat(parameters('arr'))]"), /is an array/);
    assert.throws(() => evaluate("[concat(parameters('flag'))]"), /is a boolean/);
    assert.throws(() => evaluate('[concat()]'), /at least one argument/);
  });

  it('fails an unknown parameter or variable, naming the expression', () => {
    assert.throws(
      () => evaluate("[parameters('nope')]"),
      /parameters\('nope'\).*unknown parameter nope/,
    );
    assert.throws(() => evaluate("[variables('nope')]"), /unknown variable nope/);
  });

  it('fails resourceId with the wrong number of names', () => {
    assert.throws(
      () => evaluate("[resourceId('Microsoft.Synapse/workspaces/pipelines', 'ws')]"),
      /needs 2 name\(s\).*got 1/,
    );
  });

  it('fails a name argument that is not a string', () => {
    assert.throws(() => evaluate('[parameters(1)]'), /one string argument/);
  });

  it('says a leading subscription or resource group argument is unsupported', () => {
    assert.throws(
      () =>
        evaluate("[resourceId('sub', 'rg', 'Microsoft.Synapse/workspaces/pipelines', 'ws', 'pl')]"),
      /leading subscription or resource group argument is not supported/,
    );
    assert.throws(
      () =>
        evaluate("[resourceId('Microsoft.Synapse/workspaces/pipelines', 'sub', 'rg', 'ws', 'pl')]"),
      /leading subscription or resource group argument is not supported/,
    );
  });

  it('rejects resourceId when the context does not allow it', () => {
    assert.throws(
      () => evaluateString("[resourceId('A/b', 'x')]", { ...context, allowResourceId: false }),
      /only supported in a resource name and in dependsOn/,
    );
  });
});
