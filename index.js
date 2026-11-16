/**
 * dsh-mimo-credits — Host half.
 *
 * The MiMo Token Plan credits API (查询套餐余量, credits-get) answers with no
 * CORS headers — a browser preflight gets 404 and no `Access-Control-Allow-
 * Origin` — so the browser cannot call it directly. This half owns the call:
 * it registers one exact Fetch route on DSH's authenticated `/api` channel
 * (the carrier the shell's own browser calls use, so the Host/Origin trust
 * fence and the signed browser cookie gate every request before this plugin
 * sees it, and only owner Peers reach an exact route), and it keeps the
 * Token Plan API key in the credential store, never in configuration.
 *
 * Fail soft, never fail the boot: a missing service, a duplicate route or a
 * broken upstream leaves DSH running with one log line. No secret is ever
 * logged; the key travels only from the store to the upstream header.
 */

import { readFileSync } from "node:fs";

export const name = "mimo-credits";
/** The plugin stays inactive without the authenticated channel and the credential store. */
export const inject = ["connection", "credentials"];

/** Exact route on the shared /api channel; the client calls it same-origin. */
const ROUTE = "/api/mimo.quota";
/** POSIX-style reference name; matches dsh-credentials' CredentialRef grammar. */
const KEY_REF = "MIMO_API_KEY";
/** Stored-record address `<scope>/<id>`; matches dsh-credentials' CredentialKey grammar. */
const KEY_RECORD = "mimo-credits/api-key";
/** Default upstream root; a row's `config.baseUrl` overrides it. */
const DEFAULT_BASE_URL = "https://token-plan-cn.xiaomimimo.com";
/** Official 查询套餐余量 path appended to the base URL. */
const QUOTA_PATH = "/v1/platform/token_plan";
const UPSTREAM_TIMEOUT_MS = 10_000;
/** Server-side cache: the header widget polls, several tabs share one answer. */
const CACHE_TTL_MS = 60_000;

/** This package's version, read once so a support log says which build is loaded. */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

/** Answer one request with a JSON body. */
function json(value, status) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Normalize the configured upstream root; a malformed value falls back to the
 * documented default instead of taking the plugin down.
 * @param value - `config.baseUrl` from the patch row, when present.
 * @returns a base URL with no trailing slash.
 */
function normalizeBaseUrl(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_BASE_URL;
  try {
    return new URL(String(value)).href.replace(/\/+$/, "");
  } catch {
    console.error(
      `[mimo-credits] config.baseUrl ${JSON.stringify(value)} is not a URL; using ${DEFAULT_BASE_URL}`,
    );
    return DEFAULT_BASE_URL;
  }
}

/**
 * The stored record outranks the environment reference, mirroring the
 * credential seam's own precedence for a rotated key.
 * @param credentials - the credential service.
 * @returns `{ key, source }`, or null when neither source holds a value.
 */
async function readKey(credentials) {
  try {
    const record = await credentials.readRecord(KEY_RECORD);
    if (record?.kind === "api-key" && typeof record.key === "string" && record.key.length > 0) {
      return { key: record.key, source: "record" };
    }
  } catch (error) {
    console.error(`[mimo-credits] credential record read failed: ${error?.message ?? error}`);
  }
  try {
    const hit = await credentials.resolve(KEY_REF);
    if (typeof hit?.value === "string" && hit.value.length > 0) {
      return { key: hit.value, source: hit.source ?? "env" };
    }
  } catch (error) {
    console.error(`[mimo-credits] credential reference resolve failed: ${error?.message ?? error}`);
  }
  return null;
}

/**
 * Whether a key is configured, and where it comes from — never the value.
 * @param credentials - the credential service.
 * @returns `{ configured, source }`.
 */
async function keyStatus(credentials) {
  try {
    const record = await credentials.describeRecord(KEY_RECORD);
    if (record?.configured === true) return { configured: true, source: "record" };
  } catch {
    // A status view must survive a storage hiccup; the quota path reports its own errors.
  }
  try {
    const info = await credentials.describe(KEY_REF);
    if (info?.configured === true) return { configured: true, source: info.source ?? "env" };
  } catch {
    // Same: absence is reported as "not configured", never as a crash.
  }
  return { configured: false, source: null };
}

/**
 * Project one upstream body into the wire payload the client renders.
 * @param body - parsed upstream JSON.
 * @returns the quota fields, or null when the body carries no usable numbers.
 */
function normalizeQuota(body) {
  const quota = body?.quota;
  const total = Number(quota?.total_credits);
  const used = Number(quota?.used_credits);
  const remaining = Number(quota?.remaining_credits);
  if (!Number.isFinite(total) || !Number.isFinite(used) || !Number.isFinite(remaining)) return null;
  const safeTotal = Math.max(0, total);
  const percent = safeTotal > 0 ? Math.round((Math.max(0, remaining) / safeTotal) * 1000) / 10 : 0;
  return {
    planCode: typeof body?.plan_code === "string" ? body.plan_code : "",
    totalCredits: total,
    usedCredits: used,
    remainingCredits: remaining,
    percent,
    startAt: typeof body?.period?.start_at === "string" ? body.period.start_at : "",
    endAt: typeof body?.period?.end_at === "string" ? body.period.end_at : "",
    autoRenew: body?.auto_renew === true,
    clawEnabled: body?.claw_enabled === true,
  };
}

/**
 * Call the official credits-get endpoint with the resolved key.
 * @param baseUrl - normalized upstream root.
 * @param key - the Token Plan API key; never logged, never stored here.
 * @returns `{ quota }` on success, or `{ code, upstreamStatus? }` for the client's error mapping.
 */
async function requestQuota(baseUrl, key) {
  let response;
  try {
    response = await fetch(`${baseUrl}${QUOTA_PATH}`, {
      method: "GET",
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    // The message names the URL and the network failure only; the key is in
    // neither, and nothing else about the request is sensitive.
    console.error(`[mimo-credits] upstream unreachable: ${error?.message ?? error}`);
    return { code: "upstream-unreachable" };
  }
  if (response.status === 401 || response.status === 403) return { code: "invalid-key" };
  if (!response.ok) {
    console.error(`[mimo-credits] upstream answered HTTP ${response.status}`);
    return { code: "upstream-error", upstreamStatus: response.status };
  }
  let body;
  try {
    body = await response.json();
  } catch {
    return { code: "upstream-error", upstreamStatus: response.status };
  }
  const quota = normalizeQuota(body);
  if (quota === null) {
    console.error("[mimo-credits] upstream body carried no usable quota fields");
    return { code: "upstream-error", upstreamStatus: response.status };
  }
  return { quota };
}

export function apply(ctx, config = {}) {
  const baseUrl = normalizeBaseUrl(config?.baseUrl);

  // Cache and single-flight live in the apply closure: one plugin instance,
  // one upstream answer shared by every tab and by the widget's poll. The
  // generation counter retires answers started under a previous key, so a
  // save or clear can never leave the old credential's payload in the cache.
  let cache = null; // { at, quota }
  let inflight = null;
  let keyGeneration = 0;

  /** Answer one authenticated request: GET quota/status, POST setKey/clearKey. */
  async function handle(request) {
    try {
      if (request.method === "POST") return await handleAction(request);
      if (request.method !== "GET") return json({ ok: false, code: "method-not-allowed" }, 405);
      const url = new URL(request.url);
      if (url.searchParams.get("action") === "status") {
        return json({ ok: true, status: await keyStatus(ctx.credentials) }, 200);
      }
      const found = await readKey(ctx.credentials);
      if (found === null) return json({ ok: false, code: "missing-key" }, 409);
      const force = url.searchParams.get("refresh") === "1";
      if (!force && cache !== null && Date.now() - cache.at < CACHE_TTL_MS) {
        return json({ ok: true, ...cache.quota, keySource: found.source, cachedAt: cache.at }, 200);
      }
      const generation = keyGeneration;
      let run = inflight;
      if (run === null) {
        run = requestQuota(baseUrl, found.key);
        inflight = run;
        // Identity-checked: a retired run must not clear a newer one.
        void run.finally(() => {
          if (inflight === run) inflight = null;
        });
      }
      const result = await run;
      if (result.quota !== undefined) {
        const at = Date.now();
        if (generation === keyGeneration) cache = { at, quota: result.quota };
        return json({ ok: true, ...result.quota, keySource: found.source, cachedAt: at }, 200);
      }
      const status = result.code === "invalid-key" ? 401 : 502;
      return json(
        {
          ok: false,
          code: result.code,
          ...(result.upstreamStatus === undefined ? {} : { upstreamStatus: result.upstreamStatus }),
        },
        status,
      );
    } catch (error) {
      console.error(`[mimo-credits] quota route failed: ${error?.message ?? error}`);
      return json({ ok: false, code: "internal-error" }, 500);
    }
  }

  /** Store or remove the key; the client refreshes quota right after and reports the outcome. */
  async function handleAction(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, code: "bad-request" }, 400);
    }
    const action = typeof body?.action === "string" ? body.action : "";
    if (action === "setKey") {
      const key = typeof body?.key === "string" ? body.key.trim() : "";
      if (key.length < 4) return json({ ok: false, code: "bad-key" }, 400);
      await ctx.credentials.modifyRecord(KEY_RECORD, async () => ({ kind: "api-key", key }));
      keyGeneration += 1;
      cache = null;
      inflight = null;
      return json({ ok: true, status: await keyStatus(ctx.credentials) }, 200);
    }
    if (action === "clearKey") {
      await ctx.credentials.deleteRecord(KEY_RECORD);
      keyGeneration += 1;
      cache = null;
      inflight = null;
      return json({ ok: true, status: await keyStatus(ctx.credentials) }, 200);
    }
    return json({ ok: false, code: "bad-request" }, 400);
  }

  try {
    const dispose = ctx.connection.fetch.register({
      path: ROUTE,
      methods: ["GET", "POST"],
      requestBody: "buffered",
      fetch: handle,
    });
    // The disposer is async; keep the effect cleanup synchronous and log a
    // failed withdraw rather than letting it reject into the loader.
    ctx.effect(
      () => () => {
        Promise.resolve(dispose()).catch((error) => {
          console.error(`[mimo-credits] route withdraw failed: ${error?.message ?? error}`);
        });
      },
      "mimo-credits: quota route",
    );
  } catch (error) {
    console.error(
      `[mimo-credits] could not register ${ROUTE}: ${error?.message ?? error}; quota display stays off`,
    );
    return;
  }

  console.log(`[mimo-credits] active — v${VERSION}, route ${ROUTE}, upstream ${baseUrl}`);
}

export default { name, inject, apply };
