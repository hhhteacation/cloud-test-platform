import { describe, expect, it } from 'vitest'

import {
  boundsCenter,
  extractFocusedWindowPackage,
  extractUiXml,
  parseBounds,
  parseUiNodes,
} from './ui-xml.js'

describe('UI Automator XML parser', () => {
  it('parses nodes and calculates a tap from XML bounds', () => {
    const nodes = parseUiNodes(`UI hierchary dumped to: /dev/tty\n<?xml version="1.0"?><hierarchy><node text="继续" resource-id="id/continue" content-desc="" package="com.android.packageinstaller" class="android.widget.Button" clickable="true" checkable="false" checked="false" bounds="[100,200][500,400]" /></hierarchy>`)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({ text: '继续', clickable: true })
    expect(boundsCenter(nodes[0].bounds!)).toEqual({ x: 300, y: 300 })
  })

  it('rejects invalid or empty bounds', () => {
    expect(parseBounds('[10,10][10,20]')).toBeUndefined()
    expect(parseBounds('not-bounds')).toBeUndefined()
  })

  it('extracts XML and the current focused package', () => {
    expect(extractUiXml('prefix\n<hierarchy rotation="0"></hierarchy>')).toBe('<hierarchy rotation="0"></hierarchy>')
    expect(extractFocusedWindowPackage('mCurrentFocus=Window{123 u0 com.vivo.packageinstaller/.InstallActivity}')).toBe('com.vivo.packageinstaller')
  })
})
