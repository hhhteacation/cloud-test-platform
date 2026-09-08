import { describe, expect, it } from 'vitest'
import { createServer } from 'node:net'

import { ProcessError, type ProcessResult } from '../process.js'
import { AndroidAdbDeviceProvider, parseAdbDevices, parseAdbMdnsPairingServices, parseAdbMdnsServices, type AdbCommandExecutor } from './android-adb-provider.js'

const ok = (stdout: string): ProcessResult => ({ code: 0, stdout, stderr: '' })

describe('AndroidAdbDeviceProvider', () => {
  it('TCP 快速探测只判断已知 Endpoint 端口是否可达，不执行 ADB 命令', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试 TCP Server 未取得端口')
    let adbCalls = 0
    const provider = new AndroidAdbDeviceProvider('/fake/adb', async () => {
      adbCalls += 1
      return ok('')
    })

    await expect(provider.probeNetwork('127.0.0.1', address.port)).resolves.toBe(true)
    expect(adbCalls).toBe(0)
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await expect(provider.probeNetwork('127.0.0.1', address.port)).resolves.toBe(false)
    expect(adbCalls).toBe(0)
  })

  it('解析 ADB mDNS connect 服务并忽略 pairing 服务', () => {
    expect(parseAdbMdnsServices([
      'List of discovered mdns services',
      'adb-demo-123 _adb-tls-connect._tcp. 192.168.1.20:37123',
      'adb-demo-123 _adb-tls-pairing._tcp. 192.168.1.20:40111',
      'demo.local:5555',
    ].join('\n'))).toEqual([
      {
        serviceInstance: 'adb-demo-123', transportType: 'wireless_tls', host: '192.168.1.20', port: 37123,
        serial: '192.168.1.20:37123',
      },
      {
        serviceInstance: 'demo.local:5555', transportType: 'tcp_legacy', host: 'demo.local', port: 5555,
        serial: 'demo.local:5555',
      },
    ])
  })

  it('未标注服务类型的动态端口不会默认识别为传统 TCP', () => {
    expect(parseAdbMdnsServices('phone.local:37123\n')).toEqual([])
  })

  it('把 pairing 服务单独解析为不可执行的配对候选', () => {
    expect(parseAdbMdnsPairingServices([
      'List of discovered mdns services',
      'adb-demo-123 _adb-tls-pairing._tcp. 192.168.1.20:40111',
      'adb-demo-123 _adb-tls-connect._tcp. 192.168.1.20:37123',
    ].join('\n'))).toEqual([{
      serviceInstance: 'adb-demo-123', host: '192.168.1.20', port: 40111,
    }])
  })

  it('pairing 候选发现失败不会伪装成空列表', async () => {
    const execute: AdbCommandExecutor = async () => { throw new Error('pairing discovery failed') }
    await expect(new AndroidAdbDeviceProvider('/fake/adb', execute).discoverPairingCandidates())
      .rejects.toThrow('pairing discovery failed')
  })

  it('mDNS candidates retain the service instance and TLS transport identity', async () => {
    const execute: AdbCommandExecutor = async () => ok(
      'adb-demo-123 _adb-tls-connect._tcp. phone.local:37123\n',
    )

    await expect(
      new AndroidAdbDeviceProvider('/fake/adb', execute).discoverNetwork(),
    ).resolves.toEqual([expect.objectContaining({
      serviceInstance: 'adb-demo-123', networkTransport: 'wireless_tls',
      host: 'phone.local', port: 37123, connectionStatus: 'unknown',
    })])
  })

  it('mDNS 为空时从已连接的传统 TCP ADB 设备补全机型', async () => {
    const execute: AdbCommandExecutor = async (_command, args) => {
      if (args[0] === 'mdns') return ok('List of discovered mdns services\n')
      if (args[0] === 'devices') return ok('List of devices attached\n192.168.112.76:5555 device model:HBN_AL00\n')
      return ok('[ro.serialno]: [HARDWARE-PURA]\n[ro.product.manufacturer]: [HUAWEI]\n[ro.product.model]: [HBN-AL00]\n[ro.config.marketing_name]: [HUAWEI Pura 70 Pro]\n')
    }

    await expect(new AndroidAdbDeviceProvider('/fake/adb', execute).discoverNetwork()).resolves.toEqual([
      expect.objectContaining({
        serial: '192.168.112.76:5555', host: '192.168.112.76', port: 5555,
        connectionStatus: 'online', manufacturer: 'HUAWEI', model: 'HBN-AL00',
        name: 'HUAWEI Pura 70 Pro', networkTransport: 'tcp_legacy',
      }),
    ])
  })

  it('preserves legacy _adb._tcp transport identity instead of misclassifying it as TLS', async () => {
    const execute: AdbCommandExecutor = async () => ok(
      'adb-DE45R8ZPSGIBQOTC\t_adb._tcp\t192.168.113.25:5555\n',
    )

    await expect(
      new AndroidAdbDeviceProvider('/fake/adb', execute).discoverNetwork(),
    ).resolves.toEqual([expect.objectContaining({
      serviceInstance: 'adb-DE45R8ZPSGIBQOTC', networkTransport: 'tcp_legacy',
      host: '192.168.113.25', port: 5555, connectionStatus: 'unknown',
    })])
  })

  it('mDNS 命令失败时暴露观测失败，而不是伪装成没有设备', async () => {
    const execute: AdbCommandExecutor = async () => {
      throw new Error('adb mdns unavailable')
    }

    await expect(
      new AndroidAdbDeviceProvider('/fake/adb', execute).discoverNetwork(),
    ).rejects.toThrow('adb mdns unavailable')
  })

  it('ADB 列表与 mDNS TLS 同时出现时保留 mDNS 的 TLS 元数据', async () => {
    const execute: AdbCommandExecutor = async (_command, args) => {
      if (args[0] === 'mdns') {
        return ok('adb-demo-123 _adb-tls-connect._tcp. 192.168.1.20:37123\n')
      }
      if (args[0] === 'devices') {
        return ok('List of devices attached\n192.168.1.20:37123 device model:Demo\n')
      }
      return ok('[ro.serialno]: [SERIAL-1]\n[ro.product.manufacturer]: [Demo]\n[ro.product.model]: [Demo]\n')
    }

    await expect(
      new AndroidAdbDeviceProvider('/fake/adb', execute).discoverNetwork(),
    ).resolves.toEqual([expect.objectContaining({
      serviceInstance: 'adb-demo-123',
      networkTransport: 'wireless_tls',
      host: '192.168.1.20',
      port: 37123,
      connectionStatus: 'online',
    })])
  })

  it('mDNS 暂时为空时不把非 5555 的已连接 TLS 端口误标记为 tcp_legacy', async () => {
    const execute: AdbCommandExecutor = async (_command, args) => {
      if (args[0] === 'mdns') return ok('List of discovered mdns services\n')
      if (args[0] === 'devices') {
        return ok('List of devices attached\n192.168.1.20:37123 device model:Demo\n')
      }
      return ok('[ro.serialno]: [SERIAL-1]\n[ro.product.manufacturer]: [Demo]\n[ro.product.model]: [Demo]\n')
    }

    await expect(
      new AndroidAdbDeviceProvider('/fake/adb', execute).discoverNetwork(),
    ).resolves.toEqual([])
  })

  it('mDNS 超时但传统 TCP 列表可用时不阻塞 TCP 备用连接', async () => {
    const execute: AdbCommandExecutor = async (_command, args) => {
      if (args[0] === 'mdns') throw new Error('mDNS timeout')
      if (args[0] === 'devices') return ok('List of devices attached\n192.168.1.20:5555 device model:Demo\n')
      return ok('[ro.serialno]: [SERIAL-1]\n[ro.product.manufacturer]: [Demo]\n[ro.product.model]: [Demo]\n')
    }

    await expect(new AndroidAdbDeviceProvider('/fake/adb', execute).discoverNetwork()).resolves.toEqual([
      expect.objectContaining({ host: '192.168.1.20', port: 5555, networkTransport: 'tcp_legacy', connectionStatus: 'online' }),
    ])
  })

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
        '[ro.serialno]: [HONOR123]',
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
        serial: 'HONOR123', hardwareSerial: 'HONOR123', platform: 'android', manufacturer: 'HONOR',
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

  it('将发现取消信号传递到 adb devices 和每台在线设备的 getprop', async () => {
    const controller = new AbortController()
    const observedSignals: Array<AbortSignal | undefined> = []
    const execute: AdbCommandExecutor = async (_command, args, options) => {
      observedSignals.push(options?.signal)
      if (args[0] === 'devices') return ok('List of devices attached\nSERIAL-1 device model:EX_1\n')
      return ok('[ro.serialno]: [SERIAL-1]\n[ro.product.model]: [EX-1]\n')
    }

    await new AndroidAdbDeviceProvider('/fake/adb', execute).discover({ signal: controller.signal })

    expect(observedSignals).toEqual([controller.signal, controller.signal])
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

  it('联网 connect 成功后读取并返回硬件身份', async () => {
    const execute: AdbCommandExecutor = async (_command, args) => {
      if (args[0] === 'connect') return ok('connected to 192.168.1.20:5555')
      if (args[0] === 'devices') return ok('List of devices attached\n192.168.1.20:5555 device model:EX_1\n')
      if (args[0] === '-s') return ok('[ro.serialno]: [PHYSICAL-20]\n[ro.product.manufacturer]: [Example]\n[ro.product.model]: [EX-1]\n[ro.build.version.release]: [15]\n[ro.build.version.sdk]: [35]\n[ro.product.cpu.abi]: [arm64-v8a]\n')
      throw new Error(`unexpected ${args.join(' ')}`)
    }
    await expect(new AndroidAdbDeviceProvider('/fake/adb', execute).connectNetwork('192.168.1.20', 5555)).resolves.toMatchObject({
      serial: '192.168.1.20:5555', host: '192.168.1.20', port: 5555,
      hardwareSerial: 'PHYSICAL-20', manufacturer: 'Example', model: 'EX-1', connectionStatus: 'online',
    })
  })

  it('联网 connect 的原始诊断会映射为可解释 Failure，并保留 stdout/stderr', async () => {
    const execute: AdbCommandExecutor = async () => ({ code: 1, stdout: 'adb stdout', stderr: 'failed to connect: Connection refused' })
    await expect(new AndroidAdbDeviceProvider('/fake/adb', execute).connectNetwork('192.0.2.30', 5555)).resolves.toMatchObject({
      serial: '192.0.2.30:5555', connectionStatus: 'offline', failureCode: 'ADB_PORT_REFUSED',
      failureMessage: 'failed to connect: Connection refused', adbExitCode: 1, adbStdout: 'adb stdout', adbStderr: 'failed to connect: Connection refused',
    })
  })

  it('联网设备 unauthorized 不会伪装成 online', async () => {
    const execute: AdbCommandExecutor = async (_command, args) => {
      if (args[0] === 'connect') return ok('already connected')
      if (args[0] === 'devices') return ok('List of devices attached\n192.0.2.31:5555 unauthorized\n')
      throw new Error(`unexpected ${args.join(' ')}`)
    }
    await expect(new AndroidAdbDeviceProvider('/fake/adb', execute).connectNetwork('192.0.2.31', 5555)).resolves.toMatchObject({
      serial: '192.0.2.31:5555', connectionStatus: 'unauthorized', failureCode: 'ADB_UNAUTHORIZED',
    })
  })

  it('联网 connect 失败时返回 offline 候选而不伪造在线状态', async () => {
    const execute: AdbCommandExecutor = async () => { throw new Error('connect failed') }
    await expect(new AndroidAdbDeviceProvider('/fake/adb', execute).connectNetwork('192.168.1.30', 5555)).resolves.toMatchObject({
      serial: '192.168.1.30:5555', connectionStatus: 'offline',
    })
  })

  it('取消联网 connect 时保留 NETWORK_CONNECTION_CANCELLED 和底层 Evidence', async () => {
    const controller = new AbortController()
    const execute: AdbCommandExecutor = async (_command, args, options) => {
      if (args[0] === 'connect') {
        controller.abort()
        throw new ProcessError('命令执行已取消', '/fake/adb', args, {
          code: -1,
          stdout: 'partial adb stdout',
          stderr: 'partial adb stderr',
          stdoutTruncated: false,
          stderrTruncated: true,
        })
      }
      expect(options?.signal).toBe(controller.signal)
      throw new Error('should not run after cancellation')
    }

    await expect(new AndroidAdbDeviceProvider('/fake/adb', execute).connectNetwork('192.0.2.32', 5555, { signal: controller.signal })).resolves.toMatchObject({
      serial: '192.0.2.32:5555', connectionStatus: 'offline', failureCode: 'NETWORK_CONNECTION_CANCELLED',
      failureMessage: '命令执行已取消', adbExitCode: -1, adbStdout: 'partial adb stdout', adbStderr: 'partial adb stderr', adbStderrTruncated: true,
    })
  })

})
