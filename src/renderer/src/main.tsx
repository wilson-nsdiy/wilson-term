import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/globals.css'
import { api } from './api'

// 挂载 Tauri 适配层到 window，兼容现有 `window.api.xxx` 写法
;(window as unknown as { api: typeof api }).api = api

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
