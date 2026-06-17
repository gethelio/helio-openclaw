# @gethelio/helio-openclaw

> OpenClaw plugin adapter for [Helio](https://github.com/gethelio/helio) — governs in-process tool calls through Helio's policy sideband.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![npm](https://img.shields.io/npm/v/@gethelio/helio-openclaw.svg)](https://www.npmjs.com/package/@gethelio/helio-openclaw)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](./.nvmrc)

> **Status: pre-release / in active development (`0.1.0`).** The adapter and the Helio
> sideband `evidence` contract it relies on are still being finalized. Not yet recommended
> for production use. Track progress in [Helio issue #11](https://github.com/gethelio/helio/issues/11).

## What this is

Helio is an out-of-process governance proxy for AI agents: an agent cannot reach a tool
except through Helio, which applies operator policy (allow / deny / require-approval /
rate-limit / spend-limit / dry-run) and writes an audit trail.

For MCP agents that enforcement is **structural** (Helio owns the transport). **OpenClaw runs
its tools in-process**, so there is nothing to proxy — instead OpenClaw's **plugin hooks** are
the enforcement point, and this adapter asks Helio for the decision over a local HTTP sideband.
Helio calls this the **`host-enforced`** enforcement grade: it is cooperative, and works only
because this adapter faithfully calls Helio, honors the decision, and reports the outcome.

This package is a **pure translator** — OpenClaw hook ⇄ Helio sideband HTTP. No policy logic
lives here; every decision, limit, approval, and audit record lives in Helio core.

## ⚠️ Fail-closed by design

If the Helio sideband is **unreachable, times out, or returns a 5xx**, this adapter **blocks
the tool call** (`{ block: true }`). This is a deliberate, non-configurable guarantee — it is
what couples tool execution to Helio's liveness, and there is no escape hatch to "proceed on a
failed decision." **A Helio outage will halt tool calls mid-conversation.** For local
development without a Helio proxy, simply do not enable this plugin.

## Install

Install it into your OpenClaw gateway with OpenClaw's plugin installer (it resolves the package
from npm or ClawHub and registers the compiled entry declared by this package's
`openclaw.extensions` field):

```sh
openclaw plugin install @gethelio/helio-openclaw
# no global openclaw CLI on your PATH? run it via npx:
npx openclaw plugin install @gethelio/helio-openclaw
# once published to ClawHub, the clawhub: spec also works:
openclaw plugin install clawhub:@gethelio/helio-openclaw
```

> This is a plugin, not a CLI — it ships no executable, so `npx @gethelio/helio-openclaw` does
> nothing. Use `openclaw plugin install` (above) to register it with a gateway.

**Embedding OpenClaw in your own Node app?** Add it as a dependency instead and let the gateway
auto-discover it on startup via the `openclaw.extensions` manifest field:

```sh
npm install @gethelio/helio-openclaw
# or: pnpm add @gethelio/helio-openclaw
```

`openclaw` itself is a peer dependency, supplied by your gateway.

## Configure

Provide the adapter bearer token via the environment, and point the plugin at your Helio
sideband (defaults shown):

```sh
export HELIO_ADAPTER_TOKEN="<adapter-scope bearer token from Helio>"
```

```jsonc
// plugin config (see openclaw.plugin.json for the full schema)
{
  "helioBaseUrl": "http://127.0.0.1:3200",
  "tokenEnv": "HELIO_ADAPTER_TOKEN",
  "origin": "openclaw",
  "evaluateTimeoutMs": 2000,
}
```

The token is the **adapter-scope** token (`HELIO_ADAPTER_TOKEN`), never the SDK token. The
adapter never sends an `Origin` header (Helio's browser-forgery guard rejects it).

## How it works

| OpenClaw hook      | Helio call           | Result mapping                                                                                                          |
| ------------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `before_tool_call` | `POST /evaluate`     | `allow` → proceed · `deny`/`rate_limited`/`spend_limited`/`dry_run` → block · `require_approval` → native approval card |
| `after_tool_call`  | `POST /audit`        | records the outcome (consumes counters); attaches success-only evidence                                                 |
| `before_install`   | `POST /install-scan` | `deny` → block the install · `allow` → proceed                                                                          |

See [`docs/adapter-api.md`](./docs/adapter-api.md) for the canonical sideband wire contract.

## Development

```sh
pnpm install
pnpm test          # vitest (typecheck against the real SDK types is part of the suite)
pnpm typecheck     # tsc --noEmit
pnpm lint          # eslint (flat config)
pnpm format        # prettier --write
pnpm build         # tsup → dist/ (compiled ESM + .d.ts)
```

## Security

This is a security-governance component. Please report vulnerabilities responsibly — see
[`SECURITY.md`](./SECURITY.md) (forthcoming) rather than opening a public issue.

## License

[Apache-2.0](./LICENSE) © Helio Authors
