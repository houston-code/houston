/**
 * What went wrong in a call to the main process, in words fit for the UI. Electron
 * wraps every rejection as "Error invoking remote method '<channel>': Error: <message>";
 * this keeps only the message.
 */
export function ipcErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?/, '')
}
