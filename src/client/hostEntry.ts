/**
 * Join the host's own Workspaces header instead of standing beside it.
 *
 * The shell exposes one seat to a third-party client plugin
 * (`sidebar.footer.action`); the section header the user asked to sit in is
 * host-private markup — `WorkspaceBrowser` renders it itself and its slot
 * children carry no hole for header actions (`sidebar.workspaces.directoryFlow`
 * is the only single seat and the directory pickers already own it). So the
 * entry mounts as a plain DOM node beside the shipped "Add workspace" control,
 * by the same technique the shipped workspace browser itself accepts:
 *
 * - the shipped control's own `className` is copied, so size, radius, hover and
 *   focus are the shipped behaviours rather than lookalikes;
 * - the button is drawn through the same Tooltip primitive the shipped control
 *   uses, so the hover bubble is the shipped bubble, not a native `title` box;
 * - the entry is kept in place by observers, because React re-renders the strip
 *   underneath (search expansion, workspace list changes) and drops unknown
 *   children with it.
 *
 * Nothing in the host is patched: no module is wrapped, no service is replaced.
 * The mount falls back to the footer action whenever the header seat is absent
 * (rail sidebar before the region mounts, a release that renames the classes).
 */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { HostEntryButton } from './hostEntryButton.tsx'

/** The shape the mount needs: where to open the dialog, and what to call it. */
export interface HostEntryOptions {
  /** The row/button label, read lazily so a locale change lands on the next pass. */
  label: () => string
  /** Open the dialog. Called from a host-owned click listener. */
  open: () => void
}

/**
 * Mount the W entry in the Workspaces section header, immediately right of the
 * shipped "Add workspace" control.
 *
 * Discovery walks up from the footer slot (the one element this plugin owns)
 * looking for the section header it is mounted beside, then takes that header's
 * action strip and its last button — the add control. The entry is rendered into
 * a slot appended to the strip, so it inherits the strip's gap and the add
 * control's own class list, and it opens the same Tooltip bubble the add
 * control does.
 *
 * @param home - the footer slot's element, or null when it is not mounted.
 * @param options - the label getter and the dialog opener.
 * @param onSeat - told whenever the seat appears or disappears, so the caller
 *   can retire the footer copy while the header carries the entry.
 * @returns a disposer that removes the button and every observer.
 */
export function mountHeaderEntry(home: HTMLElement | null, options: HostEntryOptions, onSeat: (present: boolean) => void): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined' || home === null) return () => {}
  // jsdom and older engines do not all expose it; without an observer the
  // seat simply stays where it was, which is the footer fallback.
  const Observer = (window as { MutationObserver?: typeof MutationObserver }).MutationObserver
  if (Observer === undefined) return () => {}

  const slot = document.createElement('span')
  slot.className = 'dww-header-slot'

  // The entry is React-owned from here: the shell's Tooltip clones its child to
  // attach the hover/focus listeners and a ref, so the button cannot be built by
  // hand and then wrapped by the bubble.
  let root: Root | null = null
  let drawn: { className: string; label: string } | null = null
  /** The dialog opener, stable across renders, so a redraw with the same facts is a no-op commit. */
  const open = (): void => options.open()
  /**
   * Draw (or redraw) the entry with the facts of this pass.
   * @param className - the shipped add control's class list.
   * @param label - the localized entry label, which doubles as the tooltip text.
   */
  const draw = (className: string, label: string): void => {
    if (drawn !== null && drawn.className === className && drawn.label === label) return
    drawn = { className, label }
    if (root === null) root = createRoot(slot)
    root.render(createElement(HostEntryButton, { className, label, open }))
  }

  /**
   * The header's action strip and its last button (the add control), found from
   * the footer slot upwards. A region that is not mounted (or a release whose
   * markup moved) answers null, which the caller reads as "no header seat".
   */
  const find = (): { actions: Element; add: HTMLButtonElement } | null => {
    let node: Element | null = home.parentElement
    while (node !== null && node !== document.body) {
      const header = node.querySelector('[class*="_sectionHeader"]')
      if (header !== null) {
        const actions = header.querySelector('[class*="_headerActions"]')
        if (actions === null) return null
        const buttons = [...actions.querySelectorAll('button')]
          .filter(button => !button.classList.contains('dww-header-entry'))
        const add = buttons.at(-1)
        return add === undefined ? null : { actions, add }
      }
      node = node.parentElement
    }
    return null
  }

  let observer: MutationObserver | null = null
  let observed: Element | null = null
  let present = false
  const seat = (value: boolean): void => {
    if (present === value) return
    present = value
    onSeat(value)
  }
  const ensure = (): void => {
    const found = find()
    if (found === null) {
      slot.remove()
      seat(false)
      if (observer !== null) {
        observer.disconnect()
        observer = null
        observed = null
      }
      return
    }
    if (slot.parentElement !== found.actions) found.actions.appendChild(slot)
    draw(found.add.className, options.label())
    if (observed !== found.actions) {
      // The strip is re-rendered by React whenever the sidebar's search state or
      // the workspace list changes, and that drops unknown children with it.
      if (observer !== null) observer.disconnect()
      observed = found.actions
      observer = new Observer(() => ensure())
      observer.observe(observed, { childList: true })
    }
    seat(true)
  }
  ensure()
  // The seat can also be absent at mount (the region renders after the footer
  // slot) and can come back later, which no observer on a missing strip sees.
  // One body observer covers both, and a microtask coalesces a React commit's
  // many mutations into one pass.
  let queued = false
  const schedule = (): void => {
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      ensure()
    })
  }
  const bodyObserver = new Observer(schedule)
  bodyObserver.observe(document.body, { childList: true, subtree: true })
  return () => {
    bodyObserver.disconnect()
    if (observer !== null) observer.disconnect()
    // The header is host markup; the root this plugin opened inside it must go too.
    if (root !== null) root.unmount()
    root = null
    slot.remove()
  }
}
