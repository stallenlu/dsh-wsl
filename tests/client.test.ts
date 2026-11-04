/**
 * Browser-half checks: the built bundle is loaded the way the host's module
 * loader loads it, registered into a stub slot registry, and the component it
 * hands over is actually mounted and clicked in a DOM.
 *
 * The bundle is the unit under test, not `src/client/index.tsx`, because that
 * file is excluded from the typecheck (it is compiled by tsdown alone) — so a
 * defect there can only be caught here. `npm test` builds first via `pretest`.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { strings } from '../src/client/locale.ts'

const require = createRequire(import.meta.url)
const bundlePath = new URL('../lib/client.js', import.meta.url)

/** What the stub registry saw, so the assertions can inspect the component. */
interface Registered {
  name: string
  id: string
  component: (props: Record<string, unknown>) => unknown
}

interface ClientModule {
  apply: (ctx: unknown) => void
  inject: string[]
}

/** Load `lib/client.js` under a stub `window.__ModuleLoader__`. */
function loadBundle(): { module: ClientModule; registered: Registered[]; effects: string[] } {
  assert.ok(existsSync(bundlePath), 'lib/client.js is missing — run `npm run build`')
  const registered: Registered[] = []
  const effects: string[] = []
  const slots = {
    // `slots.inject(name, body)` runs `body` inside the injected scope and
    // returns the disposer — the same two-argument shape the shipped
    // reference plugin uses.
    inject(_name: string, body: () => unknown) {
      body()
      return () => {}
    },
    register(options: { name: string; id: string }, component: Registered['component']) {
      registered.push({ ...options, component })
      return () => {}
    },
  }
  const ctx = {
    get: (name: string) => (name === 'slots' ? slots : undefined),
    effect: (body: () => unknown, label?: string) => {
      effects.push(label ?? '')
      body()
    },
  }
  let module: ClientModule | undefined
  const window = {
    __ModuleLoader__: {
      load(entry: { id: string; factory: (req: (id: string) => unknown) => ClientModule }) {
        // The Tooltip primitive ships CSS module imports the Node test loader
        // cannot parse; the stub is a passthrough, which is all these tests
        // need — the real bubble is the shell's, rendered live.
        const req = (id: string) =>
          id === '@deepseek-ai/dsh-client-ui-primitives'
            ? { Tooltip: (props: { children: unknown }) => props.children }
            : require(id)
        module = entry.factory(req)
      },
    },
    // The bundle reads `window.MutationObserver` off the wrapper object this
    // function receives, not off the live global — hand it the jsdom one (the
    // DOM test assigns it to globalThis before rendering).
    get MutationObserver(): typeof MutationObserver | undefined {
      return (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver
    },
  }
  // The shipped bundle is a browser CJS wrapper, so it is evaluated with the
  // loader stubbed rather than imported — exactly how the host evaluates it.
  new Function('window', readFileSync(bundlePath, 'utf8'))(window)
  assert.ok(module, 'the bundle never called window.__ModuleLoader__.load')
  module.apply(ctx)
  return { module, registered, effects }
}

test('the bundle exports the registry shape and registers the footer fallback seat', () => {
  const { module, registered, effects } = loadBundle()
  // The client registry identifies a module through the package's `dsh.client`
  // manifest, so `apply`/`inject` is all it may export.
  assert.deepEqual(Object.keys(module).sort(), ['apply', 'inject'])
  assert.deepEqual(module.inject, ['slots'])
  assert.equal(registered.length, 1)
  assert.equal(registered[0]!.name, 'sidebar.footer.action')
  // A fresh id adds beside the shipped entries; reusing one would replace it.
  assert.equal(registered[0]!.id, 'dsh-wsl')
  assert.equal(effects.length, 1)
})

test('the footer action is a token-styled icon button in both sidebar widths', () => {
  const { registered } = loadBundle()
  const Action = registered[0]!.component
  const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server')
  const { createElement } = require('react') as typeof import('react')

  const wide = renderToStaticMarkup(createElement(Action as never, { wide: true }))
  // The wide variant carries the visible label and the wide class. The label
  // comes from the locale dictionary (`navigator.language` in the shell).
  const t = strings()
  assert.ok(wide.includes(`>${t.addTitle}…</span>`), wide)
  assert.ok(wide.includes('dww-action--wide'), wide)
  // The collapsed rail gets the glyph only — the label would overflow it — but
  // keeps an accessible name through `aria-label`.
  const rail = renderToStaticMarkup(createElement(Action as never, { wide: false }))
  assert.ok(!rail.includes(`>${t.addTitle}…</span>`), rail)
  assert.ok(rail.includes('dww-action--rail'), rail)
  assert.ok(rail.includes(`aria-label="${t.addTitle}"`), rail)
})

test('the mounted action mirrors a W entry beside the workspace header add control', async () => {
  const { registered } = loadBundle()
  const Action = registered[0]!.component as never as (props: Record<string, unknown>) => unknown
  const { createElement } = require('react') as typeof import('react')
  const { createRoot } = require('react-dom/client') as typeof import('react-dom/client')
  const { act } = require('react') as typeof import('react')

  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' })
  const { window } = dom
  const globals = globalThis as Record<string, unknown>
  const saved = { window: globals['window'], document: globals['document'], IS_REACT_ACT_ENVIRONMENT: globals['IS_REACT_ACT_ENVIRONMENT'], MutationObserver: globals['MutationObserver'] }
  globals['window'] = window
  globals['document'] = window.document
  // The bundle reads MutationObserver off its wrapper `window`; the getter in
  // loadBundle falls back to the live global, so hand it the jsdom one.
  globals['MutationObserver'] = window.MutationObserver
  globals['IS_REACT_ACT_ENVIRONMENT'] = true

  // The host-private markup the entry must discover: a Workspaces section
  // header whose action strip ends with the shipped add control. Hashed class
  // names, matched by the `[class*="_sectionHeader"]` suffix idiom.
  const container = window.document.getElementById('root')!
  let unmount = (): void => {}
  container.innerHTML = `
    <div class="GAkraW_root">
      <div class="GAkraW_sectionHeader">
        <span class="GAkraW_sectionLabel">工作区</span>
        <div class="GAkraW_headerActions" style="max-width:60px">
          <button type="button" class="GAkraW_iconButton" aria-label="添加工作区">+</button>
        </div>
      </div>
      <div class="GAkraW_footer"><div id="footer-slot"></div></div>
    </div>`

  // The stylesheet is injected at `apply()` time from the live `document` —
  // which only exists now, after the jsdom globals are set. Re-running apply
  // is idempotent (the slot registration returns its own disposer), and the
  // loadBundle() earlier in this test ran with no document at all.
  loadBundle().module!.apply({
    get: (name: string) => (name === 'slots' ? { inject: (_n: string, body: () => unknown) => { body(); return () => {} }, register: () => () => {} } : undefined),
    effect: (body: () => unknown) => { body() },
  })

  try {
    const reactRoot = createRoot(container.querySelector('#footer-slot')!)
    unmount = () => reactRoot.unmount()
    await act(async () => {
      reactRoot.render(createElement(Action as never, { wide: true }))
    })
    // The body observer coalesces through queueMicrotask; act flushes it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    // The entry sits in the strip, beside the add control, wearing the add
    // control's own class list plus the marker class.
    const strip = container.querySelector('[class*="_headerActions"]')!
    const entries = [...strip.querySelectorAll('button.dww-header-entry')]
    assert.equal(entries.length, 1, 'exactly one entry button is injected')
    const entry = entries[0]!
    assert.ok(entry.className.includes('GAkraW_iconButton'), 'the shipped class list is copied')
    assert.ok(entry.className.includes('dww-header-entry'), 'the marker class is applied')
    assert.equal(entry.textContent, 'W')
    // The strip cap must be widened, or the third button is clipped.
    const style = window.document.querySelector('style[data-plugin="dsh-wsl"]')
    assert.ok(style, 'the plugin stylesheet is injected')
    assert.match(style!.textContent ?? '', /max-width:\s*92px/)
    // The footer copy retires while the header seat is present.
    const footer = container.querySelector('button.dww-action') as HTMLButtonElement
    assert.equal(footer.hidden, true)

    // Clicking the entry opens the dialog through the same opener.
    entry.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await act(async () => {})
    assert.match(container.textContent ?? '', new RegExp(strings().addTitle))
    assert.ok(container.querySelector('.dww-overlay'), 'the dialog overlay is mounted')

    // The dialog asks the route for distros on mount (network is not stubbed:
    // the call fails and the error strip renders — behavior, not data, checked).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    assert.ok(container.querySelector('.dww-error'), 'a failed route call renders the error strip')

    // Flush the observers' queued microtasks while the DOM is still alive:
    // after dom.window.close() a straggler observer callback reads the dead
    // document and throws an uncaught exception after the test ends.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  } finally {
    // Unmount first, then let React's scheduled work drain while the DOM is
    // still alive: after dom.window.close() a straggler callback reads the dead
    // window and throws an uncaught exception after the test ends.
    unmount()
    await new Promise((resolve) => setTimeout(resolve, 20))
    globals['window'] = saved['window']
    globals['document'] = saved['document']
    globals['MutationObserver'] = saved['MutationObserver']
    globals['IS_REACT_ACT_ENVIRONMENT'] = saved['IS_REACT_ACT_ENVIRONMENT']
    dom.window.close()
  }
})
