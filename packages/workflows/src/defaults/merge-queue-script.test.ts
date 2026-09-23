import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const SCRIPT = join(REPO_ROOT, '.archon/workflows/sdlc/merge-queue/scripts/merge-approved-prs.py');
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const batch = {
  repository: 'owner/repo',
  base: 'main',
  base_sha: BASE,
  prs: [
    {
      repository: 'owner/repo',
      number: 7,
      url: 'https://github.com/owner/repo/pull/7',
      head_sha: SHA,
    },
  ],
};

const verdict = {
  reviews: [
    {
      repository: 'owner/repo',
      number: 7,
      head_sha: SHA,
      ready: true,
      action: 'none',
      findings: '',
    },
  ],
};

function events(zaiProvider = 'pi', zaiModel = 'zai/glm-4.7') {
  return {
    id: 'run-1',
    events: [
      {
        event_type: 'node_started',
        step_name: 'merge__review-anthropic',
        data: { command: 'review-merge-candidate', provider: 'claude', model: 'claude-sonnet' },
      },
      {
        event_type: 'node_completed',
        step_name: 'merge__review-anthropic',
        data: { model_usage: { resolved: 'claude-sonnet' }, structured_output: verdict },
      },
      {
        event_type: 'node_started',
        step_name: 'merge__review-zai',
        data: { command: 'review-merge-candidate', provider: zaiProvider, model: zaiModel },
      },
      {
        event_type: 'node_completed',
        step_name: 'merge__review-zai',
        data: { model_usage: { resolved: zaiModel }, structured_output: verdict },
      },
    ],
  };
}

async function runGate(
  options: {
    anthropic?: object | null;
    zai?: object | null;
    eventPayload?: object;
    base?: string;
    mergeFails?: boolean;
  } = {}
): Promise<{
  exitCode: number;
  output: { merged: boolean; urls: string[]; summary: string };
  merges: number;
}> {
  const root = mkdtempSync(join(tmpdir(), 'archon-merge-gate-'));
  const bin = join(root, 'bin');
  const artifacts = join(root, 'artifacts');
  const log = join(root, 'gh.log');
  mkdirSync(bin);
  writeFileSync(log, '');
  writeFileSync(join(root, 'events.json'), JSON.stringify(options.eventPayload ?? events()));
  writeFileSync(join(bin, 'archon'), `#!/bin/sh\ncat "${join(root, 'events.json')}"\n`);
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
case "$*" in
  *"api repos/owner/repo/branches/main"*) printf '%s\\n' "${options.base ?? BASE}" ;;
  *"pr checks"*) printf '%s\\n' '[{"name":"factory/runtime","bucket":"pass"},{"name":"factory/review-anthropic","bucket":"pass"},{"name":"factory/review-zai","bucket":"pass"}]' ;;
  *"--json state,mergeCommit"*) printf '%s\\n' '{"state":"${options.mergeFails ? 'OPEN' : 'MERGED'}","mergeCommit":{"oid":"c"}}' ;;
  *"pr view"*) printf '%s\\n' '{"number":7,"url":"https://github.com/owner/repo/pull/7","headRefOid":"${SHA}","baseRefName":"main","state":"OPEN","isDraft":false,"isCrossRepository":false,"mergeStateStatus":"CLEAN"}' ;;
  *"pr merge"*) ${options.mergeFails ? 'exit 1' : ':'} ;;
esac
`
  );
  chmodSync(join(bin, 'archon'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);
  try {
    const child = Bun.spawn([PYTHON, SCRIPT], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        GH_LOG: log,
        ARTIFACTS_DIR: artifacts,
        WORKFLOW_ID: 'run-1',
        INPUTS_READY: 'true',
        INPUTS_MODE: 'auto',
        INPUTS_APPROVAL: 'null',
        INPUTS_BATCH: JSON.stringify(batch),
        INPUTS_ANTHROPIC: JSON.stringify(
          options.anthropic === undefined ? verdict : options.anthropic
        ),
        INPUTS_ZAI: JSON.stringify(options.zai === undefined ? verdict : options.zai),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    const calls = readFileSync(log, 'utf-8');
    return {
      exitCode,
      output: JSON.parse(stdout),
      merges: calls.split('\n').filter(call => call.includes('pr merge')).length,
    };
  } finally {
    await removeTempTree(root);
  }
}

describe('dual-vendor merge gate', () => {
  it('merges exactly once only after both nested, vendor-distinct exact-head reviews', async () => {
    const result = await runGate();
    expect(result.exitCode).toBe(0);
    expect(result.output.merged).toBe(true);
    expect(result.merges).toBe(1);
  });

  it('refuses incomplete verdicts, same-vendor provenance, stale heads, and changed bases before merge', async () => {
    const stale = structuredClone(verdict);
    stale.reviews[0]!.head_sha = 'c'.repeat(40);
    for (const options of [
      { anthropic: null },
      { eventPayload: events('claude', 'claude-sonnet') },
      { zai: stale },
      { base: 'd'.repeat(40) },
    ]) {
      const result = await runGate(options);
      expect(result.output.merged).toBe(false);
      expect(result.merges).toBe(0);
    }
  });

  it('does not report a refused match-head write as merged', async () => {
    const result = await runGate({ mergeFails: true });
    expect(result.output.merged).toBe(false);
    expect(result.merges).toBe(1);
  });
});
