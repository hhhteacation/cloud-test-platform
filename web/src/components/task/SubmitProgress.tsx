import { Card, Steps } from 'antd'

export function SubmitProgress({ current }: { current: number }) {
  return (
    <Card className="upload-progress-card">
      <Steps
        current={current}
        size="small"
        items={[
          { title: '上传 APK' },
          { title: '上传 MP4' },
          { title: '创建任务' },
          { title: '进入执行页' },
        ]}
      />
    </Card>
  )
}
