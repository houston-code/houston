export function makeConfig(opts = {}) {
  const timeout = opts.timeout ?? 30
  return {
    timeout,
    describe: () => 'timeout=' + timeout
  }
}
