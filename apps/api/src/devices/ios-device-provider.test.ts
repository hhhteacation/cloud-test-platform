import { describe, expect, it } from 'vitest'

import { ProcessError, type ProcessResult } from '../process.js'
import {
  IosLibimobiledeviceProvider,
  parseIdeviceIdList,
  parseIdeviceInfo,
  type IosCommandExecutor,
} from './ios-device-provider.js'

const ok = (stdout: string): ProcessResult => ({ code: 0, stdout, stderr: '' })

describe('parseIdeviceIdList', () => {
  it('每行一个 UDID 并过滤空行与垃圾输出', () => {
    expect(parseIdeviceIdList([
      '00008150-000404A80E62401C',
      '',
      'not-a-udid!',
      '52F2AC8ED4E5A19E',
    ].join('\n'))).toEqual(['00008150-000404A80E62401C', '52F2AC8ED4E5A19E'])
  })

  it('空输出返回空列表', () => {
    expect(parseIdeviceIdList('')).toEqual([])
  })
})

describe('parseIdeviceInfo', () => {
  it('解析 lockdown 键值对并忽略无分隔符行', () => {
    const info = parseIdeviceInfo([
      'DeviceName: iPhone 17 Pro',
      'ProductType: iPhone18,1',
      'ProductVersion: 26.6.2',
      'garbage line without separator',
    ].join('\n'))
    expect(info.get('DeviceName')).toBe('iPhone 17 Pro')
    expect(info.get('ProductType')).toBe('iPhone18,1')
    expect(info.get('ProductVersion')).toBe('26.6.2')
  })
})

describe('IosLibimobiledeviceProvider', () => {
  it('discover 将 usbmux UDID 列表映射为 iOS 候选并逐台读取 lockdown 详情', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const execute: IosCommandExecutor = async (command, args) => {
      calls.push({ command, args })
      if (args[0] === '-l') {
        return ok('00008150-000404A80E62401C\n')
      }
      return ok([
        'DeviceName: iPhone 17 Pro',
        'ProductType: iPhone18,1',
        'ProductVersion: 26.6.2',
        'SerialNumber: JN4C7VYJ3M',
        'CPUArchitecture: arm64e',
        'BuildVersion: 23G90',
      ].join('\n'))
    }

    await expect(new IosLibimobiledeviceProvider('/fake/idevice_id', '/fake/ideviceinfo', execute).discover())
      .resolves.toEqual([expect.objectContaining({
        serial: '00008150-000404A80E62401C',
        hardwareSerial: 'JN4C7VYJ3M',
        platform: 'ios',
        manufacturer: 'Apple',
        name: 'iPhone 17 Pro',
        model: 'iPhone18,1',
        iosVersion: '26.6.2',
        architecture: 'arm64e',
        buildVersion: '23G90',
        connectionStatus: 'online',
      })])
    expect(calls).toEqual([
      { command: '/fake/idevice_id', args: ['-l'] },
      { command: '/fake/ideviceinfo', args: ['-u', '00008150-000404A80E62401C'] },
    ])
  })

  it('usbmux 可见但 lockdown 拒绝时降级为 unknown 候选并携带配对失败码', async () => {
    const execute: IosCommandExecutor = async (command, args) => {
      if (args[0] === '-l') return ok('00008150-000404A80E62401C\n')
      throw new ProcessError('lockdownd 拒绝连接', command, args, {
        code: -1,
        stdout: '',
        stderr: 'ERROR: Unable to connect to lockdownd. User refused the pairing.',
      })
    }

    await expect(new IosLibimobiledeviceProvider('/fake/idevice_id', '/fake/ideviceinfo', execute).discover())
      .resolves.toEqual([expect.objectContaining({
        serial: '00008150-000404A80E62401C',
        platform: 'ios',
        connectionStatus: 'unknown',
        failureCode: 'IOS_PAIRING_REJECTED',
      })])
  })

  it('ideviceinfo 超时归类为 IOS_LOCKDOWN_TIMEOUT', async () => {
    const execute: IosCommandExecutor = async (_command, args) => {
      if (args[0] === '-l') return ok('00008150-000404A80E62401C\n')
      throw new ProcessError('命令超时', _command, args, {
        code: -1,
        stdout: '',
        stderr: 'ERROR: Timeout waiting for lockdownd.',
      })
    }

    await expect(new IosLibimobiledeviceProvider('/fake/idevice_id', '/fake/ideviceinfo', execute).discover())
      .resolves.toEqual([expect.objectContaining({
        failureCode: 'IOS_LOCKDOWN_TIMEOUT',
      })])
  })

  it('platform 声明为 ios', () => {
    expect(new IosLibimobiledeviceProvider().platform).toBe('ios')
  })
})
