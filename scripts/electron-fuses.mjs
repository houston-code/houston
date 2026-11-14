// Electron fuses for the packaged app, flipped from the electron-builder `afterPack` hook
// (scripts/copy-bundled-binaries.mjs) right before signing.
//
// Fuses are bits compiled into the Electron binary that switch off runtime features the
// app never uses. They matter because the binary is the user's own Houston, signed and
// trusted: on macOS the keychain hands Houston's safeStorage key only to code signed as
// Houston (the item's access list names the app), and on every platform security tools
// trust what the signed binary does. With the defaults, any process running as the same
// user could launch that binary as something else and inherit the trust:
//   - `--inspect`/`--inspect-brk` (or SIGUSR1 on a running app) opens a Node debugger in
//     the main process, so a script attached to it can call safeStorage.decryptString on
//     the stored provider keys under Houston's identity;
//   - NODE_OPTIONS (`--require evil.js`) does the same without a debugger;
//   - ELECTRON_RUN_AS_NODE turns the binary into a plain Node with the app's identity;
//   - a loose `app/` directory or a swapped `app.asar` beside the binary runs other code.
// The flips below close each of those. They are per platform because one fuse cannot be:
//
//   RunAsNode stays ON on Linux only. The Linux sandbox's proxied-egress mode runs a small
//   forwarder inside the bubblewrap namespace with `ELECTRON_RUN_AS_NODE=1 <execPath>`
//   (src/main/sandbox/linux.ts, FORWARDER_SOURCE in egress-proxy.ts), because the
//   namespace has no other Node to run it with. Nothing on macOS or Windows uses it, so it
//   is off there. On Linux the secret store (libsecret) does not bind a secret to the
//   binary that stored it, so this fuse is not what keeps a same-user process from the
//   key there; the debugger and NODE_OPTIONS fuses still go off.
//
// electron-builder's own `electronFuses` option is top-level only (one config for every
// platform), which cannot express the Linux carve-out, so the flip runs here through the
// packager's `addElectronFuses`, the hook electron-builder documents for custom fuse
// logic. It runs once per (platform, arch) pack, after the vendored binaries are copied
// and native paths scrubbed and before electron-builder signs. Keep `electronFuses` unset
// in electron-builder.yml: it would flip a second, platform-blind set after this one.

/** Index of each fuse in Electron's V1 fuse wire (mirrors @electron/fuses' FuseV1Options). */
export const FUSE_INDEX = {
  RunAsNode: 0,
  EnableCookieEncryption: 1,
  EnableNodeOptionsEnvironmentVariable: 2,
  EnableNodeCliInspectArguments: 3,
  EnableEmbeddedAsarIntegrityValidation: 4,
  OnlyLoadAppFromAsar: 5,
  LoadBrowserProcessSpecificV8Snapshot: 6,
  GrantFileProtocolExtraPrivileges: 7
}

/**
 * Pure: the named fuse values for one electron platform name (`darwin`, `mas`, `win32`,
 * `linux`). Every fuse is set explicitly so an Electron upgrade that changes a default
 * can't silently change the shipped binary.
 */
export function fusesFor(electronPlatformName) {
  if (!['darwin', 'mas', 'win32', 'linux'].includes(electronPlatformName)) {
    throw new Error(`electron-fuses: unknown platform "${electronPlatformName}"`)
  }
  return {
    // See the header: the Linux sandbox's egress forwarder needs it; nothing else does.
    RunAsNode: electronPlatformName === 'linux',
    // Encrypt the cookie store with the OS key, as Chrome does. One-way: an existing
    // plaintext store is encrypted on write.
    EnableCookieEncryption: true,
    // NODE_OPTIONS / NODE_EXTRA_CA_CERTS are ignored. Corporate TLS roots still work:
    // src/main/system-ca.ts trusts the OS certificate store.
    EnableNodeOptionsEnvironmentVariable: false,
    // --inspect / --inspect-brk / SIGUSR1 are ignored. (The packaged e2e needs the
    // inspector, so it launches a throwaway copy with this one fuse turned back on; see
    // e2e/global-setup.ts. The shipped artifact is never modified.)
    EnableNodeCliInspectArguments: false,
    // Validate app.asar against the hash electron-builder records at pack time (the
    // Info.plist on macOS, a resource in the .exe on Windows; Linux has no support and
    // ignores the fuse).
    EnableEmbeddedAsarIntegrityValidation: true,
    // Load the app only from app.asar, never a loose app/ dir or default_app.asar, so the
    // integrity check above can't be sidestepped.
    OnlyLoadAppFromAsar: true,
    // Electron's default; Houston ships no browser-specific snapshot.
    LoadBrowserProcessSpecificV8Snapshot: false,
    // Stays on: the main window is loaded with loadFile (file://), and its Vite build uses
    // module scripts that a plain-browser file:// origin would refuse. Turning this off
    // needs the renderer served from a custom protocol first.
    GrantFileProtocolExtraPrivileges: true
  }
}

/**
 * Pure: the `@electron/fuses` FuseV1Config for one platform. On macOS flipping a fuse
 * rewrites bytes inside the signed Electron Framework, so the bundle is re-signed ad hoc
 * at once (`resetAdHocDarwinSignature`): an unsigned build (PR CI) would otherwise carry
 * a broken signature an Apple Silicon Mac refuses to launch. A signed release build is
 * then re-signed with the Developer ID by electron-builder as usual.
 */
export function fuseConfigFor(electronPlatformName) {
  const named = fusesFor(electronPlatformName)
  const config = {
    version: '1',
    resetAdHocDarwinSignature: electronPlatformName === 'darwin' || electronPlatformName === 'mas'
  }
  for (const [name, value] of Object.entries(named)) config[FUSE_INDEX[name]] = value
  return config
}

/** Flip this pack's fuses. `context` is electron-builder's AfterPackContext. */
export async function flipFusesForPack(context) {
  const config = fuseConfigFor(context.electronPlatformName)
  await context.packager.addElectronFuses(context, config)
  return config
}
