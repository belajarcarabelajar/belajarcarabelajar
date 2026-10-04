# Batch Manifest — 2026-10-04-github-profile-restructure

Parent = orchestrator. Repo root `/home/belajarcarabelajar/Proyek/belajarcarabelajar`.
Every chunk below has exactly one owner and a disjoint write scope.

## Write-scope partition (the reason this manifest exists)

`README.md` was originally `files.modify` on T4, T5 and T6 simultaneously — three
tasks writing one file is the overlapping-scope defect the pipeline forbids, and
it would have serialised the whole plan behind a merge queue. `README.md` is now
assembled from eleven fragment files, each owned by exactly one chunk. The parent
is the only writer of `README.md`.

## Wave 1 — foundation (1 chunk, blocking)

| Chunk | Task | Owner | Target files | Expected output | Verification |
|---|---|---|---|---|---|
| C1 | T1 | subagent `general` | `scripts/verify-profile.mjs`, `scripts/verify-profile.test.mjs` | validator CLI + fixtures | `bun test scripts/verify-profile.test.mjs` exit 0 |

## Wave 2 — rules and template (2 chunks, parallel)

| Chunk | Task | Owner | Target files | Expected output | Verification |
|---|---|---|---|---|---|
| C2 | T2 | subagent `general` | `docs/PROFILE-README.template.md` | reusable skeleton | `--section template --target …` exit 0 |
| C3 | T3 | subagent `general` | `scripts/verify-profile.mjs`, `scripts/verify-profile.test.mjs` | eligibility rule + fixtures | `bun test … --rule eligibility` exit 0 |

## Wave 3 — fragments (13 chunks, parallel, all disjoint)

| Chunk | Task | Owner | Target file | Expected output | Verification |
|---|---|---|---|---|---|
| C4 | T4 | subagent | `docs/fragments/10-identity.md` | `# Hi, I'm Iwan` + identity strip | `--target-glob docs/fragments/1*.md` |
| C5 | T4 | subagent | `docs/fragments/15-badges.md` | shields badge row | same |
| C6 | T5 | subagent | `docs/fragments/20-starthere.md` | `## Start Here` | `--target-glob docs/fragments/2*.md` |
| C7 | T5 | subagent | `docs/fragments/21-activity.md` | `## GitHub Activity` | same |
| C8 | T5 | subagent | `docs/fragments/22-blog.md` | `## Latest Posts` | same |
| C9 | T5 | subagent | `docs/fragments/25-what-im-doing.md` | `## What I'm Doing` | same |
| C10 | T5 | subagent | `docs/fragments/26-projects-flagship.md` | `### Flagship Products` | `--target docs/fragments/26-projects-flagship.md` + `--rules` |
| C11 | T5 | subagent | `docs/fragments/27-projects-oss.md` | `### Open Source` | `--target docs/fragments/27-projects-oss.md` + `--rules` |
| C12 | T5 | subagent | `docs/fragments/28-projects-ai.md` | `### AI & Automation` | `--target docs/fragments/28-projects-ai.md` + `--rules` |
| C13 | T5 | subagent | `docs/fragments/29-projects-tools.md` | `### Tools & Distribution` | `--target docs/fragments/29-projects-tools.md` + `--rules` |
| C14 | T6 | subagent | `docs/fragments/30-connect.md` | `## Connect` + 3 sublists | `--target-glob docs/fragments/3*.md` |
| C15 | T6 | subagent | `docs/fragments/35-recognition.md` | `### Recognition` + `### Media` | same |
| C16 | T6 | subagent | `docs/fragments/38-philosophy-facts.md` | `### Philosophy` + Random Facts | same |

## Wave 4 — assembly (parent)

| Chunk | Task | Owner | Target file | Expected output | Verification |
|---|---|---|---|---|---|
| C17 | T7 | parent (orchestrator) | `README.md`, plan file | assembled README, sidebar patch, commit | `bun scripts/verify-profile.mjs --all` exit 0 |

## Chunking note

17 chunks against a floor of 10. The fan-out is not padding: C4–C16 are 13
genuinely independent Markdown sections with disjoint files, and merging them by
hand would have produced one 200-line write with a 13-way conflict surface. Every
chunk fits one subagent's context, so none required a nested fan-out.

## Review checkpoint

After wave 3, the parent re-runs the validator itself and reads `git diff` before
accepting any chunk. No self-reported success is trusted.
