import { HashRouter, Route, Routes } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import Layout from './components/Layout'

const Dashboard = lazy(() => import('./pages/Dashboard'))
const Agents = lazy(() => import('./pages/Agents'))
const Skills = lazy(() => import('./pages/Skills'))
const Mcp = lazy(() => import('./pages/Mcp'))
const GitCommits = lazy(() => import('./pages/GitCommits'))
const Tokens = lazy(() => import('./pages/Tokens'))
const Models = lazy(() => import('./pages/Models'))
const Hooks = lazy(() => import('./pages/Hooks'))
const Security = lazy(() => import('./pages/Security'))
const TeamRepo = lazy(() => import('./pages/TeamRepo'))
const Rules = lazy(() => import('./pages/Rules'))
const Tasks = lazy(() => import('./pages/Tasks'))
const Gateway = lazy(() => import('./pages/Gateway'))

const PageFallback = (): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '60vh',
        color: 'var(--muted)',
        fontSize: 14
      }}
    >
      {t('common.loading')}
    </div>
  )
}

function App(): React.JSX.Element {
  return (
    <HashRouter>
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/skills" element={<Skills />} />
            <Route path="/mcp" element={<Mcp />} />
            <Route path="/git" element={<GitCommits />} />
            <Route path="/tokens" element={<Tokens />} />
            <Route path="/models" element={<Models />} />
            <Route path="/gateway" element={<Gateway />} />
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
