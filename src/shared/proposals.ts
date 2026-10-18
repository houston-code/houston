/**
 * The message a "Do it here" click on a propose_session card sends to the chat:
 * the proposal's own brief, asked for in this conversation instead of a separate
 * session. Shared so the desktop app and the TUI word it the same way.
 */
export function doItHereMessage(args: { title: string; prompt: string }): string {
  return `Go ahead with the session you proposed, "${args.title}", here in this chat instead of a separate session:\n\n${args.prompt}`
}
