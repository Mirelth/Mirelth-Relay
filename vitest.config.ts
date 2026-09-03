import { join } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': join(process.cwd(), 'src/shared'),
      '@renderer': join(process.cwd(), 'src/renderer/src')
    }
  },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    // 单测默认 node；UI 组件测在文件里用 // @vitest-environment happy-dom 切换
    environment: 'node',
    testTimeout: 20000
  }
})
