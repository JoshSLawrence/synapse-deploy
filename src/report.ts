import { appendFile } from 'node:fs/promises';
import * as core from '@actions/core';

export interface Counts {
  deployed: number;
  skipped: number;
  deleted: number;
}

export type Section = 'deploy' | 'skip' | 'delete';

/** One line of the job summary. */
export interface Row {
  section: Section;
  artifact: string;
  outcome: string;
  detail: string;
}

export interface SummaryData {
  dryRun: boolean;
  /** The run's one-line verdict, such as the failure message; empty when green. */
  verdict: string;
  counts: Counts;
  rows: readonly Row[];
  /** Lake database tables and relationships deleted (or to be); not part of `counts`. */
  lakeChildren?: number;
}

/** Longer tables are cut here; GitHub limits a job summary to 1 MiB. */
export const MAX_SUMMARY_ROWS = 1_000;

// Service messages can be long; 1,000 rows of them must stay under that limit.
const MAX_CELL_CHARS = 300;

const SECTION_TITLES: Record<Section, string> = {
  deploy: 'Deploy',
  skip: 'Skipped',
  delete: 'Delete',
};

export function logDeployed(label: string, ms: number): void {
  core.info(`deployed ${label} (${(ms / 1000).toFixed(1)} s)`);
}

export function logSkipped(label: string, reason: string): void {
  core.info(`skipped ${label} (${reason})`);
}

export function logDeleted(label: string, ms: number): void {
  core.info(`deleted ${label} (${(ms / 1000).toFixed(1)} s)`);
}

export function logFailed(label: string, message: string): void {
  core.info(`failed ${label}: ${message}`);
  core.error(message, { title: label });
}

export function setOutputs(counts: Counts): void {
  core.setOutput('deployed', counts.deployed);
  core.setOutput('skipped', counts.skipped);
  core.setOutput('deleted', counts.deleted);
}

// The summary is markdown, and artifact names and service messages are
// free text: keep them from breaking the table or injecting markup.
function cell(text: string): string {
  const short = text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}...` : text;
  return short
    .replace(/\\/g, '\\\\')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/`/g, "'")
    .replace(/\r?\n/g, ' ');
}

export function summaryMarkdown(data: SummaryData): string {
  const { counts } = data;
  const lines = [
    `## Synapse deploy${data.dryRun ? ' (dry run)' : ''}`,
    '',
    (data.dryRun
      ? `Would deploy ${counts.deployed}, skip ${counts.skipped} and delete ${counts.deleted}`
      : `Deployed ${counts.deployed}, skipped ${counts.skipped} and deleted ${counts.deleted}`) +
      (data.lakeChildren
        ? ` (and ${data.lakeChildren} lake database tables or relationships)`
        : '') +
      '.',
    '',
  ];
  if (data.verdict) {
    lines.push(`**${cell(data.verdict)}**`, '');
  }
  let remaining = MAX_SUMMARY_ROWS;
  let trimmed = 0;
  for (const section of ['deploy', 'skip', 'delete'] as const) {
    const rows = data.rows.filter((row) => row.section === section);
    if (rows.length === 0) {
      continue;
    }
    const shown = rows.slice(0, Math.max(remaining, 0));
    remaining -= shown.length;
    trimmed += rows.length - shown.length;
    lines.push(`### ${SECTION_TITLES[section]} (${rows.length})`, '');
    lines.push('| Artifact | Outcome | Detail |', '| --- | --- | --- |');
    for (const row of shown) {
      lines.push(`| ${cell(row.artifact)} | ${cell(row.outcome)} | ${cell(row.detail)} |`);
    }
    lines.push('');
  }
  if (trimmed > 0) {
    lines.push(`${trimmed} more row(s) are not shown; the job log has every artifact.`, '');
  }
  return lines.join('\n');
}

/**
 * Appends the summary to the job summary file. Outside a runner (no
 * GITHUB_STEP_SUMMARY) there is nowhere to write it; a failure to write is a
 * warning, because it must not turn a finished deployment red.
 */
export async function writeSummary(data: SummaryData): Promise<void> {
  const file = process.env['GITHUB_STEP_SUMMARY'];
  if (!file) {
    core.debug('GITHUB_STEP_SUMMARY is not set; the job summary is skipped');
    return;
  }
  try {
    await appendFile(file, summaryMarkdown(data) + '\n');
  } catch (error) {
    core.warning(`Could not write the job summary: ${(error as Error).message}`);
  }
}
