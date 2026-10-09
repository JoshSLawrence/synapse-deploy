import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { armScope, dataPlaneScope, dataPlaneUrl, findCloud } from '../src/cloud.ts';
import type { Cloud } from '../src/cloud.ts';

function cloud(name: string): Cloud {
  const found = findCloud(name);
  assert.ok(found, `${name} is a known cloud`);
  return found;
}

describe('cloud', () => {
  it('finds the clouds by name, ignoring case', () => {
    assert.equal(cloud('AzureCloud').dataPlaneSuffix, 'dev.azuresynapse.net');
    assert.equal(cloud('azurechinacloud').dataPlaneSuffix, 'dev.azuresynapse.azure.cn');
    assert.equal(cloud('AzureUSGovernment').dataPlaneSuffix, 'dev.azuresynapse.usgovcloudapi.net');
    assert.equal(findCloud('Azure Public'), undefined);
  });

  it('builds the workspace endpoint per cloud', () => {
    assert.equal(
      dataPlaneUrl(cloud('AzureCloud'), 'myworkspace'),
      'https://myworkspace.dev.azuresynapse.net',
    );
    assert.equal(
      dataPlaneUrl(cloud('AzureChinaCloud'), 'myworkspace'),
      'https://myworkspace.dev.azuresynapse.azure.cn',
    );
    assert.equal(
      dataPlaneUrl(cloud('AzureUSGovernment'), 'myworkspace'),
      'https://myworkspace.dev.azuresynapse.usgovcloudapi.net',
    );
  });

  it('builds the token scopes per cloud', () => {
    assert.equal(dataPlaneScope(cloud('AzureCloud')), 'https://dev.azuresynapse.net/.default');
    assert.equal(
      dataPlaneScope(cloud('AzureChinaCloud')),
      'https://dev.azuresynapse.azure.cn/.default',
    );
    assert.equal(armScope(cloud('AzureCloud')), 'https://management.azure.com/.default');
    assert.equal(
      armScope(cloud('AzureUSGovernment')),
      'https://management.usgovcloudapi.net/.default',
    );
  });

  it("uses each cloud's own login host", () => {
    assert.equal(cloud('AzureCloud').login, 'https://login.microsoftonline.com/');
    assert.equal(cloud('AzureChinaCloud').login, 'https://login.chinacloudapi.cn/');
    assert.equal(cloud('AzureUSGovernment').login, 'https://login.microsoftonline.us/');
  });
});
