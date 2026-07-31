import { Navigate, Route, Routes } from 'react-router-dom'

import { AppLayout } from './layouts/AppLayout'
import { CreateTaskPage } from './pages/CreateTaskPage'
import { DevicesPage } from './pages/DevicesPage'
import { ExecutionPage } from './pages/ExecutionPage'
import { OverviewPage } from './pages/OverviewPage'
import { PlannedPlatformPage } from './pages/PlannedPlatformPage'
import { ReportPage } from './pages/ReportPage'
import { TaskListPage } from './pages/TaskListPage'
import './styles.css'

export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/tasks" element={<TaskListPage />} />
        <Route path="/create" element={<CreateTaskPage />} />
        <Route path="/execution/:id" element={<ExecutionPage />} />
        <Route path="/reports/:id" element={<ReportPage />} />
        <Route path="/devices" element={<DevicesPage />} />
        <Route path="/platform/:platform" element={<PlannedPlatformPage />} />
        <Route path="/settings" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
