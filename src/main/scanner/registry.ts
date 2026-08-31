import { zcodeScanner } from './agents/zcode'
import { traeScanner } from './agents/trae'
import { qoderScanner } from './agents/qoder'
import { codebuddyScanner } from './agents/codebuddy'
import { workbuddyScanner } from './agents/workbuddy'
import { dshWebScanner, dshDesktopScanner } from './agents/dsh'
import { opencodeScanner, loomyScanner } from './agents/opencode'
import { agnesScanner } from './agents/agnes'
import { ycliScanner } from './agents/ycli'
import { hubScanner } from './agents/hub'
import { genericScanners } from './agents/generic'
import type { Scanner } from './types'

/** 全部已注册的智能体扫描器 */
export const scanners: Scanner[] = [
  zcodeScanner,
  traeScanner,
  qoderScanner,
  codebuddyScanner,
  workbuddyScanner,
  dshWebScanner,
  dshDesktopScanner,
  opencodeScanner,
  loomyScanner,
  agnesScanner,
  ycliScanner,
  hubScanner,
  ...genericScanners
]
