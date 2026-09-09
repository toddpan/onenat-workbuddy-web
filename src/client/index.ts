/**
 * @dsh-external/onenat-workbuddy — DSH Web GUI 集成。
 *
 * 将 /onenat-workbuddy 工作台嵌入 Web 页面：
 *  1. 侧栏入口行（plain DOM + MutationObserver 自愈，与 task-board / ssh / orchestrator 同一模式）；
 *  2. 中央列接管面板（html[data-dsh-workbuddy-active] 属性作用域显示规则），
 *     内嵌 iframe 加载工作台，带刷新 / 全屏 / 关闭操作；
 *  3. sidebar.footer.action 席位注册（第二入口）。
 */

export const inject = ['slots', 'locale']

import React from 'react'

type WbContext = {
  slots: {
    inject(slot: string, factory: () => (() => void) | void): () => void
    register(config: Record<string, unknown>, component: unknown): () => void
  }
  locale?: { subscribe(listener: () => void): () => void }
  effect(fn: () => () => void, name: string): () => void
}

const PANEL_NAME = 'workbuddy'
const ACTIVE_ATTR = 'data-dsh-workbuddy-active'
const OTHER_ACTIVE_ATTRS = [
  'data-dsh-taskboard-active',
  'data-dsh-ssh-active',
  'data-dsh-orchestrator-active',
]
const ACTIVATE_EVENT = 'dsh-panel-activate'
const CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]'
const ENTRY_SELECTOR = '[data-dsh-workbuddy-entry]'
const CONSOLE_PATH = '/onenat-workbuddy'

const FAMILY_SELECTORS = [
  '[data-dsh-taskboard-entry]',
  '[data-dsh-ssh-entry]',
  '[data-dsh-orchestrator-entry]',
  '[data-dsh-workbuddy-entry]',
]

const ICON =
  '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="1.8" y="2.6" width="12.4" height="10.8" rx="2"/><path d="M4.6 6.2h4.2"/><path d="M4.6 9h6.8"/><circle cx="12.6" cy="6.2" r=".9" fill="currentColor" stroke="none"/></svg>'

const CSS = `
[data-pane='conversation'], [class*='centerCol'] { position: relative; }
[data-dsh-workbuddy-view] {
  position: absolute; inset: 0; display: none; z-index: 60;
  flex-direction: column;
  background: #0b1220;
}
html[data-dsh-workbuddy-active]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]):not([data-dsh-orchestrator-active]) [data-dsh-workbuddy-view] { display: flex; }
html[data-dsh-workbuddy-active]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]):not([data-dsh-orchestrator-active]) [data-pane='conversation'] > :not([data-dsh-workbuddy-view]),
html[data-dsh-workbuddy-active]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]):not([data-dsh-orchestrator-active]) [class*='centerCol'] > :not([data-dsh-workbuddy-view]) { display: none !important; }
.wb-panel-header {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 14px; min-height: 40px; box-sizing: border-box;
  background: #101a2e; border-bottom: 1px solid #233250;
  color: #e8eefc; font-family: sans-serif; font-size: 13px;
  flex: none;
}
.wb-panel-title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wb-panel-spacer { flex: 1; }
.wb-panel-btn {
  background: #0284c7; color: #fff; border: none; border-radius: 6px;
  padding: 5px 10px; font-size: 12px; cursor: pointer; white-space: nowrap;
  font-family: inherit;
}
.wb-panel-btn.ghost { background: transparent; border: 1px solid #2f4266; color: #9fb0cc; }
.wb-panel-btn.close { background: transparent; border: 1px solid #475569; color: #e2e8f0; padding: 5px 8px; }
.wb-panel-btn:hover { filter: brightness(1.15); }
.wb-panel-frame { flex: 1; width: 100%; border: none; background: #0b1220; }
[data-dsh-workbuddy-entry] {
  box-sizing: border-box; display: flex; align-items: center; gap: 10px;
  width: 100%; min-height: 36px; padding: 0 10px;
  background: transparent; border: none; border-radius: 8px;
  color: var(--dsw-alias-label-secondary, #94a3b8); cursor: pointer;
  font-size: 13px; white-space: nowrap; font-family: inherit; text-align: left;
}
[data-dsh-workbuddy-entry]:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(148, 163, 184, 0.12));
  color: var(--dsw-alias-label-primary, #e2e8f0);
}
[data-dsh-workbuddy-entry][data-active] {
  background: var(--dsw-alias-interactive-bg-active, rgba(148, 163, 184, 0.2));
  color: var(--dsw-alias-label-primary, #e2e8f0); font-weight: 600;
}
.wb-entry-icon { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; flex: none; }
.wb-entry-icon svg { display: block; width: 18px; height: 18px; }
.wb-entry-label { overflow: hidden; text-overflow: ellipsis; }
[data-dsh-frame][data-sidebar-collapsed] [data-dsh-workbuddy-entry] {
  justify-content: center; padding: 0; width: 36px; min-height: 36px;
  margin: 0 auto 12px; border-radius: 50%;
}
[data-dsh-frame][data-sidebar-collapsed] .wb-entry-label { display: none; }
`

function injectStyles(): () => void {
  const existing = document.querySelector('style[data-plugin-css="onenat-workbuddy/workbuddy.css"]')
  if (existing !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = 'onenat-workbuddy'
  tag.dataset.pluginCss = 'onenat-workbuddy/workbuddy.css'
  tag.textContent = CSS
  document.head.appendChild(tag)
  return () => {
    tag.remove()
  }
}

function createPanelController() {
  let open = false
  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        /* ignore */
      }
    }
  }
  return {
    get isOpen(): boolean {
      return open
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    open(): void {
      if (open) return
      open = true
      emit()
    },
    close(): void {
      if (!open) return
      open = false
      emit()
    },
    toggle(): void {
      open = !open
      emit()
    },
  }
}

type PanelController = ReturnType<typeof createPanelController>

function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (column === null) return undefined
  const logoOwner = column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement
  return logoOwner ?? (column.firstElementChild as HTMLElement | undefined)
}

function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>('button[class*="newSession"]')
  if (nested !== null) return nested
  for (const child of root.children) {
    if (child.tagName === 'BUTTON') return child as HTMLButtonElement
  }
  return undefined
}

function mountSidebarEntry(controller: PanelController, locale?: WbContext['locale']): () => void {
  if (document.querySelector(ENTRY_SELECTOR) !== null) return () => {}
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.setAttribute('data-dsh-workbuddy-entry', '')
  entry.setAttribute('data-dsh-plugin', 'onenat-workbuddy')
  entry.setAttribute('data-dsh-part', 'sidebar-entry')
  const iconSpan = document.createElement('span')
  iconSpan.className = 'wb-entry-icon'
  iconSpan.innerHTML = ICON
  const labelSpan = document.createElement('span')
  labelSpan.className = 'wb-entry-label'
  entry.append(iconSpan, labelSpan)
  const applyLabel = (): void => {
    labelSpan.textContent = 'WorkBuddy'
    entry.setAttribute('aria-label', 'OneNat 多智能体工作台')
    entry.setAttribute('title', 'OneNat WorkBuddy · 多智能体协作工作台')
  }
  applyLabel()
  entry.addEventListener('click', () => {
    controller.toggle()
  })

  let root: HTMLElement | undefined
  let placed = false
  const placeEntry = (): boolean => {
    const current = root
    if (current === undefined) return false
    const button = newSessionButton(current)
    if (button === undefined) return false
    if (entry.parentElement !== current) {
      const row = button.closest('[class*="logoRow"]')
      const base = row !== null && row.parentElement === current ? row : button
      const family = Array.from(current.children).filter(
        (el): el is HTMLElement => el instanceof HTMLElement && el.matches(FAMILY_SELECTORS.join(', ')),
      )
      const anchor =
        family.length > 0 ? family[family.length - 1]!.nextElementSibling : base.nextElementSibling
      current.insertBefore(entry, anchor)
    }
    return true
  }
  const tryPlace = (): void => {
    if (root !== undefined && !root.isConnected) {
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    if (placed) {
      if (document.body.contains(entry)) return
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    root ??= sidebarRoot()
    if (root === undefined) return
    placed = placeEntry()
    if (placed) rootObserver.observe(root, { childList: true, subtree: true })
  }
  const waitObserver = new MutationObserver(() => {
    tryPlace()
  })
  waitObserver.observe(document.body, { childList: true, subtree: true })
  const rootObserver = new MutationObserver(() => {
    if (root === undefined || !root.isConnected) {
      placed = false
      tryPlace()
      return
    }
    if (!root.contains(entry)) placed = placeEntry()
  })
  const unsubscribeActive = controller.subscribe(() => {
    if (controller.isOpen) entry.dataset.active = 'true'
    else delete entry.dataset.active
  })
  let unsubscribeLocale: (() => void) | undefined
  if (locale !== undefined) {
    try {
      unsubscribeLocale = locale.subscribe(applyLabel)
    } catch {
      /* locale absent */
    }
  }
  tryPlace()
  return () => {
    waitObserver.disconnect()
    rootObserver.disconnect()
    unsubscribeActive()
    unsubscribeLocale?.()
    entry.remove()
  }
}

function buildPanel(controller: PanelController): HTMLElement {
  const container = document.createElement('div')
  container.dataset.dshWorkbuddyView = ''
  container.dataset.dshPlugin = 'onenat-workbuddy'

  const header = document.createElement('div')
  header.className = 'wb-panel-header'
  const title = document.createElement('span')
  title.className = 'wb-panel-title'
  title.textContent = '⚡ OneNat WorkBuddy · 多智能体协作工作台'
  const spacer = document.createElement('span')
  spacer.className = 'wb-panel-spacer'
  const refreshBtn = document.createElement('button')
  refreshBtn.className = 'wb-panel-btn ghost'
  refreshBtn.textContent = '刷新'
  const openBtn = document.createElement('button')
  openBtn.className = 'wb-panel-btn'
  openBtn.textContent = '新标签页全屏 ↗'
  const closeBtn = document.createElement('button')
  closeBtn.className = 'wb-panel-btn close'
  closeBtn.textContent = '✕'
  const iframe = document.createElement('iframe')
  iframe.className = 'wb-panel-frame'
  iframe.src = CONSOLE_PATH
  iframe.title = 'OneNat WorkBuddy 工作台'
  refreshBtn.addEventListener('click', () => {
    iframe.src = CONSOLE_PATH
  })
  openBtn.addEventListener('click', () => {
    window.open(CONSOLE_PATH, '_blank')
  })
  closeBtn.addEventListener('click', () => {
    controller.close()
  })
  header.append(title, spacer, refreshBtn, openBtn, closeBtn)
  container.append(header, iframe)
  return container
}

function mountPanel(controller: PanelController): () => void {
  let container: HTMLDivElement | undefined
  const ensure = (): void => {
    if (container !== undefined) {
      if (container.isConnected) return
      container.remove()
      container = undefined
    }
    const column = document.querySelector<HTMLElement>(CONVERSATION_COLUMN_SELECTOR)
    if (column === null) return
    container = buildPanel(controller) as HTMLDivElement
    column.appendChild(container)
  }
  const waitObserver = new MutationObserver(() => {
    ensure()
  })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  const applyActive = (): void => {
    if (controller.isOpen) {
      for (const attr of OTHER_ACTIVE_ATTRS) document.documentElement.removeAttribute(attr)
      document.documentElement.setAttribute(ACTIVE_ATTR, '')
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
    } else {
      document.documentElement.removeAttribute(ACTIVE_ATTR)
    }
  }
  const onOtherActivate = (event: Event): void => {
    const detail = (event as CustomEvent).detail
    if ((detail === 'taskboard' || detail === 'ssh' || detail === 'orchestrator') && controller.isOpen) controller.close()
  }
  const SIDEBAR_ROW_SELECTOR =
    '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'
  const onClickSidebarRow = (event: MouseEvent): void => {
    if (!controller.isOpen) return
    const target = event.target as HTMLElement | null
    if (target === null) return
    if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) controller.close()
  }
  document.addEventListener('click', onClickSidebarRow, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
  const unsubscribe = controller.subscribe(applyActive)
  applyActive()
  ensure()

  return () => {
    document.removeEventListener('click', onClickSidebarRow, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    waitObserver.disconnect()
    unsubscribe()
    document.documentElement.removeAttribute(ACTIVE_ATTR)
    container?.remove()
    container = undefined
  }
}

function FooterWorkBuddyEntry(props: { wide?: boolean; t?: (key: string, fallback: string) => string }) {
  const wide = props.wide ?? true
  const label = props.t !== undefined ? props.t('workbuddy.entry', 'WorkBuddy') : 'WorkBuddy'
  return React.createElement(
    'button',
    {
      type: 'button',
      title: 'OneNat WorkBuddy · 多智能体协作工作台',
      'aria-label': label,
      onClick: () => window.dispatchEvent(new CustomEvent('dsh-workbuddy-open')),
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: wide ? 'flex-start' : 'center',
        gap: '8px',
        width: '100%',
        minHeight: '32px',
        padding: wide ? '0 10px' : '0',
        background: 'transparent',
        border: 'none',
        borderRadius: '8px',
        color: 'var(--dsw-alias-label-secondary, #94a3b8)',
        cursor: 'pointer',
        fontSize: '12px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      },
    },
    React.createElement('span', {
      style: { display: 'inline-flex', width: '16px', height: '16px', flex: 'none' },
      dangerouslySetInnerHTML: { __html: ICON },
    }),
    wide ? React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, label) : null,
  )
}

export function apply(ctx: WbContext): void {
  const disposeStyles = injectStyles()
  ctx.effect(() => disposeStyles, 'onenat-workbuddy: styles')

  const controller = createPanelController()
  const disposers = [mountSidebarEntry(controller, ctx.locale), mountPanel(controller)]
  ctx.effect(
    () => () => {
      for (const dispose of disposers.splice(0)) dispose()
    },
    'onenat-workbuddy: sidebar entry + center panel',
  )

  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.footer.action', () => {
        // NOTE: `{ name: ... }` 必须与 register( 同行内联——注入器骨架校验
        // 用 register\({ 前缀正则匹配 slot 名，换行会导致重启恢复被跳过。
        const unregister = ctx.slots.register({ name: 'sidebar.footer.action', id: 'onenat-workbuddy', order: 130 }, FooterWorkBuddyEntry)
        return () => {
          unregister()
        }
      }),
    'onenat-workbuddy: footer entry',
  )

  const onOpenRequest = (): void => {
    controller.open()
  }
  window.addEventListener('dsh-workbuddy-open', onOpenRequest)
  ctx.effect(
    () => () => {
      window.removeEventListener('dsh-workbuddy-open', onOpenRequest)
    },
    'onenat-workbuddy: open-request bridge',
  )
}
