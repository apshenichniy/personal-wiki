# Issue tracker: GitHub

Issues, specifications, and wayfinding maps live in GitHub Issues for `apshenichniy/personal-wiki`. Use the `gh` CLI from this checkout; `origin` identifies the repository.

## Conventions

- Create an issue with `gh issue create --title "<title>" --body-file <file>`.
- Read an issue and its discussion with `gh issue view <number> --comments`; fetch structured fields with `--json` when needed.
- List issues with `gh issue list --state open --json number,title,labels,assignees,url`, adding label filters for the current effort.
- Comment with `gh issue comment <number> --body-file <file>`.
- Apply or remove labels with `gh issue edit <number> --add-label "<label>"` or `--remove-label "<label>"`.
- Close an issue with `gh issue close <number>` after recording its resolution.
- Write all ticket content in English. Refer to tickets by linked titles in human-facing output.
- Use a file for multiline bodies so Markdown and literal text survive shell quoting.

When a skill says “publish to the issue tracker,” create a GitHub issue. When it says “fetch the relevant ticket,” read the issue and its comments.

## Implementation delivery

Executable issues are native children of a delivery epic, separate from wayfinder decision tickets. Link each issue's primary scope bag in its body; a bag groups responsibility and can outlive the delivery. Use the native dependency operations below for implementation blockers too.

| Label | Meaning |
| --- | --- |
| `implementation` | Executable work derived from an approved specification. |
| `ready-for-agent` | Specified for AFK execution after native blockers are closed and the run is authorized. |
| `ready-for-human` | Specified work requiring owner participation, such as authentication preparation. |
| `delivery:epic` | Bounded outcome tracking implementation and owner acceptance; not an individual executable task. |

These readiness labels describe the specification, not an override of dependency state. Claim an unassigned implementation issue only after checking its blockers. Complete it with evidence and an integrated revision/PR link. The first-slice delivery epic stays open until its separate owner acceptance check is recorded; automated delivery readiness alone does not close it. See the [first-slice handoff](../plans/first-slice-delivery.md) for task selection and evidence routing.

## Pull requests as a triage surface

**PRs as a request surface: no.**

This flag controls whether external PRs enter the triage queue; it does not restrict normal development PRs.

## Wayfinding operations

The map is an issue labelled `wayfinder:map`. Decision tickets are its native GitHub sub-issues, labelled `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`. Create missing labels when a wayfinding effort first needs them.

- **Parent/child:** obtain the child's numeric database ID with `gh api repos/apshenichniy/personal-wiki/issues/<child-number> --jq .id`. Link it with `gh api --method POST repos/apshenichniy/personal-wiki/issues/<map-number>/sub_issues -F sub_issue_id=<child-database-id>`.
- **Blocking:** use native issue dependencies. Obtain the blocker's database ID, then call `gh api --method POST repos/apshenichniy/personal-wiki/issues/<blocked-number>/dependencies/blocked_by -F issue_id=<blocker-database-id>`. Database IDs differ from issue numbers and GraphQL node IDs.
- **Frontier:** list the map's children with `gh api --paginate repos/apshenichniy/personal-wiki/issues/<map-number>/sub_issues`. Keep open, unassigned children whose `issue_dependencies_summary.blocked_by` is zero. Preserve the map's child order. Fetch missing dependency data before treating a ticket as unblocked.
- **Claim:** assign the chosen ticket to the driving developer before work: `gh issue edit <number> --add-assignee @me`.
- **Resolve:** post a resolution comment, close the ticket, then add a linked gist to the map's Decisions so far. Keep detailed decisions in their tickets.

Use body conventions only if GitHub does not support the native relation: a child task list in the map plus `Part of #<map>` in each child; `Blocked by: #<number>` in blocked tickets. Resolve open blocker state explicitly in that fallback.

Follow the invoked wayfinder skill for map contents, ticket types, session boundaries, and human participation. Setup itself creates no map or decision tickets.
