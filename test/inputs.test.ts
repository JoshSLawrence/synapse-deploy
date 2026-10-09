import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseParameterLines, readInputs } from '../src/inputs.ts';
import type { InputSource } from '../src/inputs.ts';

const ZERO = '00000000-0000-0000-0000-000000000000';

// Mirrors core.getBooleanInput: YAML 1.2 core schema booleans only.
function source(values: Record<string, string>): InputSource {
  return {
    getInput: (name) => values[name] ?? '',
    getBooleanInput: (name) => {
      const value = values[name] ?? '';
      if (['true', 'True', 'TRUE'].includes(value)) return true;
      if (['false', 'False', 'FALSE'].includes(value)) return false;
      throw new TypeError(`Input does not meet YAML 1.2 "Core Schema" specification: ${name}`);
    },
  };
}

const valid = {
  'workspace-name': 'myworkspace',
  'template-file': 'out/TemplateForWorkspace.json',
  'client-id': ZERO,
  'tenant-id': ZERO,
};

function failure(values: Record<string, string>): string {
  try {
    readInputs(source(values));
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  assert.fail('Expected readInputs to throw');
}

describe('readInputs', () => {
  it('reads the minimal oidc configuration and applies the defaults', () => {
    const inputs = readInputs(source(valid));
    assert.equal(inputs.workspaceName, 'myworkspace');
    assert.equal(inputs.templateFile, 'out/TemplateForWorkspace.json');
    assert.deepEqual(inputs.parameterFiles, []);
    assert.deepEqual(inputs.parameters, []);
    assert.equal(inputs.cloud.name, 'AzureCloud');
    assert.equal(inputs.auth, 'oidc');
    assert.equal(inputs.deleteArtifacts, false);
    assert.equal(inputs.deployManagedPrivateEndpoints, false);
    assert.equal(inputs.dryRun, false);
  });

  it('names a missing workspace-name', () => {
    assert.match(failure({ ...valid, 'workspace-name': '' }), /workspace-name is required/);
  });

  it('names a missing template-file', () => {
    assert.match(failure({ ...valid, 'template-file': ' ' }), /template-file is required/);
  });

  it('accepts valid workspace names', () => {
    for (const name of ['a', 'myworkspace', 'my-workspace-1', '0abc', 'a'.repeat(50)]) {
      assert.equal(readInputs(source({ ...valid, 'workspace-name': name })).workspaceName, name);
    }
  });

  it('rejects workspace names that could change the host', () => {
    const bad = [
      'evil.example/x',
      'a@evil.example',
      'evil.example',
      'a/b',
      'a:443',
      '-abc',
      'abc-',
      'My-Workspace',
      'a b',
      'a'.repeat(51),
    ];
    for (const name of bad) {
      const message = failure({ ...valid, 'workspace-name': name });
      assert.match(message, /Input workspace-name ".*" is not a valid workspace name/, name);
      assert.match(message, /1 to 50 lowercase letters, digits and hyphens/);
    }
  });

  it('splits parameters-file on spaces and newlines', () => {
    const inputs = readInputs(source({ ...valid, 'parameters-file': 'a.json  b.json\nc.json\n' }));
    assert.deepEqual(inputs.parameterFiles, ['a.json', 'b.json', 'c.json']);
  });

  it('matches the cloud case-insensitively', () => {
    assert.equal(
      readInputs(source({ ...valid, cloud: 'azurechinacloud' })).cloud.name,
      'AzureChinaCloud',
    );
    assert.equal(
      readInputs(source({ ...valid, cloud: 'AZUREUSGOVERNMENT' })).cloud.name,
      'AzureUSGovernment',
    );
  });

  it('rejects an unknown cloud and lists the valid ones', () => {
    const message = failure({ ...valid, cloud: 'Azure Public' });
    assert.match(message, /cloud must be one of AzureCloud, AzureChinaCloud, AzureUSGovernment/);
    assert.match(message, /"Azure Public"/);
  });

  it('rejects an unknown auth mode', () => {
    assert.match(
      failure({ ...valid, auth: 'password' }),
      /auth must be one of oidc, client-secret, managed-identity/,
    );
  });

  describe('oidc', () => {
    it('requires client-id and tenant-id', () => {
      assert.match(failure({ ...valid, 'client-id': '' }), /oidc requires the client-id/);
      assert.match(failure({ ...valid, 'tenant-id': '' }), /oidc requires the tenant-id/);
    });

    it('rejects a client-secret and says how to use it', () => {
      assert.match(
        failure({ ...valid, 'client-secret': 'not-a-real-secret' }),
        /set auth: client-secret/,
      );
    });
  });

  describe('client-secret', () => {
    const base = { ...valid, auth: 'client-secret', 'client-secret': 'not-a-real-secret' };

    it('accepts all three', () => {
      assert.equal(readInputs(source(base)).auth, 'client-secret');
    });

    it('requires all three', () => {
      assert.match(
        failure({ ...base, 'client-secret': '' }),
        /client-secret requires the client-secret/,
      );
      assert.match(failure({ ...base, 'client-id': '' }), /client-secret requires the client-id/);
      assert.match(failure({ ...base, 'tenant-id': '' }), /client-secret requires the tenant-id/);
    });
  });

  describe('managed-identity', () => {
    const base = {
      'workspace-name': 'myworkspace',
      'template-file': 't.json',
      auth: 'managed-identity',
    };

    it('needs neither client-id nor tenant-id', () => {
      assert.equal(readInputs(source(base)).auth, 'managed-identity');
    });

    it('ignores tenant-id and accepts a user-assigned client-id', () => {
      const inputs = readInputs(source({ ...base, 'client-id': ZERO, 'tenant-id': ZERO }));
      assert.equal(inputs.clientId, ZERO);
    });

    it('rejects a client-secret', () => {
      assert.match(
        failure({ ...base, 'client-secret': 'not-a-real-secret' }),
        /managed-identity, which takes no secret/,
      );
    });
  });

  describe('booleans', () => {
    it('accepts YAML true and false', () => {
      const inputs = readInputs(
        source({
          ...valid,
          'delete-artifacts': 'true',
          'dry-run': 'True',
          'deploy-managed-private-endpoints': 'false',
        }),
      );
      assert.equal(inputs.deleteArtifacts, true);
      assert.equal(inputs.dryRun, true);
      assert.equal(inputs.deployManagedPrivateEndpoints, false);
    });

    it('fails on anything else, naming the input', () => {
      assert.match(
        failure({ ...valid, 'delete-artifacts': 'yes' }),
        /delete-artifacts must be true or false; got "yes"/,
      );
    });
  });

  describe('masking', () => {
    it('masks the client secret even when validation fails afterwards', () => {
      const written: string[] = [];
      const original = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      };
      try {
        failure({ ...valid, cloud: 'nowhere', 'client-secret': 'not-a-real-secret' });
      } finally {
        process.stdout.write = original;
      }
      assert.ok(written.some((line) => line.includes('::add-mask::not-a-real-secret')));
    });
  });
});

describe('parseParameterLines', () => {
  it('splits on the first = and trims the name only', () => {
    assert.deepEqual(parseParameterLines(' a = b=c \n\nname=\n'), [
      { name: 'a', value: ' b=c ' },
      { name: 'name', value: '' },
    ]);
  });

  it('handles CRLF', () => {
    assert.deepEqual(parseParameterLines('a=1\r\nb=2'), [
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
    ]);
  });

  it('reports a bad line by number without echoing it', () => {
    let message = '';
    try {
      parseParameterLines('a=1\nhunter2-secret-value');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    assert.match(message, /line 2: expected name=value/);
    assert.doesNotMatch(message, /hunter2/);
  });

  it('rejects an empty name', () => {
    assert.throws(() => parseParameterLines('=value'), /line 1/);
  });
});
