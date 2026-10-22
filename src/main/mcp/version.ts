import { version as APP_VERSION } from '../../../package.json'

/**
 * MCP protocol-version negotiation, shared by the three clients (stdio,
 * streamable HTTP, HTTP+SSE).
 *
 * Per the MCP lifecycle rules the client sends the latest version it supports
 * in `initialize`; the server answers with that version if it supports it, or
 * with another version it does support. The client must then either accept the
 * answer (when it's a version the client also speaks) or disconnect.
 *
 * Every version-dependent feature is gated on the NEGOTIATED version, never on
 * the one requested: a 2024-11-05 server must not be sent elicitation replies
 * (the capability doesn't exist there), and the streamable-HTTP
 * `mcp-protocol-version` header carries whatever was agreed.
 */

/** Versions Houston can speak, newest first. Dates compare lexically. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const

export type McpProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number]

/** What Houston requests in `initialize`. */
export const LATEST_PROTOCOL_VERSION: McpProtocolVersion = SUPPORTED_PROTOCOL_VERSIONS[0]

/** The oldest supported version: assumed for a server that omits `protocolVersion`. */
const OLDEST_PROTOCOL_VERSION: McpProtocolVersion =
  SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1]

/** The version elicitation (`elicitation/create`) was introduced in. */
const ELICITATION_SINCE: McpProtocolVersion = '2025-06-18'

/** A server answered `initialize` with a protocol version Houston doesn't speak. */
export class McpUnsupportedProtocolError extends Error {
  constructor(readonly serverVersion: string) {
    super(
      `MCP server requires protocol version ${JSON.stringify(serverVersion)}, which Houston does not support ` +
        `(supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')})`
    )
    this.name = 'McpUnsupportedProtocolError'
  }
}

/**
 * Read the negotiated version out of a server's `initialize` result. Throws
 * McpUnsupportedProtocolError for a version outside the supported list (the
 * caller then tears the connection down). A server that omits the field is
 * non-compliant; it's assumed to speak the oldest version, which disables every
 * newer feature rather than guessing it supports them.
 */
export function negotiatedProtocolVersion(initResult: unknown): McpProtocolVersion {
  const raw =
    initResult && typeof initResult === 'object'
      ? (initResult as { protocolVersion?: unknown }).protocolVersion
      : undefined
  if (raw === undefined || raw === null) return OLDEST_PROTOCOL_VERSION
  const v = typeof raw === 'string' ? raw : String(raw)
  if ((SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(v)) return v as McpProtocolVersion
  throw new McpUnsupportedProtocolError(v.slice(0, 64))
}

/** True when the negotiated version defines the elicitation capability. */
export function supportsElicitation(version: McpProtocolVersion): boolean {
  return version >= ELICITATION_SINCE
}

/** The `initialize` request params: latest version, our capabilities, and clientInfo. */
export function initializeParams(opts: { elicitation: boolean }): Record<string, unknown> {
  return {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    // Declare elicitation only when a responder is wired: declaring it and
    // then -32601ing the request would be lying to the server. (The declaration
    // is valid for the version requested; if the server negotiates down to one
    // without elicitation, the client stops answering it, see supportsElicitation.)
    capabilities: opts.elicitation ? { elicitation: {} } : {},
    clientInfo: { name: 'Houston', version: APP_VERSION }
  }
}
