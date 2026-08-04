const PATCH_SOURCE = '@wandkit/interceptor' as const
const PATCH_METADATA = Symbol.for(`${PATCH_SOURCE}.patch`)

export type PatchKind =
  | 'fetch'
  | 'xhr-open'
  | 'xhr-send'
  | 'beacon'
  | 'form-submit'

export interface PatchLifecycle {
  active: boolean
}

interface PatchMetadata {
  source: typeof PATCH_SOURCE
  kind: PatchKind
  lifecycle: PatchLifecycle
  previous: CallableFunction
}

/** 给本库 wrapper 写入跨 bundle 可识别的私有 patch 元数据。 */
export function markPatch<F extends CallableFunction>(
  wrapper: F,
  kind: PatchKind,
  lifecycle: PatchLifecycle,
  previous: F
): F {
  Object.defineProperty(wrapper, PATCH_METADATA, {
    value: { source: PATCH_SOURCE, kind, lifecycle, previous } satisfies PatchMetadata
  })
  return wrapper
}

/** 只接受结构完整的本库元数据；异常或第三方值一律视为外部边界。 */
function readPatchMetadata(value: unknown): PatchMetadata | undefined {
  if (typeof value !== 'function') return undefined
  try {
    const metadata = (value as CallableFunction & Record<PropertyKey, unknown>)[PATCH_METADATA]
    if (!metadata || typeof metadata !== 'object') return undefined
    const candidate = metadata as Partial<PatchMetadata>
    if (
      candidate.source !== PATCH_SOURCE ||
      !isPatchKind(candidate.kind) ||
      typeof candidate.previous !== 'function' ||
      !candidate.lifecycle ||
      typeof candidate.lifecycle.active !== 'boolean'
    ) return undefined
    return candidate as PatchMetadata
  } catch (_error) {
    return undefined
  }
}

function isPatchKind(value: unknown): value is PatchKind {
  return value === 'fetch' || value === 'xhr-open' ||
    value === 'xhr-send' || value === 'beacon' || value === 'form-submit'
}

/** 恢复时跳过同通道的连续失活层，同时防止异常元数据形成循环。 */
export function skipInactivePatches<F extends CallableFunction>(
  previous: F,
  kind: PatchKind
): F {
  let current: CallableFunction = previous
  const visited = new Set<CallableFunction>()
  while (!visited.has(current)) {
    visited.add(current)
    const metadata = readPatchMetadata(current)
    if (!metadata || metadata.kind !== kind || metadata.lifecycle.active) break
    current = metadata.previous
  }
  return current as F
}
