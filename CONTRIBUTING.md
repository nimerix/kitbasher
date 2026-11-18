# Contributing

Pull requests to `main` must pass the **Pull request** checks: the title, the
description, and a type check and build.

## Title

Start the title with a type in parentheses, then a space and a sentence-case summary
with no period:

```text
(feat) Add the Warp tool for closing gaps in scanned parts
(fix) Keep Drive connected after a reload
```

| Type       | Use for                             |
| ---------- | ----------------------------------- |
| `feat`     | A new feature                       |
| `fix`      | A bug fix                           |
| `perf`     | A performance improvement           |
| `docs`     | Documentation only                  |
| `refactor` | Code changes with the same behavior |
| `test`     | Tests only                          |
| `build`    | Build, dependencies, or tooling     |
| `ci`       | Continuous integration              |
| `chore`    | Other maintenance                   |

Add `!` after the type, as in `(feat!)`, for a breaking change.

## Description

Use the [pull request template](.github/pull_request_template.md). The description
starts with these sections, in this order:

1. `## Summary`: bullets describing what changed and why.
2. `## Testing`: what you ran and what passed, plus anything not tested.

You can add other sections, such as a review log, after the summary.

## Version and release notes

The app's version is the short hash of the commit it was built from, as GitHub shows
it. Pull requests do not change a version number.

To tell people about a change, add an entry at the top of `src/docs/changelog.ts`. It
appears on the documentation's What's new page and in the workbench's What's new
button with the commit it shipped in, which the build fills in. Entries are optional.
See
[maintaining the documentation](docs/documentation.md#whats-new).

## Check locally

```sh
npm run build
PR_TITLE="(feat) Add pins" PR_BODY_FILE=body.md node scripts/check-pull-request.mjs
```
