import { describe, expect, it } from 'vitest'

import type { ProcessResult } from '../process.js'
import { AndroidAdbDeviceProvider, parseAdbDevices, type AdbCommandExecutor } from './android-adb-provider.js'

const ok = (stdout: string): ProcessResult => ({ code: 0, stdout, stderr: '' })

describe('AndroidAdbDeviceProvider', () => {
  it('解析 online、offline 和 unauthorized ADB 列表', () => {
    expect(parseAdbDevices([
      'List of devices attached',
      'SERIAL_ON device product:demo model:Pixel_8 device:husky transport_id:1',
      'SERIAL_OFF offline transport_id:2',
      'SERIAL_AUTH unauthorized usb:1-2 transport_id:3',
      '',
    ].join('\n'))).toEqual([
      { serial: 'SERIAL_ON', state: 'device', attributes: { product: 'demo', model: 'Pixel_8', device: 'husky', transport_id: '1' } },
      { serial: 'SERIAL_OFF', state: 'offline', attributes: { transport_id: '2' } },
      { serial: 'SERIAL_AUTH', state: 'unauthorized', attributes: { usb: '1-2', transport_id: '3' } },
    ])
  })

  it('只对已授权在线设备读取 getprop，并返回完整设备属性', async () => {
    const calls: string[][] = []
    const execute: AdbCommandExecutor = async (_command, args) => {
      calls.push(args)
      if (args[0] === 'devices') {
        return ok([
          'List of devices attached',
          'HONOR123 device model:FCP_AN10 transport_id:1',
          'OFFLINE456 offline model:Offline_Phone transport_id:2',
          'AUTH789 unauthorized transport_id:3',
          '',
        ].join('\n'))
      }
      return ok([
        '[ro.product.manufacturer]: [HONOR]',
        '[ro.product.model]: [FCP-AN10]',
        '[ro.config.marketing_name]: [HONOR Magic V3]',
        '[ro.build.version.release]: [16]',
        '[ro.build.version.sdk]: [36]',
        '[ro.product.cpu.abi]: [arm64-v8a]',
        '[ro.build.display.id]: [FCP-AN10 10.0.0.100]',
        '[ro.build.version.security_patch]: [2026-06-01]',
      ].join('\n'))
    }

    const devices = await new AndroidAdbDeviceProvider('/fake/adb', execute).discover()

    expect(calls).toEqual([
      ['devices', '-l'],
      ['-s', 'HONOR123', 'shell', 'getprop'],
    ])
    expect(devices).toEqual([
      {
        serial: 'HONOR123', platform: 'android', manufacturer: 'HONOR',
        name: 'HONOR Magic V3', model: 'FCP-AN10', androidVersion: '16',
        apiLevel: 36, architecture: 'arm64-v8a',
        buildVersion: 'FCP-AN10 10.0.0.100', securityPatch: '2026-06-01',
        connectionStatus: 'online',
      },
      {
        serial: 'OFFLINE456', platform: 'android', model: 'Offline Phone',
        name: 'Offline Phone', connectionStatus: 'offline',
      },
      {
        serial: 'AUTH789', platform: 'android', model: undefined,
        name: undefined, connectionStatus: 'unauthorized',
      },
    ])
  })

  it('getprop 读取失败时返回 unknown，而不是伪造在线属性', async () => {
    const execute: AdbCommandExecutor = async (_command, args) => {
      if (args[0] === 'devices') return ok('List of devices attached\nBROKEN device model:Broken_Phone\n')
      throw new Error('getprop failed')
    }

    await expect(new AndroidAdbDeviceProvider('/fake/adb', execute).discover()).resolves.toEqual([
      {
        serial: 'BROKEN', platform: 'android', model: 'Broken Phone',
        name: 'Broken Phone', connectionStatus: 'unknown',
      },
    ])
  })
})
