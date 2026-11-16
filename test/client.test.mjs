// Client-half wiring test for dsh-mimo-credits (loads the module, never renders React).
import assert from "node:assert/strict"

const captured = { definitions: [], locale: {}, slots: [] }

globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured.definitions.push(definition)
    },
  },
}

const reactStub = {
  createElement: (...args) => ({ element: args }),
  useEffect: () => {},
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
}

await import('../client.js')

assert.equal(captured.definitions.length, 1, 'module registered exactly once')
const definition = captured.definitions[0]
assert.equal(definition.id, 'dsh-mimo-credits')

const plugin = definition.factory((name) => {
  if (name === 'react') return reactStub
  throw new Error(`unexpected require: ${name}`)
})
assert.deepEqual(plugin.inject, ['slots', 'locale'])

const registered = []
const ctx = {
  effect: (fn) => {
    const cleanup = fn()
    return () => typeof cleanup === 'function' && cleanup()
  },
  locale: {
    register: (ns, dicts) => {
      captured.locale[ns] = dicts
      return () => {}
    },
    getSnapshot: () => ({ active: 'zh-CN' }),
  },
  slots: {
    inject: (key, callback) => {
      callback()
      return () => {}
    },
    register: (options, component) => {
      registered.push({ options, component })
      return () => {}
    },
  },
}

plugin.apply(ctx)

// Locale namespace registered with both dictionaries.
assert.deepEqual(Object.keys(captured.locale), ['mimoCredits'])
const { en, zh } = captured.locale.mimoCredits
assert.ok(en && zh, 'en and zh dictionaries present')

// Key parity: every English key has a Chinese twin and vice versa.
const enKeys = Object.keys(en).sort()
const zhKeys = Object.keys(zh).sort()
assert.deepEqual(
  zhKeys,
  enKeys,
  `locale key mismatch:\n  only en: ${enKeys.filter((k) => !zhKeys.includes(k))}\n  only zh: ${zhKeys.filter((k) => !enKeys.includes(k))}`,
)

// Placeholders used in bar.title exist in both languages.
for (const dict of [en, zh]) {
  for (const placeholder of ['plan', 'remaining', 'total', 'usedPercent', 'start', 'end']) {
    assert.ok(dict['bar.title'].includes(`{${placeholder}}`), `bar.title missing {${placeholder}}`)
  }
}

// No template leftovers.
for (const dict of [en, zh]) {
  for (const [key, text] of Object.entries(dict)) {
    assert.ok(!/Komponist|blue circle|Décoration/i.test(text), `${key} still carries template copy`)
  }
}

// Two slot registrations with the expected options.
assert.equal(registered.length, 2, 'both slots registered')
const bar = registered.find((r) => r.options.name === 'sidebar.footer.action')
const row = registered.find((r) => r.options.name === 'settings.general.item')
assert.ok(bar, 'sidebar footer registration present')
assert.equal(bar.options.id, 'mimo-credits')
assert.equal(bar.options.order, 10)
assert.equal(bar.options.locale, 'mimoCredits')
assert.equal(typeof bar.component, 'function')
const barInjected = bar.options.inject()
assert.equal(typeof barInjected.getLocale, 'function')
assert.equal(barInjected.getLocale(), 'zh-CN')
// The old header seat must stay vacant: the widget lives at the sidebar foot now.
assert.equal(
  registered.some((r) => r.options.name === 'conversation.session.header.utilities'),
  false,
  'no header-utilities registration remains',
)

assert.ok(row, 'settings row registration present')
assert.equal(row.options.id, 'mimo-credits-key')
assert.equal(row.options.order, 40)
assert.equal(row.options.locale, 'mimoCredits')
assert.equal(typeof row.component, 'function')

// Client styles carry no hard-coded colors (harness tokens only).
const { readFileSync } = await import('node:fs')
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const styleBlocks = [...source.matchAll(/const \w+_STYLE = `([\s\S]*?)`/g)].map((m) => m[1])
assert.ok(styleBlocks.length >= 2, 'style blocks found')
for (const block of styleBlocks) {
  const colors = block.match(/(#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\()/g)
  assert.equal(colors, null, `hard-coded color in styles: ${colors}`)
  assert.ok(!block.includes('prefers-color-scheme'), 'follow the app theme, not the OS')
}

console.log('dsh-mimo-credits client wiring test: all assertions passed')
