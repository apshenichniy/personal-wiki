# Working in personal-wiki

Read `docs/knowledge-base-brief.md` before architecture or implementation work. It distinguishes owner decisions, verified experiments, proposals, and open questions.

## Language

Write repository documentation, issues, pull requests, and code comments in English. Communicate with the owner in Russian.

## Agent skills

### Issue tracker

Use GitHub Issues in `apshenichniy/personal-wiki`. See `docs/agents/issue-tracker.md` for issue and wayfinding operations.

### Domain docs

Use a single-context layout: root `GLOSSARY.md` and `docs/adr/`, created as decisions emerge. See `docs/agents/domain.md`.

## Repository boundary

This public repository holds product code and project documentation. Keep the private knowledge repository, captured sources, credentials, and runtime data outside it. Use synthetic or redistributable fixtures.

## Merge and rebase conflicts

- Always resolve an in-progress merge or rebase conflict. Never run `--abort`.
- Before resolving a hunk, understand both sides through their commit messages, PRs, and original tickets. Preserve both intents where possible; do not invent new behavior.
