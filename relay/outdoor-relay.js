'use strict'

/**
 * 인터넷 가능 PC(예: 10.201.219.119, Windows 7)에서 실행.
 * Open-Meteo → Pull(HTTP) + Push(MES POST)
 *
 *   node relay/outdoor-relay.js
 *   dist/outdoor-relay.exe  (설정: outdoor-relay.env 또는 .env, exe와 같은 폴더)
 */

const fs = require('fs')
const path = require('path')
const http = require('http')

const baseDir = process.pkg ? path.dirname(process.execPath) : __dirname

function loadConfig() {
  const names = ['outdoor-relay.env', '.env']
  for (const name of names) {
    const configPath = path.join(baseDir, name)
    if (fs.existsSync(configPath)) {
      require('dotenv').config({ path: configPath })
      return configPath
    }
  }
  return null
}

const configPath = loadConfig()

const { fetchOpenMeteo } = require('./openMeteo')
const { postJson } = require('./httpUtil')

const LAT = parseFloat(process.env.OUTDOOR_LAT || '37.3169')
const LON = parseFloat(process.env.OUTDOOR_LON || '126.8258')
const LOCATION = String(process.env.OUTDOOR_LOCATION || '안산시 원시동').trim()
const PORT = parseInt(process.env.RELAY_PORT || '8080', 10)
const HOST = process.env.RELAY_HOST || '0.0.0.0'
const REFRESH_MS = Math.max(
  60000,
  parseInt(process.env.RELAY_REFRESH_MS || '600000', 10) || 600000,
)
const MES_PUSH_URL = String(process.env.MES_PUSH_URL || '').trim()
const OUTDOOR_INGEST_KEY = String(process.env.OUTDOOR_INGEST_KEY || '').trim()
const PUSH_ENABLED = process.env.RELAY_PUSH !== '0'
const HTTP_ENABLED = process.env.RELAY_HTTP !== '0'

/** @type {object|null} */
let cache = null
let refreshing = false

async function refresh() {
  if (refreshing) return cache
  refreshing = true
  try {
    cache = await fetchOpenMeteo({
      latitude: LAT,
      longitude: LON,
      location: LOCATION,
    })
    console.log(
      `[relay] ${LOCATION} T=${cache.current.tempC} RH=${cache.current.humidityPct}% ${cache.current.weatherLabel}`,
    )
    if (PUSH_ENABLED && MES_PUSH_URL) {
      await pushToMes(cache)
    }
    return cache
  } catch (e) {
    console.error('[relay] refresh failed:', e.message)
    return cache
  } finally {
    refreshing = false
  }
}

async function pushToMes(payload) {
  const headers = {}
  if (OUTDOOR_INGEST_KEY) headers['X-Outdoor-Key'] = OUTDOOR_INGEST_KEY
  await postJson(MES_PUSH_URL, payload, headers)
  console.log('[relay] pushed to MES', MES_PUSH_URL)
}

function startHttp() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || (req.url !== '/' && req.url !== '/weather')) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Not found' }))
      return
    }
    Promise.resolve()
      .then(() => (cache ? cache : refresh()))
      .then((data) => {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-cache',
        })
        res.end(JSON.stringify(data || { ok: false, error: 'No data yet' }))
      })
      .catch((e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: e.message }))
      })
  })

  server.listen(PORT, HOST, () => {
    console.log(
      `[relay] HTTP Pull http://${HOST === '0.0.0.0' ? '0.0.0.0' : HOST}:${PORT}/weather`,
    )
  })
}

void refresh()
const refreshIv = setInterval(() => void refresh(), REFRESH_MS)
if (refreshIv.unref) refreshIv.unref()

if (HTTP_ENABLED) startHttp()
else console.log('[relay] HTTP Pull disabled (RELAY_HTTP=0)')

if (PUSH_ENABLED && MES_PUSH_URL) {
  console.log('[relay] Push target', MES_PUSH_URL)
} else if (PUSH_ENABLED) {
  console.warn('[relay] Push enabled but MES_PUSH_URL empty')
}

console.log(`[relay] location=${LOCATION} (${LAT},${LON}) refresh=${REFRESH_MS}ms`)
if (process.pkg) {
  console.log(
    `[relay] exe mode — config: ${configPath || '(없음 — outdoor-relay.env 또는 .env 필요)'}`,
  )
} else if (configPath) {
  console.log(`[relay] config: ${configPath}`)
}
