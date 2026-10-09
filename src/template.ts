// Portions derived from Azure/Synapse-workspace-deployment.
// Copyright (c) Microsoft Corporation. Licensed under the MIT License.

import { readFile } from 'node:fs/promises';
import * as core from '@actions/core';
import { isServiceDefault, remapDefaultReferences, remapDefaultName } from './defaults.ts';
import { evaluateString, ExpressionError, jsonTypeName } from './expression.ts';
import type { EvalContext, Json, JsonObject } from './expression.ts';
import type { Inputs, ParameterOverride } from './inputs.ts';
import { kindForCollection, kindForTemplateType, unsupportedTypeMessage } from './kinds.ts';
import type { Kind, KindId } from './kinds.ts';
import { mask } from './mask.ts';

export const SKIP_DEFAULT = 'service default';
export const SKIP_INFRASTRUCTURE = 'left to infrastructure as code';

/** One deployable (or deliberately skipped) resource of the template. */
export interface Artifact {
  /** `<kind id>/<lowercased name>`: how artifacts refer to one another. */
  key: string;
  kind: Kind;
  /** The last segment of the evaluated resource name. */
  name: string;
  /** The resource `type` as the template wrote it. */
  type: string;
  /** What is sent to the workspace: the evaluated resource, named by `name`. */
  body: JsonObject;
  /** Keys of the resources this one depends on (the workspace itself is left out). */
  dependsOn: string[];
  /** Why the artifact is not deployed, when it is not. */
  skip?: string;
}

export interface EvaluatedTemplate {
  artifacts: Artifact[];
}

export interface TemplateSource {
  workspaceName: string;
  /** The template file's text. `templateFile` names it in messages. */
  templateText: string;
  templateFile?: string;
  parameterFiles?: { name: string; text: string }[];
  overrides?: ParameterOverride[];
}

export function artifactKey(kind: KindId, name: string): string {
  return `${kind}/${name.toLowerCase()}`;
}

const TYPE_PREFIX = 'microsoft.synapse/workspaces/';
const SECURE_TYPES: ReadonlySet<string> = new Set(['securestring', 'secureobject']);

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON (${(error as Error).message}); check the file or re-export it.`,
      { cause: error },
    );
  }
}

interface Declared {
  name: string;
  type: string;
  hasDefault: boolean;
  defaultValue: Json;
}

function declaredParameters(template: JsonObject): Map<string, Declared> {
  const declared = new Map<string, Declared>();
  const section = template['parameters'];
  if (section === undefined) {
    return declared;
  }
  if (!isObject(section)) {
    throw new Error('The template\'s "parameters" must be an object.');
  }
  for (const [name, definition] of Object.entries(section)) {
    const def = isObject(definition) ? definition : {};
    declared.set(name.toLowerCase(), {
      name,
      type: typeof def['type'] === 'string' ? def['type'].toLowerCase() : 'string',
      hasDefault: Object.hasOwn(def, 'defaultValue'),
      defaultValue: def['defaultValue'] ?? null,
    });
  }
  return declared;
}

function declaredList(declared: Map<string, Declared>): string {
  const names = [...declared.values()].map((entry) => entry.name);
  const shown = names.slice(0, 20).join(', ');
  return names.length > 20 ? `${shown}, and ${names.length - 20} more` : shown;
}

/** A `parameters` line, typed by the template's declared type. The value is never echoed: it may be secret. */
function typedOverride(declared: Declared, raw: string): Json {
  const bad = (expected: string): never => {
    throw new Error(
      `Parameter ${declared.name} is declared ${declared.type}, but the value in the parameters input is not ${expected}. ` +
        'Fix the value on its name=value line.',
    );
  };
  switch (declared.type) {
    case 'int':
      return /^\s*-?[0-9]+\s*$/.test(raw) && Number.isSafeInteger(Number(raw))
        ? Number(raw)
        : bad('an integer');
    case 'bool': {
      const text = raw.trim();
      return text === 'true' ? true : text === 'false' ? false : bad('true or false');
    }
    case 'object':
    case 'secureobject':
    case 'array': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return bad('valid JSON');
      }
      const isArray = Array.isArray(parsed);
      if (declared.type === 'array' ? !isArray : !isObject(parsed)) {
        return bad(declared.type === 'array' ? 'a JSON array' : 'a JSON object');
      }
      return parsed as Json;
    }
    default:
      return raw;
  }
}

function secureLeaves(value: Json, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => secureLeaves(item, out));
  } else if (value !== null && typeof value === 'object') {
    Object.values(value).forEach((item) => secureLeaves(item, out));
  }
  return out;
}

/** Parameters and variables, evaluated lazily and cycle-safe. */
class Scope implements EvalContext {
  private readonly declared: Map<string, Declared>;
  private readonly resolving: string[] = [];
  private readonly variables = new Map<string, { name: string; raw: Json }>();
  private readonly supplied = new Map<string, Json>();
  private readonly cache = new Map<string, Json>();

  constructor(declared: Map<string, Declared>, variables: unknown) {
    this.declared = declared;
    if (isObject(variables)) {
      for (const [name, raw] of Object.entries(variables)) {
        this.variables.set(name.toLowerCase(), { name, raw });
      }
    }
  }

  /** String leaves of secure parameters: masked, and kept out of warnings. */
  readonly secrets = new Set<string>();
  allowResourceId = false;

  maskSecure(value: Json): void {
    for (const leaf of secureLeaves(value)) {
      if (!this.secrets.has(leaf) && mask(leaf)) {
        this.secrets.add(leaf);
      }
    }
  }

  /** Runs `action` with resourceId allowed: only names and dependsOn may use it. */
  withResourceId<T>(action: () => T): T {
    this.allowResourceId = true;
    try {
      return action();
    } finally {
      this.allowResourceId = false;
    }
  }

  supply(name: string, value: Json): void {
    this.supplied.set(name.toLowerCase(), value);
  }

  isSupplied(name: string): boolean {
    return this.supplied.has(name.toLowerCase());
  }

  suppliedValue(name: string): Json | undefined {
    return this.supplied.get(name.toLowerCase());
  }

  parameter(name: string): Json {
    const key = name.toLowerCase();
    const supplied = this.supplied.get(key);
    if (supplied !== undefined) {
      return supplied;
    }
    const declared = this.declared.get(key);
    if (!declared) {
      throw new ExpressionError(
        `the template declares no parameter ${name} (declared: ${declaredList(this.declared)}).`,
      );
    }
    if (!declared.hasDefault) {
      throw new ExpressionError(
        `parameter ${declared.name} has no value and no default; set it in a parameters file or the parameters input.`,
      );
    }
    return this.once(`parameters('${declared.name}')`, key, () => this.deep(declared.defaultValue));
  }

  variable(name: string): Json {
    const key = name.toLowerCase();
    const variable = this.variables.get(key);
    if (!variable) {
      throw new ExpressionError(`the template declares no variable ${name}.`);
    }
    return this.once(`variables('${variable.name}')`, `v:${key}`, () => this.deep(variable.raw));
  }

  private once(label: string, key: string, compute: () => Json): Json {
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    if (this.resolving.includes(key)) {
      throw new ExpressionError(
        `${label} refers to itself (${[...this.resolving, key].join(' -> ')}).`,
      );
    }
    this.resolving.push(key);
    try {
      const value = compute();
      this.cache.set(key, value);
      return value;
    } finally {
      this.resolving.pop();
    }
  }

  /** Evaluates every string value; object keys are never evaluated. */
  deep(value: Json): Json {
    if (typeof value === 'string') {
      return evaluateString(value, this);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.deep(item));
    }
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.deep(item)]));
    }
    return value;
  }
}

/** Like Scope.deep, but an error names the JSON path it came from. */
function evaluateAt(scope: Scope, value: Json, path: string): Json {
  if (typeof value === 'string') {
    try {
      return evaluateString(value, scope);
    } catch (error) {
      if (error instanceof ExpressionError) {
        throw new Error(`${path}: ${error.message}`, { cause: error });
      }
      throw error;
    }
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => evaluateAt(scope, item, `${path}[${index}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, evaluateAt(scope, item, `${path}.${key}`)]),
    );
  }
  return value;
}

function buildScope(source: TemplateSource, template: JsonObject): Scope {
  const declared = declaredParameters(template);
  const scope = new Scope(declared, template['variables']);
  const problems: string[] = [];
  const attempt = (action: () => void): void => {
    try {
      action();
    } catch (error) {
      problems.push((error as Error).message);
    }
  };
  // Mask as soon as a secure value is known, before anything can be logged.
  const supply = (entry: Declared, name: string, value: Json): void => {
    scope.supply(name, value);
    if (SECURE_TYPES.has(entry.type)) {
      scope.maskSecure(value);
    }
  };

  for (const file of source.parameterFiles ?? []) {
    const parsed = parseJson(file.text, `Parameters file ${file.name}`);
    const section = isObject(parsed) ? parsed['parameters'] : undefined;
    if (!isObject(section)) {
      throw new Error(
        `Parameters file ${file.name} has no "parameters" object; use the TemplateParametersForWorkspace.json format.`,
      );
    }
    for (const [name, entry] of Object.entries(section)) {
      attempt(() => {
        const entryDeclared = declared.get(name.toLowerCase());
        if (!entryDeclared) {
          throw new Error(
            `Parameters file ${file.name} sets ${name}, which the template does not declare. ` +
              `Declared: ${declaredList(declared)}.`,
          );
        }
        if (!isObject(entry)) {
          throw new Error(
            `Parameter ${name} in ${file.name} must be {"value": ...}, as in TemplateParametersForWorkspace.json.`,
          );
        }
        if (Object.hasOwn(entry, 'reference')) {
          throw new Error(
            `Parameter ${name} in ${file.name} is a Key Vault reference. ` +
              'Key Vault references only work in ARM deployments; pass the value in the parameters input instead.',
          );
        }
        const value = entry['value'];
        if (value === undefined) {
          throw new Error(`Parameter ${name} in ${file.name} has no "value".`);
        }
        supply(entryDeclared, name, value);
      });
    }
  }

  for (const override of source.overrides ?? []) {
    attempt(() => {
      const entry = declared.get(override.name.toLowerCase());
      if (!entry) {
        throw new Error(
          `The parameters input sets ${override.name}, which the template does not declare. ` +
            `Declared: ${declaredList(declared)}.`,
        );
      }
      supply(entry, override.name, typedOverride(entry, override.value));
    });
  }

  const forced = declared.get('workspacename');
  if (forced) {
    const previous = scope.isSupplied('workspaceName')
      ? scope.suppliedValue('workspaceName')
      : forced.defaultValue;
    if (typeof previous === 'string' && previous !== '' && previous !== source.workspaceName) {
      core.info(
        `Parameter workspaceName is ${previous} in the template inputs; using the workspace-name input ${source.workspaceName}.`,
      );
    }
    scope.supply('workspaceName', source.workspaceName);
  }

  const missing = [...declared.values()].filter(
    (entry) => !scope.isSupplied(entry.name) && !entry.hasDefault,
  );
  if (missing.length > 0) {
    problems.push(
      `No value for parameter(s) ${missing.map((entry) => entry.name).join(', ')}: ` +
        'add them to a parameters file or the parameters input, or give them a default in the template.',
    );
  }
  if (problems.length > 0) {
    throw new Error(`The parameters cannot be used:\n- ${problems.join('\n- ')}`);
  }

  // Evaluate every parameter now, so a bad default fails before any resource.
  for (const entry of declared.values()) {
    let value: Json;
    try {
      value = scope.parameter(entry.name);
    } catch (error) {
      throw new Error(`Parameter ${entry.name}: ${(error as Error).message}`, { cause: error });
    }
    if (SECURE_TYPES.has(entry.type)) {
      scope.maskSecure(value);
    }
  }
  return scope;
}

const DEPENDENCY_HINT =
  'Expected Microsoft.Synapse/workspaces/<workspace>/<collection>/<name> ' +
  '(or .../managedVirtualNetworks/default/managedPrivateEndpoints/<name>).';

/**
 * The key of a `dependsOn` string, or 'workspace' for the workspace itself.
 * Throws when the string is not a Synapse resource reference.
 */
export function parseDependency(text: string): string {
  if (!text.toLowerCase().startsWith(TYPE_PREFIX)) {
    throw new Error(
      `dependsOn entry ${JSON.stringify(text)} is not a Synapse resource. ${DEPENDENCY_HINT}`,
    );
  }
  const rest = text.slice(TYPE_PREFIX.length).split('/');
  if (rest.length === 1) {
    return 'workspace';
  }
  const [, first, second, third, fourth] = rest;
  if (rest.length === 3 && first !== undefined && second !== undefined) {
    const kind = kindForCollection(first);
    if (kind) {
      return artifactKey(kind.id, second);
    }
  }
  if (
    rest.length === 5 &&
    first?.toLowerCase() === 'managedvirtualnetworks' &&
    third?.toLowerCase() === 'managedprivateendpoints' &&
    fourth !== undefined
  ) {
    return artifactKey('managedPrivateEndpoints', fourth);
  }
  throw new Error(`dependsOn entry ${JSON.stringify(text)} is not recognised. ${DEPENDENCY_HINT}`);
}

function resourceName(evaluated: Json): string {
  if (typeof evaluated !== 'string') {
    throw new Error(`name must evaluate to a string, not ${jsonTypeName(evaluated)}.`);
  }
  const segments = evaluated.split('/');
  const ok =
    segments.every((segment) => segment !== '') &&
    (segments.length === 2 || (segments.length === 3 && segments[1]?.toLowerCase() === 'default'));
  if (!ok) {
    throw new Error(
      `name must evaluate to <workspace>/<name> or <workspace>/default/<name>; got ${JSON.stringify(evaluated)}.`,
    );
  }
  return segments[segments.length - 1] ?? '';
}

/** The export turns a JSON-looking string default into JSON; warn, since it can't be repaired here. */
function warnNonStringDefaults(artifact: Artifact, secrets: ReadonlySet<string>): void {
  const properties = artifact.body['properties'];
  if (!isObject(properties)) {
    return;
  }
  for (const section of ['parameters', 'variables']) {
    const entries = properties[section];
    if (!isObject(entries)) {
      continue;
    }
    for (const [name, entry] of Object.entries(entries)) {
      if (
        !isObject(entry) ||
        typeof entry['type'] !== 'string' ||
        entry['type'].toLowerCase() !== 'string'
      ) {
        continue;
      }
      const value = entry['defaultValue'];
      if (value === undefined || typeof value === 'string') {
        continue;
      }
      const shown = JSON.stringify(value);
      const secret = [...secrets].some((leaf) => shown.includes(JSON.stringify(leaf).slice(1, -1)));
      const detail = secret
        ? ''
        : ` (value: ${shown.length > 100 ? `${shown.slice(0, 100)}...` : shown})`;
      core.warning(
        `properties.${section}.${name}.defaultValue: ` +
          `The export changed this string default to ${jsonTypeName(value)}${detail}; Synapse may reject it or use it as that type. ` +
          'Change the default in Studio (for example add a space) or set it at run time.',
        { title: `${artifact.kind.id}/${artifact.name}` },
      );
    }
  }
}

function buildArtifact(
  resource: unknown,
  scope: Scope,
  workspaceName: string,
  info: { name?: string },
): Artifact {
  if (!isObject(resource)) {
    throw new Error('the resource is not an object.');
  }
  const type = resource['type'];
  if (typeof type !== 'string') {
    throw new Error('the resource has no "type".');
  }
  const kind = kindForTemplateType(type);
  if (!kind) {
    throw new Error(unsupportedTypeMessage(type));
  }
  const rawName = resource['name'];
  if (typeof rawName !== 'string') {
    throw new Error('the resource has no "name".');
  }
  const sourceName = resourceName(scope.withResourceId(() => evaluateAt(scope, rawName, 'name')));
  info.name = sourceName;
  const serviceDefault = isServiceDefault(kind.id, sourceName);
  const name = serviceDefault ? remapDefaultName(sourceName, workspaceName) : sourceName;

  const evaluated: JsonObject = {};
  for (const [key, value] of Object.entries(resource)) {
    evaluated[key] =
      key === 'name'
        ? name
        : key === 'dependsOn'
          ? scope.withResourceId(() => evaluateAt(scope, value, key))
          : evaluateAt(scope, value, key);
  }
  const body = remapDefaultReferences(evaluated, workspaceName) as JsonObject;
  if (!Object.hasOwn(body, 'dependsOn')) {
    body['dependsOn'] = [];
  }

  const dependencies = body['dependsOn'];
  if (!Array.isArray(dependencies)) {
    throw new Error('dependsOn must be an array.');
  }
  const dependsOn: string[] = [];
  dependencies.forEach((entry, index) => {
    if (typeof entry !== 'string') {
      throw new Error(`dependsOn[${index}] must evaluate to a string, not ${jsonTypeName(entry)}.`);
    }
    const key = parseDependency(entry);
    if (key !== 'workspace' && !dependsOn.includes(key)) {
      dependsOn.push(key);
    }
  });

  if (kind.id === 'sparkJobDefinitions') {
    const properties = body['properties'];
    const jobProperties = isObject(properties) ? properties['jobProperties'] : undefined;
    const file = isObject(jobProperties) ? jobProperties['file'] : undefined;
    if (typeof file !== 'string' || file === '') {
      throw new Error(
        'a Spark job definition needs properties.jobProperties.file; set the main file in Studio and re-export.',
      );
    }
  }

  const artifact: Artifact = {
    key: artifactKey(kind.id, name),
    kind,
    name,
    type,
    body,
    dependsOn,
  };
  if (serviceDefault) {
    artifact.skip = SKIP_DEFAULT;
  } else if (kind.plane === 'skip') {
    artifact.skip = SKIP_INFRASTRUCTURE;
  }
  return artifact;
}

/** Parses and evaluates the template. Pure apart from masking and warnings. */
export function evaluateTemplate(source: TemplateSource): EvaluatedTemplate {
  const parsed = parseJson(source.templateText, `Template ${source.templateFile ?? 'file'}`);
  if (!isObject(parsed) || !Array.isArray(parsed['resources'])) {
    throw new Error(
      `Template ${source.templateFile ?? 'file'} has no "resources" array; ` +
        'use the TemplateForWorkspace.json that the Synapse export writes.',
    );
  }
  const scope = buildScope(source, parsed);

  const artifacts: Artifact[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];
  (parsed['resources'] as unknown[]).forEach((resource, index) => {
    const info: { name?: string } = {};
    const labelFor = (): string =>
      info.name !== undefined
        ? `resources[${index}] ${info.name}`
        : isObject(resource) && typeof resource['name'] === 'string'
          ? `resources[${index}] ${resource['name']}`
          : `resources[${index}]`;
    try {
      const artifact = buildArtifact(resource, scope, source.workspaceName, info);
      if (seen.has(artifact.key)) {
        throw new Error(`${artifact.key} is defined twice; remove one of the resources.`);
      }
      seen.add(artifact.key);
      artifacts.push(artifact);
    } catch (error) {
      errors.push(`${labelFor()}: ${(error as Error).message}`);
    }
  });
  if (errors.length > 0) {
    throw new Error(`The template cannot be used:\n- ${errors.join('\n- ')}`);
  }
  artifacts.forEach((artifact) => warnNonStringDefaults(artifact, scope.secrets));
  return { artifacts };
}

/** Reads the template and parameter files named by the inputs, then evaluates. */
export async function loadTemplate(
  inputs: Pick<Inputs, 'workspaceName' | 'templateFile' | 'parameterFiles' | 'parameters'>,
): Promise<EvaluatedTemplate> {
  const read = async (file: string, what: string): Promise<string> => {
    try {
      return await readFile(file, 'utf8');
    } catch (error) {
      throw new Error(
        `Cannot read the ${what} ${file}: ${(error as Error).message}. ` +
          'Check the path (relative to the workspace) and that the checkout step ran.',
        { cause: error },
      );
    }
  };
  const parameterFiles = [];
  for (const name of inputs.parameterFiles) {
    parameterFiles.push({ name, text: await read(name, 'parameters file') });
  }
  return evaluateTemplate({
    workspaceName: inputs.workspaceName,
    templateText: await read(inputs.templateFile, 'template file'),
    templateFile: inputs.templateFile,
    parameterFiles,
    overrides: inputs.parameters,
  });
}
