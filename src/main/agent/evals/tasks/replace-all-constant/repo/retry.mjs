export const MAX_RETRIES = 3

export function shouldRetry(attempt) {
  return attempt < MAX_RETRIES
}

export function remaining(attempt) {
  return MAX_RETRIES - attempt
}
