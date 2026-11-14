import { protocol } from 'electron'
import { MEDIA_SCHEME } from '@shared/images'

/**
 * Houston's private URL schemes. Electron lets an app register privileged schemes
 * once, before it is ready, so every scheme is declared here together.
 *
 *  - `houston-mockup`: render_mockup pages, served from the mockup's own folder to
 *    an offscreen window on a locked-down session (mockupCapture.ts).
 *  - `houston-visual`: inline visuals in the transcript. Mermaid renders in a hidden
 *    locked-down window, and interactive HTML visuals are served to sandboxed
 *    frames in the chat (visualRender.ts).
 *  - `houston-media`: a saved chat's stored images, shown in the app window from
 *    their files instead of held in it as base64 (mediaProtocol.ts).
 */
export const MOCKUP_SCHEME = 'houston-mockup'
export const VISUAL_SCHEME = 'houston-visual'
export { MEDIA_SCHEME }

export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MOCKUP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: VISUAL_SCHEME, privileges: { standard: true, secure: true } },
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true } }
  ])
}
