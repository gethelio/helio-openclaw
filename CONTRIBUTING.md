# Contributing to @gethelio/helio-openclaw

Thanks for your interest in contributing! This is the OpenClaw plugin adapter for
[Helio](https://github.com/gethelio/helio) — a pure translator between OpenClaw plugin hooks and
Helio's governance sideband.

## Prerequisites

- **Node.js >= 22** — the repo pins a version in [`.nvmrc`](./.nvmrc); run `nvm use` to match.
- **pnpm** — enable via `corepack enable`, or see https://pnpm.io/installation. The pnpm version is
  pinned through the `packageManager` field in `package.json`.

## Getting started

```sh
git clone https://github.com/gethelio/helio-openclaw.git
cd helio-openclaw
pnpm install
```

## Development workflow

`main` is protected — **all changes land through a pull request**; direct pushes are rejected.

```sh
git checkout main && git pull
git checkout -b <type>/<short-description>   # e.g. feat/audit-evidence, docs/readme
# …make your change…
pnpm verify                                  # format + lint + typecheck + test + build
git commit -m "<type>: <summary>"
git push -u origin <branch>
gh pr create --base main
```

A Husky pre-commit hook runs `lint-staged` (ESLint + Prettier) on staged files automatically.

## Standards

- **Test-driven.** Write the failing test first, watch it fail for the right reason, then the
  minimal code to make it pass. Hooks are unit-tested against the real OpenClaw SDK types — the
  typecheck is part of the suite.
- **Conventional commit** subjects (`feat:`, `fix:`, `docs:`, `chore:`, `build:`, `test:`, …).
- **Formatting and linting are enforced**: Prettier (no semicolons, single quotes, width 100) and
  ESLint (typescript-eslint, strict, type-checked). Use `pnpm format` and `pnpm lint:fix`.
- **CI must be green** before a pull request can merge.

## Preserve the design contract

This adapter is a **pure translator** — OpenClaw hook ⇄ Helio sideband HTTP — with **no policy
logic** of its own, and it **fails closed** when Helio is unreachable. Please keep those invariants
intact; see [`docs/adapter-api.md`](./docs/adapter-api.md) for the wire contract and
[`AGENTS.md`](./AGENTS.md) for the non-negotiable design decisions.

## Reporting bugs and vulnerabilities

- Bugs and feature requests → open an [issue](https://github.com/gethelio/helio-openclaw/issues).
- Security vulnerabilities → **do not** open a public issue; follow [`SECURITY.md`](./SECURITY.md).

By contributing, you agree that your contributions are licensed under the project's
[Apache-2.0](./LICENSE) license.
