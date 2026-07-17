import { describe, expect, it } from 'vitest'
import { isSensitivePath } from './sensitive-paths'

describe('isSensitivePath', () => {
  it('flags dotenv files', () => {
    expect(isSensitivePath('.env')).toBe(true)
    expect(isSensitivePath('config/.env')).toBe(true)
    expect(isSensitivePath('.env.local')).toBe(true)
    expect(isSensitivePath('.env.production')).toBe(true)
    expect(isSensitivePath('apps/web/.env.staging')).toBe(true)
  })

  it('does not flag dotenv templates', () => {
    expect(isSensitivePath('.env.example')).toBe(false)
    expect(isSensitivePath('.env.sample')).toBe(false)
    expect(isSensitivePath('.env.template')).toBe(false)
    expect(isSensitivePath('.env.dist')).toBe(false)
  })

  it('flags SSH private keys but not public keys or config', () => {
    expect(isSensitivePath('.ssh/id_rsa')).toBe(true)
    expect(isSensitivePath('id_ed25519')).toBe(true)
    expect(isSensitivePath('secrets/.ssh/deploy_key')).toBe(true)
    expect(isSensitivePath('.ssh/id_rsa.pub')).toBe(false)
    expect(isSensitivePath('.ssh/known_hosts')).toBe(false)
    expect(isSensitivePath('.ssh/config')).toBe(false)
    expect(isSensitivePath('.ssh/authorized_keys')).toBe(false)
  })

  it('flags key/cert material by extension', () => {
    expect(isSensitivePath('certs/server.pem')).toBe(true)
    expect(isSensitivePath('tls/private.key')).toBe(true)
    expect(isSensitivePath('bundle.p12')).toBe(true)
    expect(isSensitivePath('a/b/keystore.jks')).toBe(true)
  })

  it('flags known credential stores by basename', () => {
    expect(isSensitivePath('.netrc')).toBe(true)
    expect(isSensitivePath('.git-credentials')).toBe(true)
    expect(isSensitivePath('.npmrc')).toBe(true)
    expect(isSensitivePath('.pypirc')).toBe(true)
    expect(isSensitivePath('credentials.json')).toBe(true)
    expect(isSensitivePath('deploy/service-account.json')).toBe(true)
  })

  it('flags cloud credential files only in their expected directory', () => {
    expect(isSensitivePath('.aws/credentials')).toBe(true)
    expect(isSensitivePath('home/.kube/config')).toBe(true)
    expect(isSensitivePath('.docker/config.json')).toBe(true)
    expect(isSensitivePath('gcloud/application_default_credentials.json')).toBe(true)
    // A source file named `credentials` outside .aws/ is not a cloud cred store.
    expect(isSensitivePath('src/credentials.ts')).toBe(false)
    expect(isSensitivePath('lib/config')).toBe(false)
  })

  it('handles Windows-style backslash separators', () => {
    expect(isSensitivePath('project\\.env')).toBe(true)
    expect(isSensitivePath('users\\me\\.ssh\\id_rsa')).toBe(true)
  })

  it('does not flag ordinary source files', () => {
    expect(isSensitivePath('src/index.ts')).toBe(false)
    expect(isSensitivePath('README.md')).toBe(false)
    expect(isSensitivePath('package.json')).toBe(false)
    expect(isSensitivePath('env.ts')).toBe(false)
    expect(isSensitivePath('environment.ts')).toBe(false)
    expect(isSensitivePath('')).toBe(false)
  })
})
