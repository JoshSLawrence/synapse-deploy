/**
 * The ARM template expressions that a Synapse workspace export contains:
 * `parameters`, `variables`, `concat` and `resourceId`. Strings are parsed
 * with a small grammar and evaluated on JSON values; nothing is done as text.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type JsonObject = { [key: string]: Json };

export class ExpressionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExpressionError';
  }
}

/** Where `parameters('x')` and `variables('x')` get their values. */
export interface EvalContext {
  parameter(name: string): Json;
  variable(name: string): Json;
  /** False outside `name` and `dependsOn`, where resourceId is not meaningful. */
  readonly allowResourceId?: boolean;
}

interface CallNode {
  type: 'call';
  name: string;
  args: Node[];
}
interface StringNode {
  type: 'string';
  value: string;
}
interface IntegerNode {
  type: 'integer';
  value: number;
}
type Node = CallNode | StringNode | IntegerNode;

const SUPPORTED_FUNCTIONS: ReadonlySet<string> = new Set([
  'parameters',
  'variables',
  'concat',
  'resourceid',
]);

// A string that opens like a supported call but does not parse is almost
// certainly an export form the grammar misses, so it is an error rather than
// literal text that would silently reach the workspace.
const LOOKS_LIKE_SUPPORTED_CALL = /^\[\s*(parameters|variables|concat|resourceid)\s*\(/i;

class ParseError extends Error {}

class Parser {
  private pos = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  parseAll(): Node {
    const node = this.expression();
    this.skipSpace();
    if (this.pos < this.text.length) {
      throw new ParseError(`unexpected "${this.text.charAt(this.pos)}" at position ${this.pos}`);
    }
    return node;
  }

  private skipSpace(): void {
    while (/\s/.test(this.text.charAt(this.pos)) && this.pos < this.text.length) {
      this.pos += 1;
    }
  }

  private expression(): Node {
    this.skipSpace();
    const ch = this.text.charAt(this.pos);
    if (ch === "'") {
      return this.string();
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      return this.integer();
    }
    if (/[A-Za-z]/.test(ch)) {
      return this.call();
    }
    throw new ParseError(
      this.pos >= this.text.length
        ? 'the expression ends early'
        : `unexpected "${ch}" at position ${this.pos}`,
    );
  }

  private string(): StringNode {
    this.pos += 1;
    let value = '';
    for (;;) {
      if (this.pos >= this.text.length) {
        throw new ParseError('a quoted string is not closed');
      }
      const ch = this.text.charAt(this.pos);
      if (ch === "'") {
        if (this.text.charAt(this.pos + 1) === "'") {
          value += "'";
          this.pos += 2;
          continue;
        }
        this.pos += 1;
        return { type: 'string', value };
      }
      value += ch;
      this.pos += 1;
    }
  }

  private integer(): IntegerNode {
    const match = /^-?[0-9]+/.exec(this.text.slice(this.pos));
    if (!match) {
      throw new ParseError(`unexpected "-" at position ${this.pos}`);
    }
    this.pos += match[0].length;
    const value = Number(match[0]);
    if (!Number.isSafeInteger(value)) {
      throw new ParseError(`the integer ${match[0]} is too large`);
    }
    return { type: 'integer', value };
  }

  private call(): CallNode {
    const match = /^[A-Za-z][A-Za-z0-9]*/.exec(this.text.slice(this.pos));
    const name = match ? match[0] : '';
    this.pos += name.length;
    this.skipSpace();
    if (this.text.charAt(this.pos) !== '(') {
      throw new ParseError(`expected "(" after ${name} at position ${this.pos}`);
    }
    this.pos += 1;
    const args: Node[] = [];
    this.skipSpace();
    if (this.text.charAt(this.pos) === ')') {
      this.pos += 1;
      return { type: 'call', name, args };
    }
    for (;;) {
      args.push(this.expression());
      this.skipSpace();
      const ch = this.text.charAt(this.pos);
      this.pos += 1;
      if (ch === ')') {
        return { type: 'call', name, args };
      }
      if (ch !== ',') {
        throw new ParseError(
          this.pos > this.text.length
            ? `the call to ${name} is not closed`
            : `expected "," or ")" in the call to ${name} at position ${this.pos - 1}`,
        );
      }
    }
  }
}

function unsupportedCall(node: Node): string | undefined {
  if (node.type !== 'call') {
    return undefined;
  }
  if (!SUPPORTED_FUNCTIONS.has(node.name.toLowerCase())) {
    return node.name;
  }
  for (const arg of node.args) {
    const found = unsupportedCall(arg);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

export type Classification =
  | { kind: 'literal' }
  | { kind: 'expression'; node: CallNode }
  | { kind: 'invalid'; reason: string };

/**
 * Sorts a JSON string into one of three rules (design 3.5):
 * an expression to evaluate, text to leave alone, or an error.
 */
export function classify(text: string): Classification {
  if (!text.startsWith('[') || !text.endsWith(']')) {
    return { kind: 'literal' };
  }
  let node: Node;
  try {
    node = new Parser(text.slice(1, -1)).parseAll();
  } catch (error) {
    if (error instanceof ParseError && LOOKS_LIKE_SUPPORTED_CALL.test(text)) {
      return { kind: 'invalid', reason: error.message };
    }
    return { kind: 'literal' };
  }
  if (node.type !== 'call' || !SUPPORTED_FUNCTIONS.has(node.name.toLowerCase())) {
    return { kind: 'literal' };
  }
  const unsupported = unsupportedCall(node);
  if (unsupported !== undefined) {
    return {
      kind: 'invalid',
      reason: `the function ${unsupported} is not supported (supported: parameters, variables, concat, resourceId)`,
    };
  }
  return { kind: 'expression', node };
}

export function jsonTypeName(value: Json | undefined): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  switch (typeof value) {
    case 'string':
      return 'a string';
    case 'number':
      return Number.isInteger(value) ? 'an integer' : 'a number';
    case 'boolean':
      return 'a boolean';
    case 'object':
      return 'an object';
    default:
      return 'undefined';
  }
}

function nameArgument(fn: string, args: Json[]): string {
  const [name] = args;
  if (args.length !== 1 || typeof name !== 'string') {
    throw new ExpressionError(`${fn}() takes one string argument (the name).`);
  }
  return name;
}

function nameSegment(fn: string, index: number, value: Json): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return String(value);
  }
  throw new ExpressionError(
    `${fn}() argument ${index + 1} is ${jsonTypeName(value)}; only strings and integers can be used here.`,
  );
}

function resourceId(args: Json[]): string {
  const [type, ...names] = args;
  if (typeof type !== 'string') {
    throw new ExpressionError('resourceId() takes the resource type as its first argument.');
  }
  const parts = type.split('/');
  const segments = parts.slice(1);
  if (parts.length < 2 ? args.length > 2 : names.length > segments.length) {
    throw new ExpressionError(
      'resourceId() with a leading subscription or resource group argument is not supported. ' +
        'Pass only the resource type and the names.',
    );
  }
  if (parts.length < 2 || names.length !== segments.length) {
    throw new ExpressionError(
      `resourceId('${type}', ...) needs ${segments.length} name(s), one per type segment, and got ${names.length}.`,
    );
  }
  const out = [parts[0] ?? ''];
  segments.forEach((segment, index) => {
    out.push(segment, nameSegment('resourceId', index + 1, names[index] ?? null));
  });
  return out.join('/');
}

function evaluateNode(node: Node, context: EvalContext): Json {
  if (node.type !== 'call') {
    return node.value;
  }
  const args = node.args.map((arg) => evaluateNode(arg, context));
  switch (node.name.toLowerCase()) {
    case 'parameters':
      return structuredClone(context.parameter(nameArgument('parameters', args)));
    case 'variables':
      return structuredClone(context.variable(nameArgument('variables', args)));
    case 'concat':
      if (args.length === 0) {
        throw new ExpressionError('concat() needs at least one argument.');
      }
      return args.map((arg, index) => nameSegment('concat', index, arg)).join('');
    case 'resourceid':
      if (context.allowResourceId === false) {
        throw new ExpressionError(
          'resourceId() is only supported in a resource name and in dependsOn.',
        );
      }
      return resourceId(args);
    default:
      throw new ExpressionError(`the function ${node.name} is not supported.`);
  }
}

const KEEP_LITERAL_HINT =
  'If this text is meant to be literal (for example notebook code), end it with a space or ";" ' +
  'so it is not read as an ARM expression.';

/**
 * A whole-string expression yields its typed value; anything else is returned
 * as it is. Throws an ExpressionError that does not yet name the resource.
 */
export function evaluateString(text: string, context: EvalContext): Json {
  const classified = classify(text);
  if (classified.kind === 'literal') {
    return text;
  }
  if (classified.kind === 'invalid') {
    throw new ExpressionError(
      `cannot evaluate ${JSON.stringify(text)}: ${classified.reason}. ${KEEP_LITERAL_HINT}`,
    );
  }
  try {
    return evaluateNode(classified.node, context);
  } catch (error) {
    if (error instanceof ExpressionError) {
      throw new ExpressionError(`cannot evaluate ${JSON.stringify(text)}: ${error.message}`, {
        cause: error,
      });
    }
    throw error;
  }
}
