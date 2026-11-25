const fs = require('node:fs')
const path = require('node:path')

const sourcePath = process.argv[2] || path.join(__dirname, 'client.js')
const source = fs.readFileSync(sourcePath, 'utf8')

const createElement = (type, props, ...children) => ({ type, props, children })
const React = {
  createElement,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useRef: (value) => ({ current: value }),
  useEffect: () => {},
}

let factory
const window = { __ModuleLoader__: { load: (def) => { factory = def.factory } } }
const requireStub = (name) => {
  if (name === 'react') return React
  throw new Error('unexpected require ' + name)
}

const fn = new Function('window', 'require', 'module', source)
fn(window, requireStub, {})

const pluginModule = factory(requireStub)

let Component
pluginModule.apply({
  slots: {
    inject: (slot, factoryFn) => factoryFn(),
    register: (options, component) => { Component = component; return () => {} },
  },
})

const textOf = (node) => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children || []).map(textOf).join('')
}

const render = (props) => textOf(Component(props))

const cases = [
  ['projection long', { useProjection: () => ({ mode: 'long' }), getCached: () => null }, '长考'],
  ['projection short', { useProjection: () => ({ mode: 'short' }), getCached: () => null }, '短考'],
  ['no projection, cached long', { useProjection: () => undefined, getCached: () => 'long' }, '长考'],
  ['no projection, cached short', { useProjection: () => undefined, getCached: () => 'short' }, '短考'],
  ['nothing known', { useProjection: () => undefined, getCached: () => null }, '短考'],
]

let failed = 0
for (const [name, props, expected] of cases) {
  const text = render({ read: () => Promise.resolve('短考'), toggle: () => Promise.resolve('→ 长考'), ...props })
  const ok = text.includes(expected)
  if (!ok) failed++
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + ' → "' + text + '" (expect ' + expected + ')')
}
process.exit(failed === 0 ? 0 : 1)
