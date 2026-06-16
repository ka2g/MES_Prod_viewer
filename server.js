'use strict'

const path = require('path')

if (process.pkg) {
  require('dotenv').config({ path: path.join(path.dirname(process.execPath), '.env') })
} else {
  require('dotenv').config()
}

const express = require('express')
const mesRepository = require('./mesRepository')
const { attachLineStatus } = require('./lineActivity')
const envStore = require('./envStore')

const PORT = parseInt(process.env.PORT || '3000', 10)
const HOST = process.env.HOST || '0.0.0.0'
const POLL_MS = Math.max(
  2000,
  parseInt(process.env.MES_REFRESH_MS || '8000', 10) || 8000,
)
const ENV_REFRESH_MS = Math.max(
  5000,
  parseInt(process.env.ENV_REFRESH_MS || '15000', 10) || 15000,
)
const ENV_DEVICE_ID = String(process.env.ENV_DEVICE_ID || 'smt-01').trim()
const ENV_INGEST_KEY = String(process.env.ENV_INGEST_KEY || '').trim()
const ENV_HISTORY_HOURS = Math.min(
  168,
  Math.max(1, parseInt(process.env.ENV_HISTORY_HOURS || '24', 10) || 24),
)
const ENV_HISTORY_BUCKET_MIN = Math.max(
  1,
  parseInt(process.env.ENV_HISTORY_BUCKET_MIN || '5', 10) || 5,
)
const ENV_RETENTION_DAYS = Math.max(
  0,
  parseInt(process.env.ENV_RETENTION_DAYS || '90', 10) || 90,
)

const app = express()
app.disable('x-powered-by')
app.use(express.json())

/** @type {{ res: import('http').ServerResponse, phase: string }[]} */
const sseClients = []

/** @type {import('http').ServerResponse[]} */
const envSseClients = []

function clampNum(v, min, max) {
  if (!Number.isFinite(v)) return null
  return Math.min(max, Math.max(min, v))
}

function buildEnvPayload() {
  const latest = envStore.getLatest(ENV_DEVICE_ID)
  const history = envStore.getHistory(
    ENV_DEVICE_ID,
    ENV_HISTORY_HOURS,
    ENV_HISTORY_BUCKET_MIN,
  )
  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    deviceId: ENV_DEVICE_ID,
    latest: latest
      ? {
          ...latest,
          ts: latest.ts,
        }
      : null,
    history,
  }
}

function broadcastEnvSse() {
  let payload
  try {
    payload = buildEnvPayload()
  } catch (e) {
    payload = { ok: false, error: e.message, fetchedAt: new Date().toISOString() }
  }
  const data = `data: ${JSON.stringify(payload)}\n\n`
  for (const res of envSseClients) {
    try {
      res.write(data)
    } catch (_) {}
  }
}

function ingestKeyOk(req) {
  if (!ENV_INGEST_KEY) return true
  const key = req.get('X-Device-Key') || req.get('x-device-key') || ''
  return key === ENV_INGEST_KEY
}

function normalizePhaseQuery(q) {
  return mesRepository.normalizePhase(q)
}

async function buildPayload(phase) {
  const ph = normalizePhaseQuery(phase)
  const fetchedAt = new Date().toISOString()
  const lines = await mesRepository.fetchProductionLinesSnapshot(ph)
  attachLineStatus(lines)
  return { ok: true, fetchedAt, phase: ph, lineCount: lines.length, lines }
}

function broadcastSsePayload(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`
  for (const c of sseClients) {
    try {
      c.res.write(data)
    } catch (_) {
      /* 제거는 close에서 */
    }
  }
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'mes-prod-viewer',
    uptimeSec: Math.round(process.uptime()),
    time: new Date().toISOString(),
  })
})

app.post('/api/env/ingest', (req, res) => {
  if (!ingestKeyOk(req)) {
    res.status(401).json({ ok: false, error: 'Invalid device key' })
    return
  }
  try {
    const body = req.body || {}
    const deviceId = String(body.deviceId || ENV_DEVICE_ID).trim()
    const tempC = clampNum(Number(body.tempC), -50, 80)
    const humidityPct = clampNum(Number(body.humidityPct), 0, 100)
    if (tempC === null || humidityPct === null) {
      res.status(400).json({ ok: false, error: 'tempC and humidityPct required' })
      return
    }
    const tsRaw = body.ts != null ? new Date(body.ts).getTime() : Date.now()
    const ts = Number.isFinite(tsRaw) ? tsRaw : Date.now()
    const rawTemp =
      body.rawTemp != null ? parseInt(String(body.rawTemp), 10) : null
    const rawHum = body.rawHum != null ? parseInt(String(body.rawHum), 10) : null

    envStore.insertReading({
      deviceId,
      ts,
      tempC,
      humidityPct,
      rawTemp: Number.isFinite(rawTemp) ? rawTemp : null,
      rawHum: Number.isFinite(rawHum) ? rawHum : null,
    })

    res.json({ ok: true, deviceId, ts })
    broadcastEnvSse()
  } catch (err) {
    console.error('[api/env/ingest]', err.message)
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.get('/api/env/latest', (_req, res) => {
  try {
    const latest = envStore.getLatest(ENV_DEVICE_ID)
    res.json({ ok: true, deviceId: ENV_DEVICE_ID, latest: latest || null })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.get('/api/env/snapshot', (_req, res) => {
  try {
    res.json(buildEnvPayload())
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, history: [] })
  }
})

app.get('/api/env/history', (req, res) => {
  try {
    const hours = Math.min(
      168,
      Math.max(1, parseInt(String(req.query.hours || ENV_HISTORY_HOURS), 10) || ENV_HISTORY_HOURS),
    )
    const bucket = Math.max(
      1,
      parseInt(String(req.query.bucketMinutes || ENV_HISTORY_BUCKET_MIN), 10) ||
        ENV_HISTORY_BUCKET_MIN,
    )
    const history = envStore.getHistory(ENV_DEVICE_ID, hours, bucket)
    res.json({ ok: true, deviceId: ENV_DEVICE_ID, hours, bucketMinutes: bucket, history })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, history: [] })
  }
})

app.get('/api/env/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.flushHeaders?.()
  envSseClients.push(res)

  const pingIv = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`)
    } catch (_) {
      const i = envSseClients.indexOf(res)
      if (i !== -1) envSseClients.splice(i, 1)
    }
  }, 25000)

  req.on('close', () => {
    clearInterval(pingIv)
    const i = envSseClients.indexOf(res)
    if (i !== -1) envSseClients.splice(i, 1)
    try {
      res.end()
    } catch (_) {}
  })

  try {
    res.write(`data: ${JSON.stringify(buildEnvPayload())}\n\n`)
  } catch (e) {
    res.write(`data: ${JSON.stringify({ ok: false, error: e.message })}\n\n`)
  }
})

app.get('/api/lines', async (req, res) => {
  try {
    res.json(await buildPayload(req.query.phase))
  } catch (err) {
    console.error('[api/lines]', err.message)
    res.status(500).json({
      ok: false,
      error: err.message,
      fetchedAt: new Date().toISOString(),
      phase: normalizePhaseQuery(req.query.phase),
      lines: [],
    })
  }
})

app.get('/api/lines/stream', async (req, res) => {
  const phase = normalizePhaseQuery(req.query.phase)

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.flushHeaders?.()

  const client = { res, phase }
  sseClients.push(client)

  const sendHeart = () => {
    try {
      res.write(`: ping ${Date.now()}\n\n`)
    } catch (_) {
      const i = sseClients.indexOf(client)
      if (i !== -1) sseClients.splice(i, 1)
    }
  }

  const pingIv = setInterval(sendHeart, 25000)

  req.on('close', () => {
    clearInterval(pingIv)
    const i = sseClients.indexOf(client)
    if (i !== -1) sseClients.splice(i, 1)
    try {
      res.end()
    } catch (_) {}
  })

  try {
    res.write(`data: ${JSON.stringify(await buildPayload(phase))}\n\n`)
  } catch (e) {
    res.write(
      `data: ${JSON.stringify({
        ok: false,
        error: e.message,
        fetchedAt: new Date().toISOString(),
        phase,
        lines: [],
      })}\n\n`,
    )
  }
})

async function broadcastLoop() {
  const needSmt = sseClients.some((c) => c.phase === 'smt')
  const needAssy = sseClients.some((c) => c.phase === 'assy')

  let smtPayload
  let assyPayload
  try {
    if (needSmt) smtPayload = await buildPayload('smt')
    if (needAssy) assyPayload = await buildPayload('assy')
  } catch (e) {
    const errPayload = {
      ok: false,
      error: e.message,
      fetchedAt: new Date().toISOString(),
      lines: [],
    }
    for (const c of sseClients) {
      try {
        c.res.write(
          `data: ${JSON.stringify({ ...errPayload, phase: c.phase })}\n\n`,
        )
      } catch (_) {}
    }
    return
  }

  for (const c of sseClients) {
    const payload = c.phase === 'assy' ? assyPayload : smtPayload
    if (!payload) continue
    try {
      c.res.write(`data: ${JSON.stringify(payload)}\n\n`)
    } catch (_) {}
  }
}

setInterval(() => void broadcastLoop(), POLL_MS).unref?.()

setInterval(() => {
  if (envSseClients.length === 0) return
  broadcastEnvSse()
}, ENV_REFRESH_MS).unref?.()

if (ENV_RETENTION_DAYS > 0) {
  try {
    const n = envStore.purgeOlderThan(ENV_RETENTION_DAYS)
    if (n > 0) console.log(`[env] purged ${n} readings older than ${ENV_RETENTION_DAYS}d`)
  } catch (e) {
    console.warn('[env] retention purge skipped:', e.message)
  }
  setInterval(() => {
    try {
      envStore.purgeOlderThan(ENV_RETENTION_DAYS)
    } catch (_) {}
  }, 24 * 3600 * 1000).unref?.()
}

/* 정적 파일: public + 프로젝트 루트 images/(로고 등) */
app.use(express.static(path.join(__dirname, 'public')))
app.use('/images', express.static(path.join(__dirname, 'images')))

app.listen(PORT, HOST, () => {
  console.log(`MES viewer bound ${HOST}:${PORT}`)
  console.log(`  이 PC: http://localhost:${PORT}`)
  if (HOST === '0.0.0.0' || HOST === '::') {
    console.log(`  같은 LAN 다른 PC: http://(이 PC의 IPv4):${PORT}`)
  }
  console.log(`API GET /api/lines?phase=smt|assy  | SSE /api/lines/stream?phase=...  (${POLL_MS}ms)`)
  console.log(`ENV POST /api/env/ingest  | SSE /api/env/stream  device=${ENV_DEVICE_ID} (${ENV_REFRESH_MS}ms)`)
})
