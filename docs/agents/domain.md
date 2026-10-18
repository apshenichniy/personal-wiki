# Domain documentation

Use a single-context layout for this repository:

- `GLOSSARY.md` at the repository root contains agreed domain vocabulary.
- `docs/adr/` contains architecture decision records.

The planned monorepo does not yet require separate domain contexts. Revisit this layout if independently meaningful contexts emerge, rather than creating one glossary per package.

## Before exploring

Read the root glossary and ADRs relevant to the area being investigated. If a future `GLOSSARY-MAP.md` exists, follow its pointers to relevant contexts.

If these files do not exist, proceed silently. The domain-modeling skill creates them as terms and decisions are resolved; setup does not create placeholder glossaries or ADRs.

## Use the vocabulary

Use agreed glossary terms in issue titles, proposals, code, and tests. The initial terms in `docs/knowledge-base-brief.md` are working definitions until domain modeling resolves them. Surface meaningful gaps for that discussion.

## Conflicting decisions

If a proposal contradicts an ADR, identify the conflicting ADR and explain why reopening it may be justified. Preserve the distinction between an accepted decision and a proposed replacement.
