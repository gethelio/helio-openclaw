import { mapSession } from '../session/mapping.js'
import type {
  ApprovalResolveRequest,
  EvaluateRequest,
  EvaluateResponse,
  HelioClient,
} from '../client/helio-client.js'
import type { CorrelationRegistry } from '../correlation/registry.js'
import type {
  PluginApprovalResolution,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from '../types.js'

export interface BeforeToolCallDeps {
  readonly client: HelioClient
  readonly registry: CorrelationRegistry
  readonly origin: string
}

function blockReasonOf(response: EvaluateResponse): string {
  return response.feedback?.message ?? response.reason ?? 'Blocked by Helio'
}

// Map OpenClaw's approval resolution to Helio's /approval/:id/resolve body (sans resolved_by).
function mapResolution(
  decision: PluginApprovalResolution,
): Pick<ApprovalResolveRequest, 'resolution' | 'scope'> {
  switch (decision) {
    case 'allow-once':
      return { resolution: 'approved', scope: 'once' }
    case 'allow-always':
      return { resolution: 'approved', scope: 'always' }
    case 'deny':
      return { resolution: 'denied' }
    case 'timeout':
      return { resolution: 'timeout' }
    case 'cancelled':
      return { resolution: 'cancelled' }
  }
}

function buildRequest(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext,
  session: string,
): EvaluateRequest {
  const metadata: Record<string, unknown> = {}
  if (ctx.channelId !== undefined) metadata.channel_id = ctx.channelId
  return {
    tool: { name: event.toolName },
    arguments: event.params,
    session_id: session,
    ...(ctx.agentId !== undefined ? { agent_id: ctx.agentId } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  }
}

// before_tool_call → POST /evaluate → decision→result mapping (fail-closed).
export function createBeforeToolCallHook(deps: BeforeToolCallDeps) {
  const { client, registry, origin } = deps

  return async (
    event: PluginHookBeforeToolCallEvent,
    ctx: PluginHookToolContext,
  ): Promise<PluginHookBeforeToolCallResult> => {
    const session = mapSession(ctx)

    const reservation = registry.reserve({
      session,
      toolName: event.toolName,
      ...(event.toolCallId !== undefined ? { toolCallId: event.toolCallId } : {}),
      ...(event.runId !== undefined ? { runId: event.runId } : {}),
    })
    if (!reservation.ok) {
      return { block: true, blockReason: 'Helio cannot correlate ambiguous concurrent tool calls' }
    }

    const outcome = await client.evaluate(buildRequest(event, ctx, session))
    if (!outcome.ok) {
      registry.release(reservation.ticket)
      return { block: true, blockReason: 'Helio governance unavailable' }
    }

    const { response } = outcome
    registry.bind(reservation.ticket, response.evaluation_id)

    switch (response.decision) {
      case 'allow':
        return {}
      case 'deny':
      case 'rate_limited':
      case 'spend_limited':
        registry.release(reservation.ticket)
        return { block: true, blockReason: blockReasonOf(response) }
      case 'dry_run':
        registry.release(reservation.ticket)
        return { block: true, blockReason: `[dry-run] ${blockReasonOf(response)}` }
      case 'require_approval': {
        const { approval } = response
        if (!approval) {
          registry.release(reservation.ticket)
          return {
            block: true,
            blockReason: 'Helio require_approval response missing an approval ticket',
          }
        }
        const resolvedBy = ctx.agentId !== undefined ? `${origin}:${ctx.agentId}` : origin
        return {
          requireApproval: {
            title: `Approve "${event.toolName}"?`,
            description:
              response.feedback?.message ??
              response.reason ??
              'Helio requires approval for this tool call.',
            severity: 'warning',
            timeoutBehavior: 'deny',
            ...(approval.timeout_ms !== undefined ? { timeoutMs: approval.timeout_ms } : {}),
            onResolution: async (decision) => {
              const outcome = await client.resolveApproval(approval.id, {
                ...mapResolution(decision),
                resolved_by: resolvedBy,
              })
              if (!outcome.ok) {
                // Best-effort signal only. The installed OpenClaw runtime invokes onResolution
                // fire-and-forget (`Promise.resolve(onResolution(...)).catch(log.warn)`), so this
                // throw is logged by the host but does NOT gate execution — a failed resolution
                // recording cannot be enforced adapter-side today. See AGENTS.md "Known limitations";
                // tracked as an upstream blocker. The gap still surfaces (host warn log, and later a
                // Helio audit anomaly: approval_unresolved → evaluation_expired).
                throw new Error(`Helio could not record the approval resolution: ${outcome.reason}`)
              }
            },
          },
        }
      }
    }
  }
}
