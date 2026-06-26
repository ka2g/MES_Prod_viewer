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
const alarmStore = require('./alarmStore')
const notifier = require('./notifier')

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
const ENV_DEVICE_ID = String(process.env.ENV_DEVICE_ID || 'SMT_SHT-01').trim()
const ENV_INGEST_KEY = String(process.env.ENV_INGEST_KEY || '').trim()
const ENV_HISTORY_HOURS = Math.min(
  168,
  Math.max(1, parseInt(process.env.ENV_HISTORY_HOURS || '24', 10) || 24),
)
const ENV_HISTORY_BUCKET_MIN = Math.max(
  1,
  parseInt(process.env.ENV_HISTORY_BUCKET_MIN || '10', 10) || 10,
)
const ENV_RETENTION_DAYS = Math.max(
  0,
  parseInt(process.env.ENV_RETENTION_DAYS || '90', 10) || 90,
)
const ENV_SETTINGS_PIN = String(process.env.ENV_SETTINGS_PIN || 'smt1234').trim()

function numEnv(name, def) {
  const v = parseFloat(process.env[name])
  return Number.isFinite(v) ? v : def
}

const ENV_TEMP_MIN = numEnv('ENV_TEMP_MIN', 22)
const ENV_TEMP_MAX = numEnv('ENV_TEMP_MAX', 28)
const ENV_HUM_MIN = numEnv('ENV_HUM_MIN', 40)
const ENV_HUM_MAX = numEnv('ENV_HUM_MAX', 60)
const ENV_ALARM_SUSTAIN_MIN = Math.max(0, numEnv('ENV_ALARM_SUSTAIN_MIN', 3))
const ENV_STALE_WARN_MIN = Math.max(1, numEnv('ENV_STALE_WARN_MIN', 5))
const ENV_STALE_ALARM_MIN = Math.max(ENV_STALE_WARN_MIN, numEnv('ENV_STALE_ALARM_MIN', 15))

alarmStore.configure({
  tempMin: ENV_TEMP_MIN,
  tempMax: ENV_TEMP_MAX,
  humMin: ENV_HUM_MIN,
  humMax: ENV_HUM_MAX,
  sustainMs: ENV_ALARM_SUSTAIN_MIN * 60 * 1000,
  staleAlarmMs: ENV_STALE_ALARM_MIN * 60 * 1000,
})

notifier.configure({
  webhookUrl: String(process.env.ENV_ALARM_WEBHOOK_URL || '').trim(),
  telegramToken: String(process.env.ENV_TELEGRAM_BOT_TOKEN || '').trim(),
  telegramChatId: String(process.env.ENV_TELEGRAM_CHAT_ID || '').trim(),
})

function startOfTodayMs() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

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

const ENV_THRESHOLDS = {
  tempMin: ENV_TEMP_MIN,
  tempMax: ENV_TEMP_MAX,
  humMin: ENV_HUM_MIN,
  humMax: ENV_HUM_MAX,
}

function buildEnvPayload() {
  let latest = envStore.getLatest(ENV_DEVICE_ID)
  if (!latest) latest = envStore.getLatestAny()
  const historyDeviceId = latest ? latest.deviceId : ENV_DEVICE_ID
  const history = envStore.getTodayHistory10Min(historyDeviceId, ENV_HISTORY_BUCKET_MIN)
  const stats = envStore.getStats(
    historyDeviceId,
    startOfTodayMs(),
    Date.now(),
    ENV_THRESHOLDS,
  )
  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    deviceId: ENV_DEVICE_ID,
    chartMode: 'day',
    thresholds: ENV_THRESHOLDS,
    staleWarnMin: ENV_STALE_WARN_MIN,
    staleAlarmMin: ENV_STALE_ALARM_MIN,
    alarms: alarmStore.getActiveAlarms(historyDeviceId),
    stats,
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

function settingsPinOk(req) {
  const pin =
    req.get('X-Settings-Pin') ||
    req.get('x-settings-pin') ||
    (req.body && req.body.pin) ||
    ''
  return pin === ENV_SETTINGS_PIN
}

function roundEnv1(v) {
  return Math.round(v * 10) / 10
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
    const rawTempC = clampNum(Number(body.tempC), -50, 80)
    const rawHumidityPct = clampNum(Number(body.humidityPct), 0, 100)
    if (rawTempC === null || rawHumidityPct === null) {
      res.status(400).json({ ok: false, error: 'tempC and humidityPct required' })
      return
    }
    const calibrated = envStore.applyCalibration(rawTempC, rawHumidityPct)
    const tempC = calibrated.tempC
    const humidityPct = calibrated.humidityPct
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
      rawTemp: Number.isFinite(rawTemp) ? rawTemp : roundEnv1(rawTempC),
      rawHum: Number.isFinite(rawHum) ? rawHum : roundEnv1(rawHumidityPct),
    })

    console.log(
      `[env/ingest] ${deviceId} T=${tempC} RH=${humidityPct}% ts=${new Date(ts).toISOString()}`,
    )

    let events = []
    try {
      events = alarmStore.evaluateReading(deviceId, ts, tempC, humidityPct)
    } catch (e) {
      console.warn('[env/alarm] evaluate failed:', e.message)
    }
    for (const ev of events) {
      console.log(`[env/alarm] ${ev.metric} ${ev.kind} ${ev.state} value=${ev.value ?? ''}`)
      notifier.notify(ev)
    }

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

app.get('/api/env/months', (_req, res) => {
  try {
    let latest = envStore.getLatest(ENV_DEVICE_ID)
    if (!latest) latest = envStore.getLatestAny()
    const deviceId = latest ? latest.deviceId : ENV_DEVICE_ID
    const months = envStore.listBrowsableMonths(deviceId)
    res.json({ ok: true, deviceId, months })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, months: [] })
  }
})

app.get('/api/env/calibration', (_req, res) => {
  try {
    res.json({ ok: true, calibration: envStore.getCalibration() })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.put('/api/env/calibration', (req, res) => {
  if (!settingsPinOk(req)) {
    res.status(403).json({ ok: false, error: 'Invalid settings PIN' })
    return
  }
  try {
    const body = req.body || {}
    const current = envStore.getCalibration()
    const tempOffset =
      body.tempOffset != null ? roundEnv1(Number(body.tempOffset)) : current.tempOffset
    const humidityOffset =
      body.humidityOffset != null
        ? roundEnv1(Number(body.humidityOffset))
        : current.humidityOffset
    if (!Number.isFinite(tempOffset) || !Number.isFinite(humidityOffset)) {
      res.status(400).json({ ok: false, error: 'Invalid offset values' })
      return
    }
    const calibration = envStore.setCalibration({ tempOffset, humidityOffset })
    res.json({ ok: true, calibration })
    broadcastEnvSse()
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.get('/api/env/month', (req, res) => {
  try {
    const now = new Date()
    const year = parseInt(String(req.query.year || now.getFullYear()), 10) || now.getFullYear()
    const month =
      parseInt(String(req.query.month || now.getMonth() + 1), 10) || now.getMonth() + 1
    if (month < 1 || month > 12) {
      res.status(400).json({ ok: false, error: 'Invalid month' })
      return
    }
    let latest = envStore.getLatest(ENV_DEVICE_ID)
    if (!latest) latest = envStore.getLatestAny()
    const deviceId = latest ? latest.deviceId : ENV_DEVICE_ID
    const monthData = envStore.getMonthDailyFromCsv(deviceId, year, month)
    res.json({
      ok: true,
      deviceId,
      chartMode: 'month',
      ...monthData,
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, history: [] })
  }
})

function resolveEnvDeviceId() {
  let latest = envStore.getLatest(ENV_DEVICE_ID)
  if (!latest) latest = envStore.getLatestAny()
  return latest ? latest.deviceId : ENV_DEVICE_ID
}

function parseRange(req) {
  const now = Date.now()
  let to = Date.parse(String(req.query.to || ''))
  if (!Number.isFinite(to)) to = now
  let from = Date.parse(String(req.query.from || ''))
  if (!Number.isFinite(from)) from = to - 24 * 3600 * 1000
  if (from > to) [from, to] = [to, from]
  return { from, to }
}

app.get('/api/env/alarms', (req, res) => {
  try {
    const { from, to } = parseRange(req)
    const deviceId = resolveEnvDeviceId()
    const alarms = alarmStore.readAlarms(deviceId, from, to)
    res.json({ ok: true, deviceId, from, to, alarms })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, alarms: [] })
  }
})

app.get('/api/env/range', (req, res) => {
  try {
    const { from, to } = parseRange(req)
    const bucket = parseInt(String(req.query.bucket || ''), 10)
    const deviceId = resolveEnvDeviceId()
    const range = envStore.getRange(deviceId, from, to, Number.isFinite(bucket) ? bucket : 0)
    const stats = envStore.getStats(deviceId, from, to, ENV_THRESHOLDS)
    res.json({
      ok: true,
      deviceId,
      chartMode: 'range',
      thresholds: ENV_THRESHOLDS,
      ...range,
      stats,
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, history: [] })
  }
})

app.get('/api/env/export', (req, res) => {
  try {
    const { from, to } = parseRange(req)
    const deviceId = resolveEnvDeviceId()
    const rows = envStore.getRawRange(deviceId, from, to)
    const pad = (n) => String(n).padStart(2, '0')
    const fmt = (ms) => {
      const d = new Date(ms)
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    }
    const fnameDay = (ms) => {
      const d = new Date(ms)
      return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
    }
    let csv = 'recorded_at,device_id,temp_c,humidity_pct\n'
    for (const r of rows) {
      csv += `${fmt(r.ts)},${r.deviceId},${r.tempC},${r.humidityPct}\n`
    }
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="env-${deviceId}-${fnameDay(from)}_${fnameDay(to)}.csv"`,
    })
    res.send('\uFEFF' + csv)
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
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

/* 센서 단절 watchdog: 마지막 수신 이후 경과로 단절 경보 */
setInterval(() => {
  try {
    const latest = envStore.getLatest(ENV_DEVICE_ID) || envStore.getLatestAny()
    if (!latest) return
    const events = alarmStore.checkSensorWatchdog(latest.deviceId, Date.now(), latest.ts)
    if (events.length === 0) return
    for (const ev of events) {
      console.log(`[env/alarm] sensor ${ev.state}`)
      notifier.notify(ev)
    }
    broadcastEnvSse()
  } catch (e) {
    console.warn('[env/watchdog]', e.message)
  }
}, 60 * 1000).unref?.()

if (ENV_RETENTION_DAYS > 0) {
  try {
    const n = envStore.purgeOlderThan(ENV_RETENTION_DAYS)
    if (n > 0) console.log(`[env] purged ${n} readings older than ${ENV_RETENTION_DAYS}d`)
  } catch (e) {
    console.warn('[env] retention purge skipped:', e.message)
  }
  try {
    alarmStore.purgeOlderThan(ENV_RETENTION_DAYS)
  } catch (_) {}
  setInterval(() => {
    try {
      envStore.purgeOlderThan(ENV_RETENTION_DAYS)
      alarmStore.purgeOlderThan(ENV_RETENTION_DAYS)
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
