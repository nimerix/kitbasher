# Contributing

Pull requests to `main` must pass the **Pull request** checks. They verify the title,
the description, and the release notes.

## Title

Start the title with a type, then a colon and a sentence-case summary with no
period:

```text
feat: Add the Warp tool for closing gaps in scanned parts
fix(drive): Keep Drive connected after a reload
```

| Type       | Use for                             | Version |
| ---------- | ----------------------------------- | ------- |
| `feat`     | A new feature                       | minor   |
| `fix`      | A bug fix                           | patch   |
| `perf`     | A performance improvement           | patch   |
| `docs`     | Documentation only                  | patch   |
| `refactor` | Code changes with the same behavior | patch   |
| `test`     | Tests only                          | patch   |
| `build`    | Build, dependencies, or tooling     | patch   |
| `ci`       | Continuous integration              | patch   |
| `chore`    | Other maintenance                   | patch   |

An optional scope in parentheses, such as `fix(drive):`, narrows the area. Add `!`
after the type, as in `feat!:`, for a breaking change; that is a major version.

## Description

Use the [pull request template](.github/pull_request_template.md). The description
starts with these sections, in this order:

1. `## Summary`: bullets describing what changed and why.
2. `## Testing`: what you ran and what passed, plus anything not tested.
3. `## Release notes`: the template's checklist, with every item checked.

You can add other sections, such as a review log, after the summary.

## Release notes and version

Every pull request adds a release to the documentation's What's new page:

1. Bump the version to match the title type, for example
   `npm version minor --no-git-tag-version` for `feat`. This updates `package.json`
   and `package-lock.json`.
2. Add a release with the same version at the top of `src/docs/changelog.ts`,
   describing what changed for people using Kitbasher.

The check compares against `main`: a `feat` pull request on 1.18.0 must be 1.19.0,
and a `fix` must be 1.18.1. If another pull request merges first, merge `main` and
bump again. See [maintaining the documentation](docs/documentation.md#whats-new)
for the release fields.

## Check locally

```sh
npm test
PR_TITLE="feat: Add pins" PR_BODY_FILE=body.md node scripts/check-pull-request.mjs
PR_TITLE="feat: Add pins" node scripts/check-changelog.mjs origin/main
```
