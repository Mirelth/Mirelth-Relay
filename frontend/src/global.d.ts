declare global {
  interface Window {
    api: any
    go: any
    runtime: any
    onScanCompleted: (cb: () => void) => () => void
    onUpdaterOpen: (cb: (info: any) => void) => () => void
  }
}

export {}
