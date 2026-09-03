import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zhCN from './locales/zh-CN.json'
import enUS from './locales/en-US.json'

/**
 * 国际化入口。当前仅 zh-CN/en-US；新增语言只需在 locales/ 加文件并在此注册。
 *
 * 提取约定：
 * - 静态文案用 t('key')，key 用语义命名（nav.agents / modal.update.title / common.cancel）
 * - 带参数的文案用 t('key', { n: 3 })，JSON 写 "剩余 {{n}} 天"
 * - 暂未抽取的中文：保持原样即可，本框架不强制全局迁移
 */
void i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    'en-US': { translation: enUS }
  },
  lng: 'zh-CN', // 默认中文；后续可从系统 locale 读
  fallbackLng: 'zh-CN',
  interpolation: { escapeValue: false },
  returnNull: false
})

export default i18n
