import { lazy, Suspense } from 'react'
import { HashRouter, Route, Routes } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import Layout from '@app/components/Layout'
import Overview from './pages/Overview'
import Trace from './pages/Trace'
import Usage from './pages/Usage'
import Settings from './pages/Settings'

// 旧页面原样接回；网关口径的三个核心页使用新实现。
const Agents = lazy(() => import('@app/pages/Agents'))
const Skills = lazy(() => import('@app/pages/Skills'))
const Mcp = lazy(() => import('@app/pages/Mcp'))
const GitCommits = lazy(() => import('@app/pages/GitCommits'))
const Models = lazy(() => import('@app/pages/Models'))
const Hooks = lazy(() => import('@app/pages/Hooks'))
const Security = lazy(() => import('@app/pages/Security'))
const TeamRepo = lazy(() => import('@app/pages/TeamRepo'))
const Rules = lazy(() => import('@app/pages/Rules'))
const Tasks = lazy(() => import('@app/pages/Tasks'))

const PageFallback = (): React.JSX.Element => {
  const { t } = useTranslation()
  return <div style={{ padding: 40, color: 'var(--muted)' }}>{t('common.loading')}</div>
}

function App(): React.JSX.Element {
  return (
    <HashRouter>
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Overview />} />
            <Route path="/tokens" element={<Usage />} />
            <Route path="/gateway" element={<Settings />} />
            <Route path="/trace" element={<Trace />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/skills" element={<Skills />} />
            <Route path="/mcp" element={<Mcp />} />
            <Route path="/git" element={<GitCommits />} />
            <Route path="/models" element={<Models />} />
            <Route path="/hooks" element={<Hooks />} />
            <Route path="/security" element={<Security />} />
            <Route path="/team-repo" element={<TeamRepo />} />
            <Route path="/rules" element={<Rules />} />
            <Route path="/tasks" element={<Tasks />} />
          </Route>
        </Routes>
      </Suspense>
    </HashRouter>
  )
}

export default App
