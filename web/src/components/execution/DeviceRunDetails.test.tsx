import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { DeviceRunDetails } from './DeviceRunDetails'

describe('DeviceRunDetails', () => {
  it('renders an unregistered installation failure code and its server-provided message', () => {
    const html = renderToStaticMarkup(
      <DeviceRunDetails
        protocolLabel="Morpho VideoPostProcessor 批处理协议 v2"
        run={{
          deviceId: 'honor-x50',
          status: 'failed',
          progress: 17,
          checks: [],
          logs: [],
          outputs: [],
          mode: 'ADB 真机',
          failureCode: 'INSTALL_USER_ACTION_REQUIRED',
          failureMessage: '检测到荣耀安全风险安装页面，需要人工确认安装授权；平台未自动点击任何含义不明确的按钮。',
        }}
      />,
    )

    expect(html).toContain('失败代码：INSTALL_USER_ACTION_REQUIRED')
    expect(html).toContain('需要人工确认安装授权')
  })

  it('renders structured failure semantics and Evidence links without removing legacy fields', () => {
    const evidenceUrl = '/api/tasks/task-1/device-runs/run-1/evidence/result.json'
    const html = renderToStaticMarkup(
      <DeviceRunDetails
        protocolLabel="Morpho VideoPostProcessor 批处理协议 v2"
        run={{
          deviceId: 'oneplus-pkr110',
          status: 'failed',
          progress: 100,
          checks: [],
          logs: [],
          outputs: [],
          mode: 'ADB 真机',
          failureCode: 'RESULT_INVALID',
          failureMessage: 'result.json 无效',
          failure: {
            code: 'RESULT_INVALID',
            category: 'protocol',
            phase: 'validating_output',
            retryability: 'never',
            confidence: 'confirmed',
            message: 'result.json 无效',
            evidenceRefs: [evidenceUrl],
          },
        }}
      />,
    )

    expect(html).toContain('失败代码：RESULT_INVALID')
    expect(html).toContain('结构化失败：RESULT_INVALID')
    expect(html).toContain('协议')
    expect(html).toContain('validating_output')
    expect(html).toContain('已确认')
    expect(html).toContain('不可安全重试')
    expect(html).toContain('result.json')
    expect(html).toContain(`href="${evidenceUrl}"`)
  })

})
