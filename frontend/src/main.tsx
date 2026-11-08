import './assets/main.css'
import './i18n'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { installApi } from './api'

installApi()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
