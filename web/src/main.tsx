import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'

import App from './App'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('无法找到 React 根节点 #root')
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#19734b',
          colorInfo: '#19734b',
          colorLink: '#19734b',
          colorSuccess: '#19734b',
          colorBgLayout: '#f3f1ea',
          colorBgContainer: '#fbfaf6',
          colorText: '#151a16',
          colorBorder: '#d8d7cf',
          borderRadius: 5,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
        },
      }}
    >
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ConfigProvider>
  </React.StrictMode>,
)
