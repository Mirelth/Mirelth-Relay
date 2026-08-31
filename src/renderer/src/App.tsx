import { HashRouter, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Agents from './pages/Agents'
import Skills from './pages/Skills'
import Mcp from './pages/Mcp'
import GitCommits from './pages/GitCommits'
import Tokens from './pages/Tokens'
import Models from './pages/Models'
import Hooks from './pages/Hooks'
import Security from './pages/Security'

function App(): React.JSX.Element {
  return (
    <HashRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/skills" element={<Skills />} />
          <Route path="/mcp" element={<Mcp />} />
          <Route path="/git" element={<GitCommits />} />
          <Route path="/tokens" element={<Tokens />} />
          <Route path="/models" element={<Models />} />
          <Route path="/hooks" element={<Hooks />} />
          <Route path="/security" element={<Security />} />
        </Route>
      </Routes>
    </HashRouter>
  )
}

export default App
