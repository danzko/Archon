import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const SCRIPT = join(REPO_ROOT, '.archon/workflows/sdlc/merge-queue/scripts/merge-approved-prs.py');
const WORKFLOW = join(REPO_ROOT, '.archon/workflows/sdlc/merge-queue/archon-merge-queue.yaml');
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reviewFieldNames(): readonly string[] {
  const workflow: unknown = Bun.YAML.parse(readFileSync(WORKFLOW, 'utf-8'));
  if (!isRecord(workflow) || !Array.isArray(workflow.nodes)) {
    throw new Error('merge queue workflow is malformed');
  }
  const node = workflow.nodes.find(
    candidate => isRecord(candidate) && candidate.id === 'review-anthropic'
  );
  if (!isRecord(node) || !isRecord(node.output_format)) {
    throw new Error('review-anthropic output_format is missing');
  }
  if (!isRecord(node.output_format.properties)) {
    throw new Error('review output_format properties are missing');
  }
  const reviews = node.output_format.properties.reviews;
  if (!isRecord(reviews) || !isRecord(reviews.items) || !Array.isArray(reviews.items.required)) {
    throw new Error('review output_format is malformed');
  }
  if (!reviews.items.required.every(field => typeof field === 'string')) {
    throw new Error('review output_format required fields are malformed');
  }
  return reviews.items.required;
}

const REVIEW_FIELDS = reviewFieldNames();
const REVIEW_VALUES: Record<string, unknown> = {
  repository: 'owner/repo',
  number: 7,
  head_sha: SHA,
  ready: true,
  action: 'none',
  findings: '',
};

type Verdict = { reviews: Record<string, unknown>[] };

function acceptedVerdict(): Verdict {
  return {
    reviews: [
      Object.fromEntries(
        REVIEW_FIELDS.map(field => {
          if (!(field in REVIEW_VALUES))
            throw new Error(`test has no value for review field '${field}'`);
          return [field, REVIEW_VALUES[field]];
        })
      ),
    ],
  };
}

function batchFor(
  prs = [
    {
      repository: 'owner/repo',
      number: 7,
      url: 'https://github.com/owner/repo/pull/7',
      head_sha: SHA,
    },
  ]
) {
  return { repository: 'owner/repo', base: 'main', base_sha: BASE, prs };
}

function events(verdict = acceptedVerdict()): { id: string; events: Record<string, unknown>[] } {
  return {
    id: 'run-1',
    events: [
      {
        event_type: 'node_started',
        step_name: 'merge__review-anthropic',
        data: { command: 'review-merge-candidate', provider: 'claude', model: 'claude-sonnet-5' },
      },
      {
        event_type: 'node_completed',
        step_name: 'merge__review-anthropic',
        data: {
          model_usage: { requested: 'claude-sonnet-5', resolved: 'claude-sonnet-5' },
          structured_output: verdict,
        },
      },
      {
        event_type: 'node_started',
        step_name: 'merge__review-zai',
        data: { command: 'review-merge-candidate', provider: 'pi', model: 'zai/glm-4.7' },
      },
      {
        event_type: 'node_completed',
        step_name: 'merge__review-zai',
        data: {
          model_usage: { requested: 'zai/glm-4.7', resolved: 'zai/glm-4.7' },
          structured_output: verdict,
        },
      },
    ],
  };
}

function pr(head = SHA, mergeStateStatus = 'CLEAN') {
  return {
    number: 7,
    url: 'https://github.com/owner/repo/pull/7',
    headRefOid: head,
    baseRefName: 'main',
    state: 'OPEN',
    isDraft: false,
    isCrossRepository: false,
    mergeStateStatus,
  };
}

const PASSING_CHECKS = [
  { name: 'factory/runtime', bucket: 'pass' },
  { name: 'factory/review-anthropic', bucket: 'pass' },
  { name: 'factory/review-zai', bucket: 'pass' },
];

async function runGate(
  options: {
    anthropic?: object | null;
    zai?: object | null;
    eventPayload?: object;
    batch?: object;
    base?: string;
    firstPr?: object;
    secondPr?: object;
    checks?: object;
    statusFails?: boolean;
    mergeExit?: number;
    readBackState?: 'MERGED' | 'OPEN';
    mode?: 'auto' | 'approve' | 'preview';
    approval?: string;
  } = {}
): Promise<{
  exitCode: number;
  output: { merged: boolean; urls: string[]; summary: string };
  calls: string[];
  merges: number;
  statuses: number;
}> {
  const root = mkdtempSync(join(tmpdir(), 'archon-merge-gate-'));
  const bin = join(root, 'bin');
  const artifacts = join(root, 'artifacts');
  const log = join(root, 'gh.log');
  mkdirSync(bin);
  writeFileSync(log, '');
  writeFileSync(join(root, 'events.json'), JSON.stringify(options.eventPayload ?? events()));
  writeFileSync(join(root, 'first-pr.json'), JSON.stringify(options.firstPr ?? pr()));
  writeFileSync(join(root, 'second-pr.json'), JSON.stringify(options.secondPr ?? pr()));
  writeFileSync(
    join(root, 'read-back.json'),
    JSON.stringify({ state: options.readBackState ?? 'MERGED', mergeCommit: { oid: 'c' } })
  );
  writeFileSync(join(root, 'checks.json'), JSON.stringify(options.checks ?? PASSING_CHECKS));
  writeFileSync(join(root, 'view-count'), '0');
  writeFileSync(join(bin, 'archon'), `#!/bin/sh\ncat "${join(root, 'events.json')}"\n`);
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
case "$*" in
  *"api repos/owner/repo/branches/main"*) printf '%s\\n' "$GH_BASE" ;;
  *"pr checks"*) cat "$GH_CHECKS" ;;
  *"--json state,mergeCommit"*) cat "$GH_READ_BACK" ;;
  *"pr view"*)
    count=$(cat "$GH_VIEW_COUNT")
    printf '%s' "$((count + 1))" > "$GH_VIEW_COUNT"
    if [ "$count" -eq 0 ]; then cat "$GH_FIRST_PR"; else cat "$GH_SECOND_PR"; fi ;;
  *"statuses/"*) [ "$GH_STATUS_FAILS" = true ] && exit 1; : ;;
  *"pr merge"*) exit "$GH_MERGE_EXIT" ;;
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
        GH_BASE: options.base ?? BASE,
        GH_CHECKS: join(root, 'checks.json'),
        GH_READ_BACK: join(root, 'read-back.json'),
        GH_FIRST_PR: join(root, 'first-pr.json'),
        GH_SECOND_PR: join(root, 'second-pr.json'),
        GH_VIEW_COUNT: join(root, 'view-count'),
        GH_STATUS_FAILS: String(options.statusFails ?? false),
        GH_MERGE_EXIT: String(options.mergeExit ?? 0),
        ARTIFACTS_DIR: artifacts,
        WORKFLOW_ID: 'run-1',
        INPUTS_READY: 'true',
        INPUTS_MODE: options.mode ?? 'auto',
        INPUTS_APPROVAL: options.approval ?? 'null',
        INPUTS_BATCH: JSON.stringify(options.batch ?? batchFor()),
        INPUTS_ANTHROPIC: JSON.stringify(
          options.anthropic === undefined ? acceptedVerdict() : options.anthropic
        ),
        INPUTS_ZAI: JSON.stringify(options.zai === undefined ? acceptedVerdict() : options.zai),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    const calls = readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean);
    return {
      exitCode,
      output: JSON.parse(stdout),
      calls,
      merges: calls.filter(call => call.includes('pr merge')).length,
      statuses: calls.filter(call => call.includes('statuses/')).length,
    };
  } finally {
    await removeTempTree(root);
  }
}

describe('dual-vendor merge gate', () => {
  it('merges only after both exact-head reviews and uses squash', async () => {
    const result = await runGate();
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatchObject({ merged: true, urls: [pr().url] });
    expect(result.merges).toBe(1);
    expect(result.statuses).toBe(2);
    expect(result.calls.find(call => call.includes('pr merge'))).toContain('--squash');
  });

  it('refuses omission of every workflow-required review field before status writes', async () => {
    for (const field of REVIEW_FIELDS) {
      const malformed = acceptedVerdict();
      delete malformed.reviews[0]![field];
      const result = await runGate({ anthropic: malformed });
      expect(result.output.merged).toBe(false);
      expect(result.merges).toBe(0);
      expect(result.statuses).toBe(0);
    }
  });

  it('refuses missing, duplicate, stale, failed, and same-vendor review evidence', async () => {
    const stale = acceptedVerdict();
    stale.reviews[0]!.head_sha = 'c'.repeat(40);
    const duplicate = acceptedVerdict();
    duplicate.reviews.push(structuredClone(duplicate.reviews[0]!));
    const failed = events();
    failed.events.push({
      event_type: 'node_failed',
      step_name: 'merge__review-anthropic',
      data: {},
    });
    const sameVendor = events();
    (sameVendor.events[2]!.data as Record<string, unknown>).provider = 'claude';
    for (const options of [
      { anthropic: null },
      { anthropic: duplicate },
      { zai: stale },
      { eventPayload: failed },
      { eventPayload: sameVendor },
    ]) {
      const result = await runGate(options);
      expect(result.output.merged).toBe(false);
      expect(result.merges).toBe(0);
      expect(result.statuses).toBe(0);
    }
  });

  it('refuses preview, a hold, and malformed approval without writing statuses', async () => {
    for (const options of [
      { mode: 'preview' as const },
      { mode: 'approve' as const, approval: '{"decision":"hold"}' },
      { mode: 'approve' as const, approval: '{' },
    ]) {
      const result = await runGate(options);
      expect(result.output.merged).toBe(false);
      expect(result.merges).toBe(0);
      expect(result.statuses).toBe(0);
    }
  });

  it('publishes verified statuses before requiring protection readiness', async () => {
    const result = await runGate({ firstPr: pr(SHA, 'BLOCKED'), secondPr: pr(SHA, 'CLEAN') });
    expect(result.output.merged).toBe(true);
    expect(result.statuses).toBe(2);
    expect(result.merges).toBe(1);
  });

  it('holds changed heads, persistent protection blockers, and missing or unresolved checks', async () => {
    for (const options of [
      { secondPr: pr('c'.repeat(40)) },
      { firstPr: pr(SHA, 'BLOCKED'), secondPr: pr(SHA, 'BLOCKED') },
      { checks: [] },
      { checks: [...PASSING_CHECKS, { name: 'other', bucket: 'pending' }] },
    ]) {
      const result = await runGate(options);
      expect(result.output.merged).toBe(false);
      expect(result.merges).toBe(0);
      expect(result.statuses).toBe(2);
    }
  });

  it('refuses when a verified review status cannot be published', async () => {
    const result = await runGate({ statusFails: true });
    expect(result.output.merged).toBe(false);
    expect(result.merges).toBe(0);
    expect(result.statuses).toBe(1);
  });

  it('treats confirmed read-back as authoritative and queued writes as unmerged', async () => {
    const confirmed = await runGate({ mergeExit: 1, readBackState: 'MERGED' });
    expect(confirmed.output).toMatchObject({ merged: true, urls: [pr().url] });
    const queued = await runGate({ readBackState: 'OPEN' });
    expect(queued.output.merged).toBe(false);
    expect(queued.merges).toBe(1);
  });

  it('stops a multi-PR batch after its first confirmed merge', async () => {
    const reviews = acceptedVerdict();
    reviews.reviews.push({
      repository: 'owner/repo',
      number: 8,
      head_sha: 'd'.repeat(40),
      ready: true,
      action: 'none',
      findings: '',
    });
    const result = await runGate({
      anthropic: reviews,
      zai: reviews,
      eventPayload: events(reviews),
      batch: batchFor([
        { repository: 'owner/repo', number: 7, url: pr().url, head_sha: SHA },
        {
          repository: 'owner/repo',
          number: 8,
          url: 'https://github.com/owner/repo/pull/8',
          head_sha: 'd'.repeat(40),
        },
      ]),
    });
    expect(result.output).toMatchObject({ merged: false, urls: [pr().url] });
    expect(result.merges).toBe(1);
  });
});
