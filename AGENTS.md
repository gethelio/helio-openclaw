# helio-openclaw — project memory

This repo is **`@gethelio/helio-openclaw`**: the OpenClaw plugin adapter for **Helio**. It is the
implementation of Helio issue **#11**. It is a **standalone repo by design** (not part of
the Helio monorepo) — chosen for the launch/branding story (its own GitHub stars + ClawHub/npm
listing).

## 1. What Helio is, and where this adapter sits

Helio is an **out-of-process governance proxy for AI agents**. Its job: an agent cannot reach a tool
except through Helio, which applies operator policy (allow / deny / require-approval / rate-limit /
spend-limit / dry-run) and writes an audit trail. For MCP agents this is _structural_ (Helio owns
the transport). **OpenClaw runs tools in-process**, so there's nothing to proxy — instead OpenClaw's
**plugin hooks** are the enforcement point and Helio supplies the _decision_ over a local HTTP
sideband. This is the policy-decision-point / policy-enforcement-point split; Helio calls this the
**`host-enforced`** enforcement grade (cooperative — it works only if this adapter faithfully calls
Helio, honors the decision, and reports the outcome).

**This adapter is a pure translator: OpenClaw hook ⇄ Helio sideband HTTP. NO policy logic lives
here.** All decisions, limits, approvals, audit, and evidence live in Helio core.

Helio core is at **v0.5.0**. The sideband governance API it speaks (issue #12), the policy
primitives (#13), and the dashboard (#16) all shipped. The sideband contract is labeled
**experimental** "until a second adapter validates its neutrality" — **this adapter is that second
adapter**, so building it both consumes and validates the contract.

## 2. The contract you build against (read `docs/helio-adapter-api.md` — it is canonical)

Code against the **documented wire contract**, copied into this repo as `docs/helio-adapter-api.md`,
and the real OpenClaw SDK `.d.ts`. **Never import `@gethelio/proxy`** — the only dependency is the
documented HTTP contract.

Sideband: `http://127.0.0.1:3200` (configurable). Auth: `Authorization: Bearer <HELIO_ADAPTER_TOKEN>`
on **every** call. **Never send an `Origin` header** (browser-forgery guard rejects it). Four
endpoints:

- `POST /evaluate` — decide a tool call (side-effect-free on counters). Returns `evaluation_id` +
  `decision`.
- `POST /audit` — record the outcome (consumes counters; idempotent on `evaluation_id`). **Carries
  the optional `evidence` array** (Helio #11 Part A — see §6 status note).
- `POST /install-scan` — evaluate a package/skill install.
- `POST /approval/:id/resolve` — record the resolution of a natively-handled approval.

**Decision → OpenClaw hook-result mapping** (the heart of the adapter):

| Helio `/evaluate` decision                | `before_tool_call` result                                                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `allow`                                   | `{}` (proceed)                                                                                                                                                                             |
| `deny` / `rate_limited` / `spend_limited` | `{ block: true, blockReason }`                                                                                                                                                             |
| `dry_run`                                 | `{ block: true, blockReason: "[dry-run] …" }`                                                                                                                                              |
| `require_approval`                        | `{ requireApproval: { title, description, severity, timeoutMs, timeoutBehavior, onResolution } }` — card text derived **locally**; `onResolution(decision)` → `POST /approval/:id/resolve` |

`after_tool_call` → `POST /audit { evaluation_id, status, result?, error?, duration_ms, evidence? }`.
`before_install` → `POST /install-scan { package: { name, version, source, spec } }`.

**There is no `modify` decision.** OpenClaw's `before_tool_call` result _can_ return `params?`, but
Helio never asks for arg-rewriting — do not use it.

## 3. Verified OpenClaw SDK pre-read (read off `openclaw`'s `.d.ts`)

These were verified statically against `openclaw@2026.5.7` (npm `latest` was `2026.6.8` at plan
time). **Re-verify against the pinned installed version before relying on them** (the package is
peer-installed here):

- **Hook registration: `api.on`, the TYPED method.** `OpenClawPluginApi.on<K extends PluginHookName>(hookName, handler, opts?)`
  is fully typed via `PluginHookHandlerMap[K]`. (`registerHook` exists too but is the untyped
  "native" surface — don't use it.) Confirm exact import specifier, likely
  `import type { … } from 'openclaw/plugin-sdk'`.
- **Event field names are camelCase, identity is on the `ctx` arg, not the event:**
  - `PluginHookBeforeToolCallEvent = { toolName, params, runId?, toolCallId? }`
  - `PluginHookAfterToolCallEvent` adds `{ result?, error?, durationMs? }`
  - `PluginHookToolContext = { agentId?, sessionId?, sessionKey?, runId?, toolName, toolCallId?, … }` ← session/agent identity comes from **here**
  - `PluginHookBeforeToolCallResult = { params?, block?, blockReason?, requireApproval?{ title, description, severity?, timeoutMs?, timeoutBehavior?, onResolution?(decision) } }`
  - Approval resolution enum: `allow-once | allow-always | deny | timeout | cancelled`
  - `PluginHookBeforeInstallEvent = { targetType:"skill"|"plugin", targetName, request{requestedSpecifier?}, plugin?{packageName?,version?}, … }`
- **Manifest/entry:** `package.json` declares the entry via `"openclaw": { "extensions": ["./dist/index.js"] }`;
  `openclaw.plugin.json` = `{ id, activation:{ onStartup:true }, configSchema }`; the entry module
  default-exports `OpenClawPluginDefinition` with `register(api)` (or `activate(api)`).

## 4. Locked design decisions — non-negotiable

1. **Fail-closed, no escape hatch.** If `/evaluate` is unreachable / times out / 5xx → return
   `{ block: true, blockReason: "Helio governance unavailable" }`. There is **no** config option to
   proceed on a failed decision (not even dev-only). This is a normative MUST in the contract. Pair
   with a short bounded `/evaluate` timeout. Do **not** rely on OpenClaw's `failurePolicyByHook`.
2. **Correlation is fail-closed on ambiguity.** Bind `after_tool_call` → `evaluation_id` by a key
   chain: `toolCallId` → `runId` → a **no-ID lane** keyed by `(session, toolName)`. **Only
   `toolCallId` is per-call-unique** (full concurrency). **`runId` is _per-turn_** (shared by every
   tool call in one agent turn), and the no-ID lane is keyed by `(session, toolName)` — so **both
   the `runId` lane and the no-ID lane are fail-closed on ambiguity**: at most one in-flight call per
   key, and a 2nd concurrent call on a non-unique key is **blocked**, not ambiguously bound.
   TTL-evict unclaimed keys. Telemetry on no-ID-lane use + ambiguity blocks.
3. **Evidence is success-only**, attached on `after_tool_call` (`status:"success"`), extracted from
   `event.result` per explicit config (not magic). Helio soft-drops bad entries and still finalizes.
4. **A late `/audit` returning `200 already_finalized` is SUCCESS**, not an error (the decision was
   terminal at `/evaluate`).
5. **Single adapter token** (`HELIO_ADAPTER_TOKEN`); never the SDK token; never `Origin`.

### Known limitations (cooperative `host-enforced` grade)

- **Approval-resolution recording is not enforceable adapter-side.** When `require_approval`
  resolves, the adapter records it via `POST /approval/:id/resolve` inside the hook's
  `onResolution` callback. The installed OpenClaw runtime invokes that callback **fire-and-forget**
  (`notifyPluginApprovalResolution`: `Promise.resolve(onResolution(...)).catch(log.warn)`), so a
  throw/rejection is only **logged** — it does **not** gate execution. If `/approval/:id/resolve`
  fails (sideband down), the tool can still run without Helio recording the resolution. The adapter
  throws to surface it in the host log (best-effort), and it later shows up as a Helio audit anomaly
  (`approval_unresolved` → `evaluation_expired`), but it cannot be **prevented** here. Fixing this
  needs an upstream change (an awaited/​deny-capable approval callback or an alternate gating API).
  **Tracked as an upstream blocker.** Note: this does not affect the `/evaluate` fail-closed
  guarantee (§4.1), which the host _does_ enforce via `block`.

## 5. Conventions & working norms

- **Package manager: pnpm** (matches the Helio org). Strict TypeScript, ESM, `tsup` build → `dist/`.
- **Publish compiled `dist/*.js`** — never source-only (ClawHub rejects TS-only code plugins; OpenClaw
  loads the compiled entry). `package.json` `files`/`prepublishOnly` must guarantee `dist/` is built.
- **TDD is the discipline** (the Helio project uses it): write the failing test first, watch it fail,
  minimal code to pass. Unit-test each hook's translation against the **real SDK event types** (the
  typecheck is part of the test); mock the Helio HTTP client; assert exact request bodies + result
  mappings.
- **Verification before completion:** never claim done without running tests/typecheck and showing
  output. Evidence before assertions.
- **Review round-trips:** the Helio workflow plans → external-agent review → verify findings → amend
  → go-ahead, and reviews implementations against the plan the same way. Expect to produce
  review-prompt artifacts and amend against findings rather than self-certifying.
- **Don't import `@gethelio/proxy`.** Code to `docs/helio-adapter-api.md`.
