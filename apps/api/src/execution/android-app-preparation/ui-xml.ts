export interface UiBounds {
  left: number
  top: number
  right: number
  bottom: number
}

export interface UiNode {
  index: number
  text: string
  resourceId: string
  contentDescription: string
  packageName: string
  className: string
  clickable: boolean
  checkable: boolean
  checked: boolean
  bounds?: UiBounds
}

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
}

function decodeXml(value: string) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|quot);/gi, (entity, key: string) => {
    if (key.startsWith('#x')) return String.fromCodePoint(Number.parseInt(key.slice(2), 16))
    if (key.startsWith('#')) return String.fromCodePoint(Number.parseInt(key.slice(1), 10))
    return XML_ENTITIES[key.toLowerCase()] ?? entity
  })
}

function attribute(source: string, name: string) {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(source)
  return decodeXml(match?.[1] ?? '')
}

export function parseBounds(value: string): UiBounds | undefined {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(value.trim())
  if (!match) return undefined
  const [, left, top, right, bottom] = match.map(Number)
  if (right <= left || bottom <= top) return undefined
  return { left, top, right, bottom }
}

export function boundsCenter(bounds: UiBounds) {
  return {
    x: Math.round((bounds.left + bounds.right) / 2),
    y: Math.round((bounds.top + bounds.bottom) / 2),
  }
}

export function extractUiXml(rawOutput: string) {
  const xmlStart = rawOutput.indexOf('<?xml')
  if (xmlStart >= 0) return rawOutput.slice(xmlStart).trim()
  const hierarchyStart = rawOutput.indexOf('<hierarchy')
  return hierarchyStart >= 0 ? rawOutput.slice(hierarchyStart).trim() : ''
}

export function parseUiNodes(rawOutput: string): UiNode[] {
  const xml = extractUiXml(rawOutput)
  if (!xml) return []

  return [...xml.matchAll(/<node\s+([^>]*?)(?:\/>|>)/g)].map((match, index) => {
    const attributes = match[1]
    return {
      index,
      text: attribute(attributes, 'text'),
      resourceId: attribute(attributes, 'resource-id'),
      contentDescription: attribute(attributes, 'content-desc'),
      packageName: attribute(attributes, 'package'),
      className: attribute(attributes, 'class'),
      clickable: attribute(attributes, 'clickable') === 'true',
      checkable: attribute(attributes, 'checkable') === 'true',
      checked: attribute(attributes, 'checked') === 'true',
      bounds: parseBounds(attribute(attributes, 'bounds')),
    }
  })
}

export function nodeSearchText(node: UiNode) {
  return [node.text, node.contentDescription, node.resourceId].filter(Boolean).join(' ')
}

export function extractFocusedWindowComponent(dumpsys: string) {
  const patterns = [
    /mCurrentFocus=Window\{[^}]*\s(?:u\d+\s+)?([\w.]+\/[\w.$]+)(?:\s|})/,
    /mFocusedApp=.*?\s([\w.]+\/[\w.$]+)/,
    /topResumedActivity=.*?\s([\w.]+\/[\w.$]+)/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(dumpsys)
    if (match?.[1]) return match[1]
  }
  return undefined
}

export function extractFocusedWindowPackage(dumpsys: string) {
  return extractFocusedWindowComponent(dumpsys)?.split('/')[0]
}
