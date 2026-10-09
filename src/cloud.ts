export type CloudName = 'AzureCloud' | 'AzureChinaCloud' | 'AzureUSGovernment';

export interface Cloud {
  name: CloudName;
  /** Entra ID login host, with a trailing slash. */
  login: string;
  /** Azure Resource Manager endpoint, with a trailing slash. */
  arm: string;
  /** Suffix of the workspace development endpoint: https://<workspace>.<suffix>. */
  dataPlaneSuffix: string;
}

const CLOUDS: Record<CloudName, Cloud> = {
  AzureCloud: {
    name: 'AzureCloud',
    login: 'https://login.microsoftonline.com/',
    arm: 'https://management.azure.com/',
    dataPlaneSuffix: 'dev.azuresynapse.net',
  },
  AzureChinaCloud: {
    name: 'AzureChinaCloud',
    login: 'https://login.chinacloudapi.cn/',
    arm: 'https://management.chinacloudapi.cn/',
    dataPlaneSuffix: 'dev.azuresynapse.azure.cn',
  },
  AzureUSGovernment: {
    name: 'AzureUSGovernment',
    login: 'https://login.microsoftonline.us/',
    arm: 'https://management.usgovcloudapi.net/',
    dataPlaneSuffix: 'dev.azuresynapse.usgovcloudapi.net',
  },
};

export const CLOUD_NAMES = Object.keys(CLOUDS) as CloudName[];

/** Matches case-insensitively, as azure/login does. Returns undefined if unknown. */
export function findCloud(value: string): Cloud | undefined {
  const wanted = value.trim().toLowerCase();
  return Object.values(CLOUDS).find((cloud) => cloud.name.toLowerCase() === wanted);
}

export function appendDefaultScope(url: string): string {
  return url.replace(/\/+$/, '') + '/.default';
}

/** The development endpoint of a workspace, without a trailing slash. */
export function dataPlaneUrl(cloud: Cloud, workspace: string): string {
  return `https://${workspace}.${cloud.dataPlaneSuffix}`;
}

/** The scope for data-plane tokens. The host is the suffix itself, as before. */
export function dataPlaneScope(cloud: Cloud): string {
  return appendDefaultScope(`https://${cloud.dataPlaneSuffix}`);
}

export function armScope(cloud: Cloud): string {
  return appendDefaultScope(cloud.arm);
}
