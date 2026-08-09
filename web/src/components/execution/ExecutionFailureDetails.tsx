import { Alert, Descriptions, List, Typography } from 'antd'

import type { ExecutionFailure } from '../../types'

const categoryLabels: Record<ExecutionFailure['category'], string> = {
  observation: '观察',
  device: '设备',
  business: '业务',
  protocol: '协议',
  infrastructure: '基础设施',
  user_action: '用户操作',
  cancelled: '已取消',
}

const confidenceLabels: Record<ExecutionFailure['confidence'], string> = {
  confirmed: '已确认',
  probable: '较可能',
  unknown: '未知',
}

const retryabilityLabels: Record<ExecutionFailure['retryability'], string> = {
  never: '不可安全重试',
  safe: '可安全重试',
  conditional: '需结合证据判断',
}

export function ExecutionFailureDetails({ failure }: { failure?: ExecutionFailure }) {
  if (!failure) return null
  return (
    <Alert
      className="failure-alert"
      type={failure.category === 'cancelled' ? 'warning' : 'error'}
      showIcon
      message={`结构化失败：${failure.code}`}
      description={(
        <>
          <Descriptions size="small" column={2}>
            <Descriptions.Item label="类别">{categoryLabels[failure.category]}</Descriptions.Item>
            <Descriptions.Item label="阶段">{failure.phase}</Descriptions.Item>
            <Descriptions.Item label="置信度">{confidenceLabels[failure.confidence]}</Descriptions.Item>
            <Descriptions.Item label="重试性">{retryabilityLabels[failure.retryability]}</Descriptions.Item>
            <Descriptions.Item label="原因" span={2}>{failure.message}</Descriptions.Item>
          </Descriptions>
          {failure.evidenceRefs.length > 0 && (
            <List
              size="small"
              header="Evidence"
              dataSource={failure.evidenceRefs}
              renderItem={(ref) => (
                <List.Item>
                  <Typography.Link href={ref} target="_blank" rel="noreferrer">
                    {ref.split('/').at(-1) || ref}
                  </Typography.Link>
                </List.Item>
              )}
            />
          )}
        </>
      )}
    />
  )
}
