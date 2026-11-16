/**
 * dsh-mimo-credits — Client half.
 *
 * Two registrations share one store:
 *
 *   sidebar.footer.action    the quota widget at the left sidebar foot, above
 *                            Settings (root scope: always visible; the owner
 *                            passes `wide` for the expanded column vs the
 *                            56px rail)
 *   settings.general.item    the "MiMo plan credits" row in Settings → General
 *                            for the key
 *
 * Quota data arrives from the Host route `api/mimo.quota` (a relative path:
 * the served index carries `<base href="./">`, so it resolves under whatever
 * prefix this deployment is mounted at). The API key never crosses the wire
 * to this half; only the quota payload and the key's configured/source facts.
 *
 * Styling uses harness theme tokens only; copy goes through the Client locale
 * service under the `mimoCredits` namespace.
 */

window.__ModuleLoader__.load({
  id: 'dsh-mimo-credits',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState } = React

    const NS = 'mimoCredits'
    /** Relative to the document base; same-origin, session cookie attached. */
    const ROUTE = 'api/mimo.quota'
    const REFRESH_MS = 5 * 60 * 1000
    const CONSOLE_URL = 'https://platform.xiaomimimo.com/token-plan'

    const en = {
      'bar.idle': 'MiMo plan credits — click to refresh',
      'bar.loading': 'Refreshing MiMo plan credits…',
      'bar.refresh': 'Refresh MiMo plan credits',
      'bar.title': 'Plan {plan} · {remaining} / {total} credits left ({usedPercent}% used) · period {start} ~ {end}',
      'error.missingKey': 'No API key configured — add one in Settings → General',
      'error.invalidKey': 'MiMo rejected the API key — check it in Settings → General',
      'error.upstream': 'The MiMo API returned an error',
      'error.unreachable': 'Cannot reach the MiMo API — click the bar to retry',
      'error.unauthorized': 'This session is not authenticated',
      'error.generic': 'Plan credits unavailable',
      'key.title': 'MiMo plan credits',
      'key.desc': 'Progress bar in the session header. Token Plan API key:',
      'key.console': 'Token Plan console',
      'key.checking': 'Checking the API key…',
      'key.unknown': 'Could not read the API key status',
      'key.stored': 'API key saved in the DSH credential store',
      'key.env': 'API key comes from the MIMO_API_KEY environment variable',
      'key.missing': 'No API key configured yet',
      'key.placeholder': 'tp-…',
      'key.aria': 'Token Plan API key',
      'key.save': 'Save',
      'key.saving': 'Saving…',
      'key.clear': 'Clear',
      'key.required': 'Enter an API key first',
      'key.saved': 'Saved — refreshing the quota',
      'key.cleared': 'Removed',
      'key.saveFailed': 'Could not save the API key',
      'key.clearFailed': 'Could not remove the API key',
    }

    const zh = {
      'bar.idle': 'MiMo 套餐额度 — 点击刷新',
      'bar.loading': '正在刷新 MiMo 套餐额度…',
      'bar.refresh': '刷新 MiMo 套餐额度',
      'bar.title': '套餐 {plan} · 剩余 {remaining} / {total} 积分（已用 {usedPercent}%）· 周期 {start} ~ {end}',
      'error.missingKey': '未配置 API Key — 请到 设置 → 通用设置 录入',
      'error.invalidKey': 'API Key 被 MiMo 拒绝 — 请到 设置 → 通用设置 检查',
      'error.upstream': 'MiMo 接口返回错误',
      'error.unreachable': '无法连接 MiMo 接口 — 点击进度条重试',
      'error.unauthorized': '当前会话未通过认证',
      'error.generic': '暂无法获取套餐额度',
      'key.title': 'MiMo 套餐额度',
      'key.desc': '在会话导航栏显示剩余额度进度条。Token Plan API Key：',
      'key.console': 'Token Plan 控制台',
      'key.checking': '正在检查 API Key…',
      'key.unknown': '无法获取 API Key 状态',
      'key.stored': 'API Key 已保存到 DSH 凭据存储',
      'key.env': 'API Key 来自环境变量 MIMO_API_KEY',
      'key.missing': '尚未配置 API Key',
      'key.placeholder': 'tp-…',
      'key.aria': 'Token Plan API Key',
      'key.save': '保存',
      'key.saving': '保存中…',
      'key.clear': '清除',
      'key.required': '请先输入 API Key',
      'key.saved': '已保存，正在刷新额度',
      'key.cleared': '已清除',
      'key.saveFailed': '保存 API Key 失败',
      'key.clearFailed': '清除 API Key 失败',
    }

    /** Server error codes → locale keys; anything else reads as generic. */
    const ERROR_TEXT = {
      'missing-key': 'error.missingKey',
      'invalid-key': 'error.invalidKey',
      'upstream-error': 'error.upstream',
      'upstream-unreachable': 'error.unreachable',
      unauthorized: 'error.unauthorized',
    }

    function errorText(code, t) {
      return t(ERROR_TEXT[code] ?? 'error.generic')
    }

    /** One snapshot store; every change replaces the snapshot reference. */
    const store = (() => {
      let snapshot = {
        quota: null, // last successful payload
        quotaCode: null, // last error code (stale quota is kept and flagged)
        quotaLoading: false,
        key: null, // { configured, source } from ?action=status
        keyLoading: false,
        keyError: false, // status could not be read (do not claim "missing")
        saving: false,
      }
      const listeners = new Set()
      return {
        get: () => snapshot,
        set(patch) {
          snapshot = { ...snapshot, ...patch }
          for (const listener of [...listeners]) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      }
    })()

    /** Subscribe a component to the shared store without React 18-only APIs. */
    function useStore(source) {
      const [, bump] = useState(0)
      useEffect(() => source.subscribe(() => bump((n) => n + 1)), [source])
      return source.get()
    }

    /** One same-origin call to the Host route; returns status plus parsed body. */
    async function call(path, { method = 'GET', body } = {}) {
      const response = await fetch(path, {
        method,
        credentials: 'same-origin',
        // A dangling connection must not pin quotaInflight forever.
        signal: AbortSignal.timeout(15_000),
        headers:
          body === undefined
            ? { accept: 'application/json' }
            : { accept: 'application/json', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      let parsed = null
      try {
        parsed = await response.json()
      } catch {
        // A non-JSON answer is reported through its status alone.
      }
      return { status: response.status, body: parsed }
    }

    let quotaInflight = null

    /**
     * Load quota; a failed refresh keeps the last good bar and flags the error.
     * Returns `{ ok: true }`, `{ ok: false, code }`, or `{ ok: null }` when a
     * refresh is already running and this caller joins nothing.
     * @param force - bypass the Host's 60-second cache.
     * @param join - wait for the running refresh first; used right after a key
     *   change so the reload never rides the previous credential's answer.
     */
    async function loadQuota(force = false, join = false) {
      if (quotaInflight !== null) {
        if (!join) return { ok: null }
        await quotaInflight
      }
      const run = (async () => {
        store.set({ quotaLoading: true })
        try {
          const { status, body } = await call(force ? `${ROUTE}?refresh=1` : ROUTE)
          if (body && body.ok === true) {
            store.set({ quota: body, quotaCode: null, quotaLoading: false })
            return { ok: true }
          }
          const code =
            body && typeof body.code === 'string'
              ? body.code
              : status === 401 || status === 403
                ? 'unauthorized'
                : 'upstream-error'
          store.set({ quotaCode: code, quotaLoading: false })
          return { ok: false, code }
        } catch {
          store.set({ quotaCode: 'unreachable', quotaLoading: false })
          return { ok: false, code: 'unreachable' }
        }
      })()
      quotaInflight = run
      try {
        return await run
      } finally {
        if (quotaInflight === run) quotaInflight = null
      }
    }

    /** Read whether a key is configured and where it comes from. */
    async function loadKeyStatus() {
      store.set({ keyLoading: true })
      try {
        const { body } = await call(`${ROUTE}?action=status`)
        if (body && body.ok === true && body.status) {
          store.set({ key: body.status, keyLoading: false, keyError: false })
        } else {
          store.set({ keyLoading: false, keyError: true })
        }
      } catch {
        store.set({ keyLoading: false, keyError: true })
      }
    }

    /** Persist the typed key, then re-read quota with the new credential. */
    async function saveKey(value) {
      store.set({ saving: true })
      try {
        const { body } = await call(ROUTE, { method: 'POST', body: { action: 'setKey', key: value } })
        if (body && body.ok === true) {
          store.set({
            key: body.status ?? { configured: true, source: 'record' },
            quota: null,
            quotaCode: null,
            keyError: false,
            saving: false,
          })
          const reload = await loadQuota(true, true)
          return { ok: true, quotaCode: reload && reload.ok === false ? reload.code : null }
        }
        store.set({ saving: false })
        return { ok: false, code: body && typeof body.code === 'string' ? body.code : 'save-failed' }
      } catch {
        store.set({ saving: false })
        return { ok: false, code: 'unreachable' }
      }
    }

    /** Drop the stored record; the environment fallback, if any, still applies. */
    async function clearKey() {
      store.set({ saving: true })
      try {
        const { body } = await call(ROUTE, { method: 'POST', body: { action: 'clearKey' } })
        if (!(body && body.ok === true)) {
          store.set({ saving: false })
          return { ok: false }
        }
        store.set({
          key: body.status ?? { configured: false, source: null },
          quota: null,
          quotaCode: null,
          keyError: false,
          saving: false,
        })
        const reload = await loadQuota(true, true)
        return { ok: true, quotaCode: reload && reload.ok === false ? reload.code : null }
      } catch {
        store.set({ saving: false })
        return { ok: false }
      }
    }

    function formatNumber(value, locale) {
      const tag = typeof locale === 'string' && locale ? locale.replace(/_/g, '-') : undefined
      try {
        return Number(value).toLocaleString(tag)
      } catch {
        return String(value)
      }
    }

    /** Period timestamps are UTC `YYYY-MM-DD HH:mm:ss`; show the day only. */
    function formatDay(value) {
      const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''))
      if (match === null) return String(value ?? '') || '—'
      return `${match[1]}-${match[2]}-${match[3]}`
    }

    /** Fill color tracks the *remaining* ratio: green, then amber, then red. */
    function fillToken(percent) {
      if (percent === null) return 'var(--dsw-alias-state-idle-primary)'
      if (percent >= 50) return 'var(--dsw-alias-state-success-primary)'
      if (percent >= 20) return 'var(--dsw-alias-state-warn-primary)'
      return 'var(--dsw-alias-state-error-primary)'
    }

    /** Hover copy: full detail with quota, or the reason none is shown. */
    function barTitle(snap, t, getLocale) {
      const quota = snap.quota
      let text
      if (quota !== null) {
        const total = Number(quota.totalCredits) || 0
        const usedRaw = total > 0 ? (Number(quota.usedCredits) / total) * 100 : 0
        const usedPercent = Math.min(100, Math.max(0, Math.round(usedRaw * 10) / 10))
        const locale = getLocale()
        text = t('bar.title', {
          plan: quota.planCode || '—',
          remaining: formatNumber(quota.remainingCredits, locale),
          total: formatNumber(quota.totalCredits, locale),
          usedPercent: String(usedPercent),
          start: formatDay(quota.startAt),
          end: formatDay(quota.endAt),
        })
        if (snap.quotaCode) text += `\n${errorText(snap.quotaCode, t)}`
        return text
      }
      if (snap.quotaCode) return errorText(snap.quotaCode, t)
      if (snap.quotaLoading) return t('bar.loading')
      return t('bar.idle')
    }

    /** Component-local styles; removed with the component on unmount. */
    const FOOT_STYLE = `
.dsh-mimo-foot { display: flex; flex-direction: column; gap: 4px; width: 100%; box-sizing: border-box; font: inherit; text-align: left; background: transparent; border: none; padding: 6px 8px; min-height: 24px; border-radius: var(--dsw-radius-sm, 6px); cursor: pointer; color: var(--dsw-alias-label-secondary); }
.dsh-mimo-foot:hover { background: var(--dsw-alias-bg-layer-2); }
.dsh-mimo-foot:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.dsh-mimo-foot-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.dsh-mimo-foot-label { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-mimo-foot-pct { font-size: 12px; line-height: 16px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary); flex-shrink: 0; }
.dsh-mimo-foot-pct em { font-style: normal; font-weight: 700; color: var(--dsw-alias-state-error-primary); margin-left: 2px; }
.dsh-mimo-track { display: block; height: 4px; border-radius: 2px; background: var(--dsw-alias-border-l1); overflow: hidden; }
.dsh-mimo-fill { display: block; height: 100%; border-radius: 2px; transition: width 0.3s ease; }
.dsh-mimo-foot.dsh-mimo-rail { align-items: center; justify-content: center; padding: 4px; }
.dsh-mimo-foot.dsh-mimo-rail .dsh-mimo-foot-pct { text-align: center; }
`

    const ROW_STYLE = `
.dsh-mimo-keyrow { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 16px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-mimo-keyrow .mimo-text { min-width: 0; }
.dsh-mimo-keyrow .mimo-title { font-size: 14px; line-height: 20px; color: var(--dsw-alias-label-primary); }
.dsh-mimo-keyrow .mimo-desc { margin-top: 4px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.dsh-mimo-keyrow .mimo-status { margin-top: 4px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.dsh-mimo-keyrow .mimo-msg { margin-top: 4px; font-size: 12px; line-height: 18px; }
.dsh-mimo-keyrow .mimo-msg.err { color: var(--dsw-alias-state-error-primary); }
.dsh-mimo-keyrow .mimo-msg.ok { color: var(--dsw-alias-state-success-primary); }
.dsh-mimo-keyrow a.mimo-link { color: var(--dsw-alias-state-business-primary); text-decoration: underline; text-underline-offset: 2px; }
.dsh-mimo-controls { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; flex-shrink: 0; }
.dsh-mimo-input { box-sizing: border-box; width: 190px; padding: 5px 8px; font-size: 12px; line-height: 18px; font-family: inherit; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm, 6px); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); outline: none; }
.dsh-mimo-input:focus-visible { border-color: var(--dsw-alias-state-business-primary); }
.dsh-mimo-input::placeholder { color: var(--dsw-alias-label-secondary); }
.dsh-mimo-btn { font: inherit; font-size: 12px; line-height: 18px; padding: 5px 12px; border-radius: var(--dsw-radius-sm, 6px); border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; white-space: nowrap; }
.dsh-mimo-btn:hover:not(:disabled) { border-color: var(--dsw-alias-label-secondary); }
.dsh-mimo-btn:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.dsh-mimo-btn:disabled { opacity: 0.55; cursor: default; }
.dsh-mimo-btn.mimo-primary { background: var(--dsw-alias-button-primary-fill); border-color: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.dsh-mimo-btn.mimo-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); border-color: var(--dsw-alias-button-primary-hover); }
`

    /**
     * The sidebar-foot quota widget: label + percentage + progress bar in the
     * expanded column, a centered percentage in the 56px rail. Click forces a
     * refresh; hover carries the full detail or the failure reason.
     * @param props - `wide` from the slot owner (column state), `t` from the
     *   registration's locale namespace, `getLocale` for number formatting.
     * @returns the widget button.
     */
    function QuotaBar({ wide, t, getLocale }) {
      const snap = useStore(store)
      useEffect(() => {
        void loadQuota()
        const timer = setInterval(() => {
          if (!document.hidden) void loadQuota()
        }, REFRESH_MS)
        const onVisible = () => {
          if (!document.hidden) void loadQuota()
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [])

      const expanded = wide !== false
      const quota = snap.quota
      const percent =
        quota === null ? null : Math.max(0, Math.min(100, Number(quota.percent) || 0))
      // An unconfigured key is a resting state, not an error: show the dash.
      const unconfigured = quota === null && snap.quotaCode === 'missing-key'
      const text =
        percent !== null
          ? `${Math.round(percent)}%`
          : snap.quotaLoading
            ? '…'
            : unconfigured || !snap.quotaCode
              ? '—'
              : '!'
      const title = barTitle(snap, t, getLocale)
      const numberColor =
        text === '!' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-primary)'
      // Refreshing with data dims the content; a failed refresh flags the number.
      const dimmed = snap.quotaLoading && percent !== null
      const flagged = percent !== null && snap.quotaCode !== null

      const percentNode = h(
        'span',
        {
          className: 'dsh-mimo-foot-pct',
          style: { color: numberColor, opacity: dimmed ? 0.55 : 1 },
        },
        text,
        flagged
          ? h('em', { 'aria-hidden': 'true' }, '!')
          : null,
      )

      return h(
        React.Fragment,
        null,
        h('style', null, FOOT_STYLE),
        h(
          'button',
          {
            type: 'button',
            className: expanded ? 'dsh-mimo-foot' : 'dsh-mimo-foot dsh-mimo-rail',
            'data-dsh-mimo-quota': text,
            title,
            'aria-label': title.replace(/\n+/g, ' · '),
            onClick: () => {
              void loadQuota(true)
            },
          },
          expanded
            ? h(
                'span',
                { className: 'dsh-mimo-foot-head', style: { opacity: dimmed ? 0.55 : 1 } },
                h('span', { className: 'dsh-mimo-foot-label' }, t('key.title')),
                percentNode,
              )
            : percentNode,
          expanded
            ? h(
                'span',
                { className: 'dsh-mimo-track', style: { opacity: dimmed ? 0.55 : 1 } },
                h('span', {
                  className: 'dsh-mimo-fill',
                  style: {
                    width: percent === null ? '0%' : `${percent}%`,
                    background: fillToken(percent),
                  },
                }),
              )
            : null,
        ),
      )
    }

    /**
     * The Settings → General row: shows where the key comes from and takes a
     * new one. The value is sent to the Host route and never rendered back.
     * @param props - `t` from the registration's locale namespace.
     * @returns the preference row.
     */
    function KeyRow({ t }) {
      const snap = useStore(store)
      const [value, setValue] = useState('')
      const [message, setMessage] = useState(null)
      useEffect(() => {
        void loadKeyStatus()
      }, [])

      const status = snap.key
      const statusText =
        status !== null && status.configured === true
          ? status.source === 'record'
            ? t('key.stored')
            : t('key.env')
          : snap.keyError && status === null
            ? t('key.unknown')
            : snap.keyLoading && status === null
              ? t('key.checking')
              : t('key.missing')

      const onSave = async () => {
        const key = value.trim()
        if (key.length === 0) {
          setMessage({ kind: 'err', text: t('key.required') })
          return
        }
        setMessage(null)
        const result = await saveKey(key)
        if (result.ok) {
          setValue('')
          // The key is stored; the reload now reports whether MiMo accepts it.
          if (result.quotaCode && result.quotaCode !== 'missing-key') {
            setMessage({ kind: 'err', text: errorText(result.quotaCode, t) })
          } else {
            setMessage({ kind: 'ok', text: t('key.saved') })
          }
        } else {
          setMessage({
            kind: 'err',
            text:
              result.code === 'unreachable'
                ? t('error.unreachable')
                : result.code === 'bad-key'
                  ? t('key.required')
                  : t('key.saveFailed'),
          })
        }
      }

      const onClear = async () => {
        setMessage(null)
        const result = await clearKey()
        if (!result.ok) {
          setMessage({ kind: 'err', text: t('key.clearFailed') })
          return
        }
        if (result.quotaCode && result.quotaCode !== 'missing-key') {
          setMessage({ kind: 'err', text: errorText(result.quotaCode, t) })
        } else {
          setMessage({ kind: 'ok', text: t('key.cleared') })
        }
      }

      return h(
        'div',
        { className: 'dsh-mimo-keyrow', 'data-dsh-mimo-keyrow': '' },
        h('style', null, ROW_STYLE),
        h(
          'div',
          { className: 'mimo-text' },
          h('div', { className: 'mimo-title' }, t('key.title')),
          h(
            'div',
            { className: 'mimo-desc' },
            `${t('key.desc')} `,
            h(
              'a',
              { className: 'mimo-link', href: CONSOLE_URL, target: '_blank', rel: 'noreferrer' },
              t('key.console'),
            ),
          ),
          h('div', { className: 'mimo-status' }, statusText),
          message === null
            ? null
            : h('div', { className: `mimo-msg ${message.kind}`, role: message.kind === 'err' ? 'alert' : 'status' }, message.text),
        ),
        h(
          'div',
          { className: 'dsh-mimo-controls' },
          h('input', {
            className: 'dsh-mimo-input',
            type: 'password',
            value,
            placeholder: t('key.placeholder'),
            'aria-label': t('key.aria'),
            autocomplete: 'new-password',
            spellcheck: false,
            maxlength: 1024,
            disabled: snap.saving,
            onChange: (event) => {
              setValue(event.target.value)
              if (message !== null) setMessage(null)
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter') void onSave()
            },
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-mimo-btn mimo-primary',
              disabled: snap.saving || value.trim().length === 0,
              onClick: () => void onSave(),
            },
            snap.saving ? t('key.saving') : t('key.save'),
          ),
          status !== null && status.source === 'record'
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-mimo-btn',
                  disabled: snap.saving,
                  onClick: () => void onClear(),
                },
                t('key.clear'),
              )
            : null,
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { en, zh }),
          'mimo-credits: dictionaries',
        )
        const getLocale = () => {
          try {
            return ctx.locale.getSnapshot().active
          } catch {
            return undefined
          }
        }

        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'mimo-credits',
              // Above Settings, below the cost-meter footer rows (0/1).
              order: 10,
              locale: NS,
              inject: () => ({ getLocale }),
            },
            QuotaBar,
          ),
        )

        ctx.slots.inject('settings.general.item', () =>
          ctx.slots.register(
            {
              name: 'settings.general.item',
              id: 'mimo-credits-key',
              order: 40,
              locale: NS,
            },
            KeyRow,
          ),
        )
      },
    }
  },
})
