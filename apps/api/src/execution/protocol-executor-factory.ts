import type { ApkExecutionProtocol } from '../apk-protocols.js'
import { CarrierProtocolExecutor } from './carrier-protocol-executor.js'
import { TaskExecutionError } from './execution-errors.js'
import { MorphoProtocolExecutor } from './morpho-protocol-executor.js'
import type {
  ProtocolExecutor,
  ProtocolExecutorDependencies,
} from './protocol-executor.js'

const protocolExecutors: Record<
  string,
  (dependencies: ProtocolExecutorDependencies) => ProtocolExecutor
> = {
  'platform-carrier-v1': (dependencies) => new CarrierProtocolExecutor(dependencies),
  'morpho-video-postprocessor-batch-v2': (dependencies) => new MorphoProtocolExecutor(dependencies),
}

export function createProtocolExecutor(
  protocol: ApkExecutionProtocol,
  dependencies: ProtocolExecutorDependencies,
): ProtocolExecutor {
  const create = protocolExecutors[protocol.id]
  if (!create) {
    throw new TaskExecutionError(
      `协议 ${protocol.id} 没有注册执行器`,
      'UNSUPPORTED_APK_PROTOCOL',
    )
  }
  return create(dependencies)
}
