# Contributing

## Setup

The [Local development](README.md#local-development) section of the README has the install and
run steps, including the end-to-end run that needs no credentials.

## Before you push

```bash
pnpm check
```

That runs Prettier, ESLint, both tsconfigs, the test suite with coverage thresholds, and the
build. CI runs the same command and needs no secrets, because the tests replace Typefully,
Anthropic, Slack, and Key Value with the fakes in `test/support`.

`pnpm lint:fix` and `pnpm format` fix most of what the first two steps report.

## Conventions

Every network call out of the process runs as a Render Tasks task, so it gets a retry policy and
resumes after a failed run. [docs/tasks.md](docs/tasks.md) lists which task comes from which
package.

Output goes through `src/log.ts` rather than `console`, which is what the `no-console` ESLint rule
enforces. Tests live in `test/`, named after the module they cover.

Coverage thresholds are set in `vitest.config.ts`, just under the suite's current numbers. A change
that drops coverage fails `pnpm check`.

## Commits

Write [Conventional Commits](https://www.conventionalcommits.org): `fix: stop an edit from adding a
second thread marker`. Keep one change per commit. The summary line plus whatever the diff cannot
say is enough; skip the recap.

## Pull requests

CI has to pass. Say in the description whether the change needs a deployment step that code alone
does not cover, such as a new environment variable, a Blueprint apply, or a new Slack scope.
