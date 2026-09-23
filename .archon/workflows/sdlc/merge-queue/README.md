# Merge queue

`archon-merge-queue` accepts `prs` (1-5 explicit PR URLs), optional `evidence`,
and `mode=preview|approve|auto`. Assessment freezes the live batch, then fresh
reviews bound to Claude `claude-sonnet-5` and Pi `zai/glm-4.7` inspect that exact
head. This requires configured Claude credentials and Pi's Z.AI credentials. The
native final script verifies their typed verdicts and engine-recorded routing before
it can call GitHub.

Approval covers the recorded batch after both reviews. Auto explicitly authorizes
that batch without a human pause, subject to repository guidance. Processing is
sequential. Missing, failed, stale, duplicate, same-vendor, or mismatched review
evidence refuses the merge. Changed heads, unrelated base movement, unresolved
findings, conflicts and pending checks also hold the remaining work. After a
confirmed merge the remaining batch stops for fresh base validation. The script
publishes `factory/review-anthropic` and `factory/review-zai` only for the verified
head, requires every live check including `factory/runtime`, and uses
`--squash --match-head-commit`; GitHub-native queues remain queued until read-back
confirms merging. No admin bypass is used.

A hold a PR's own next commit can fix is published on that PR as one comment
beginning `<!-- archon-merge-hold -->` (edited in place, cleared when the PR
becomes eligible); the shared review reads it as a claim to settle when a delivery
is re-driven on the branch. Transient holds (pending checks, base movement) stay in
the run's merge-plan.md.

This does not locally synthesize multi-PR commits, alter worktree ownership, or
add an engine API. GitHub branch protection owns atomic server-side merge checks.
The returned `merged` value is a business result, not an inferred engine status.
