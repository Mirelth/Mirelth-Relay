import { ElectronAPI } from '@electron-toolkit/preload'
import type { ApiClient } from '@shared/types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: ApiClient
    onScanCompleted: (cb: () => void) => () => void
    onUpdaterOpen: (cb: () => void) => () => void
  }
}
