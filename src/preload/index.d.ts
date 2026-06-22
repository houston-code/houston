import type { CoderApi } from './index'

declare global {
  interface Window {
    api: CoderApi
  }
}

export {}
