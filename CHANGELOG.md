# Changelog

All notable changes to `@gethelio/helio-openclaw` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-06-20

### Added

- Initial release of the OpenClaw → Helio governance adapter: a pure translator from OpenClaw
  plugin hooks to Helio sideband HTTP calls, **fail-closed** throughout.
- `before_tool_call` → `POST /evaluate`: enforces allow / deny / rate-limited / spend-limited /
  dry-run / require-approval decisions; native approval cards are resolved via
  `POST /approval/:id/resolve`.
- `after_tool_call` → `POST /audit`: reports execution status with success-only, config-driven
  evidence extraction and a payload budget that always lets the core audit finalize.
- `before_install` → `POST /install-scan`: gates package and skill installs (terminal, fail-closed).
- Fail-closed Helio client with bounded timeouts and Zod-validated responses; unreachable,
  timed-out, or malformed responses block the governed action.
- Correlation registry that binds each `after_tool_call` audit to its `before_tool_call`
  evaluation and fails closed on ambiguous concurrent tool calls.
- Fail-closed degraded mode: invalid configuration or a missing adapter token registers blocking
  hooks rather than skipping registration.
- Tooling: `tsup` build (compiled ESM + type declarations), Vitest (runtime + typecheck), ESLint
  flat config, Prettier; OpenClaw plugin manifest; Apache-2.0 license.

[Unreleased]: https://github.com/gethelio/helio-openclaw/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/gethelio/helio-openclaw/releases/tag/v0.1.0
