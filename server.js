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

const PORT = parseInt(process.env.PORT || '3000', 10)
const HOST = process.env.HOST || '0.0.0.0'
const POLL_MS = Math.max(
  2000,
  parseInt(process.env.MES_REFRESH_MS || '8000', 10) || 8000,
)

const app = express()
app.disable('x-powered-by')
app.use(express.json())

/** @type {{ res: import('http').ServerResponse, phase: string }[]} */
const sseClients = []

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
})
