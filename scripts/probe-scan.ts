/**
 * 无 GUI 扫描探针：用 ELECTRON_RUN_AS_NODE=1 + electron 二进制直跑，
 * 运行时与主进程完全一致（同 ABI、同 node），但不依赖窗口/whenReady。
 * 用法：npx esbuild scripts/probe-scan.ts --bundle --platform=node --external:better-sqlite3 --outfile=/tmp/probe.cjs --format=cjs
 *       ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /tmp/probe.cjs [agentId...]
 */
import { scanners } from '../src/main/scanner/registry'

const filter = process.argv.slice(2)
for (const s of scanners) {
  if (filter.length && !filter.includes(s.meta.id)) continue
  const t = Date.now()
  try {
    const snap = s.scan()
    console.log(
      `${s.meta.id}: detected=${snap.info.detected} usage=${snap.usage.length} projects=${snap.projectDirs.length} skills=${snap.skills.length} (${Date.now() - t}ms)`
    )
  } catch (err) {
    console.error(`${s.meta.id} FAILED: ${err instanceof Error ? err.stack : err}`)
  }
}
console.log('probe done')
