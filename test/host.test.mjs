// Host-half test for dsh-mimo-credits. Run from the package root: node --test
import assert from "node:assert/strict"

const upstreamCalls = []
let upstreamMode = 'ok'

globalThis.fetch = async (url, init) => {
  upstreamCalls.push({ url: String(url), authorization: init?.headers?.authorization })
  if (upstreamMode === '401') {
    return new Response(JSON.stringify({ error: { message: 'Invalid API key.' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (upstreamMode === 'boom') return new Response('nope', { status: 500 })
  return new Response(
    JSON.stringify({
      object: 'token_plan',
      plan_code: 'pro',
      period: { start_at: '2026-09-21 23:59:59', end_at: '2027-09-21 23:59:59' },
      quota: { total_credits: 10000000, used_credits: 1500000, remaining_credits: 8500000 },
      auto_renew: false,
      claw_enabled: false,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

const record = { value: null }
let registered = null
let effectCleanups = []

const ctx = {
  credentials: {
    readRecord: async () => (record.value ? { kind: 'api-key', key: record.value } : undefined),
    resolve: async () => undefined,
    describeRecord: async () => ({ configured: record.value !== null, kind: 'api-key' }),
    describe: async () => ({ configured: false }),
    modifyRecord: async (_key, fn) => {
      const next = await fn(record.value ? { kind: 'api-key', key: record.value } : undefined)
      record.value = next?.key ?? null
    },
    deleteRecord: async () => {
      record.value = null
    },
  },
  connection: {
    fetch: {
      register: (route) => {
        registered = route
        return async () => {}
      },
    },
  },
  effect: (fn) => {
    const cleanup = fn()
    effectCleanups.push(cleanup)
    return () => {}
  },
}

const { apply } = await import('../index.js')
apply(ctx, {})

assert.ok(registered, 'route registered')
assert.equal(registered.path, '/api/mimo.quota')
assert.deepEqual([...registered.methods].sort(), ['GET', 'POST'])
assert.equal(registered.requestBody, 'buffered')

const get = (url) => registered.fetch(new Request(`https://dsh.test${url}`))
const post = (body) =>
  registered.fetch(
    new Request('https://dsh.test/api/mimo.quota', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

// 1. No key yet: structured missing-key, upstream untouched.
{
  const res = await get('/api/mimo.quota')
  const body = await res.json()
  assert.equal(res.status, 409)
  assert.deepEqual(body, { ok: false, code: 'missing-key' })
  assert.equal(upstreamCalls.length, 0)
}

// 2. status action reports absence without touching upstream.
{
  const res = await get('/api/mimo.quota?action=status')
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.deepEqual(body, { ok: true, status: { configured: false, source: null } })
  assert.equal(upstreamCalls.length, 0)
}

// 3. setKey stores the record.
{
  const res = await post({ action: 'setKey', key: '  tp-abc12345  ' })
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.deepEqual(body.status, { configured: true, source: 'record' })
  assert.equal(record.value, 'tp-abc12345')
}

// 4. A too-short key is refused before storage.
{
  const before = record.value
  const res = await post({ action: 'setKey', key: 'x' })
  assert.equal(res.status, 400)
  assert.equal(record.value, before)
}

// 5. GET quota: upstream called with Bearer, payload projected, percent = remaining ratio.
{
  const res = await get('/api/mimo.quota')
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.planCode, 'pro')
  assert.equal(body.totalCredits, 10000000)
  assert.equal(body.usedCredits, 1500000)
  assert.equal(body.remainingCredits, 8500000)
  assert.equal(body.percent, 85)
  assert.equal(body.startAt, '2026-09-21 23:59:59')
  assert.equal(body.endAt, '2027-09-21 23:59:59')
  assert.equal(body.autoRenew, false)
  assert.equal(body.keySource, 'record')
  assert.equal(upstreamCalls.length, 1)
  assert.equal(upstreamCalls[0].url, 'https://token-plan-cn.xiaomimimo.com/v1/platform/token_plan')
  assert.equal(upstreamCalls[0].authorization, 'Bearer tp-abc12345')
}

// 6. Second GET is served from cache.
{
  const res = await get('/api/mimo.quota')
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(upstreamCalls.length, 1, 'cache suppressed the upstream call')
}

// 7. refresh=1 bypasses the cache.
{
  const res = await get('/api/mimo.quota?refresh=1')
  assert.equal(res.status, 200)
  assert.equal(upstreamCalls.length, 2)
}

// 8. Upstream 401 maps to invalid-key with HTTP 401.
{
  upstreamMode = '401'
  const res = await get('/api/mimo.quota?refresh=1')
  const body = await res.json()
  assert.equal(res.status, 401)
  assert.deepEqual(body, { ok: false, code: 'invalid-key' })
}

// 9. Upstream 500 maps to upstream-error with its status surfaced.
{
  upstreamMode = 'boom'
  const res = await get('/api/mimo.quota?refresh=1')
  const body = await res.json()
  assert.equal(res.status, 502)
  assert.equal(body.ok, false)
  assert.equal(body.code, 'upstream-error')
  assert.equal(body.upstreamStatus, 500)
  upstreamMode = 'ok'
}

// 10. Unknown POST action is a bad request.
{
  const res = await post({ action: 'nope' })
  assert.equal(res.status, 400)
}

// 11. clearKey removes the record; status follows; quota then reports missing-key.
{
  const res = await post({ action: 'clearKey' })
  const body = await res.json()
  assert.deepEqual(body.status, { configured: false, source: null })
  assert.equal(record.value, null)
  const quota = await get('/api/mimo.quota?refresh=1')
  assert.equal(quota.status, 409)
}

// 12. Cleanups run without throwing.
for (const cleanup of effectCleanups) await cleanup()

console.log('dsh-mimo-credits host smoke test: all assertions passed')
