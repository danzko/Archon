# Review a frozen merge candidate

Review this exact batch independently. The batch is engine-wired structured data:

`$INPUTS.batch`

Read each PR's current diff, work order, checks and review evidence with `gh` using
the repository in the batch. Do not modify the checkout, publish a GitHub comment,
or read another reviewer's report. A changed head, missing evidence, unresolved
finding, or ambiguity is not ready.

Write your complete human-readable report to `$INPUTS.destination`. Then return
exactly one `reviews` record for every batch PR. Each record must repeat its
`repository`, numeric `number`, full `head_sha`, `ready`, `action` (`none`,
`correct`, or `replan`), and concise `findings`. `ready: true` requires
`action: none`. Do not report a vendor name: the merge boundary verifies routing
from engine events rather than trusting prose.
