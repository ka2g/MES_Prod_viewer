'use strict'

const fs = require('fs')
const path = require('path')

/** 페이즈:라인별 마지막 생산수량·변동 시각 — 재시작 유지용 파일과 동기화 */
const state = new Map()

/** pkg 등으로 빌드된 exe는 스냅샷(__dirname)이 읽기 전용 — 실행 파일 옆(또는 cwd)에 저장 */
function getWritableStateDir() {
  if (process.pkg) {
    return path.dirname(process.execPath)
  }
  return __dirname
}

const STATE_FILE = path.join(getWritableStateDir(), 'line-activity-state.json')
let saveTimer = null

function loadPersistedState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8')
    const o = JSON.parse(raw)
    if (!o || typeof o !== 'object') return
    const now = Date.now()
    for (const [k, v] of Object.entries(o)) {
      if (!v || typeof v !== 'object') continue
      const at = v.lastChangeAt
      const atMs = typeof at === 'number' ? at : Number(at)
      if (!Number.isFinite(atMs) || atMs > now) continue
      state.set(k, { lastProd: v.lastProd, lastChangeAt: atMs })
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[lineActivity] state load:', e.message)
  }
}

function schedulePersistState() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      const o = Object.fromEntries(state)
      fs.writeFileSync(STATE_FILE, JSON.stringify(o), 'utf8')
    } catch (e) {
      console.warn('[lineActivity] state save:', e.message)
    }
  }, 500)
}

loadPersistedState()

function sameProd(a, b) {
  if (a === null || a === undefined) {
    return b === null || b === undefined
  }
  if (b === null || b === undefined) return false
  return Number(a) === Number(b)
}

function stateKey(row) {
  const ph = row.phase || 'smt'
  return `${ph}::${row.lineKey}`
}

/** 파일/메모리에 없는 라인 최초 관측 시: MES 실적 갱신 시각을 쓰면 재시작 직후 전원 가동중으로 뜨는 것을 줄임 */
function coldStartLastChangeAt(row, now) {
  if (row.lastUpdateAt) {
    const t = Date.parse(row.lastUpdateAt)
    if (Number.isFinite(t) && t <= now) return t
  }
  return now - 31 * 60000
}

/**
 * 생산수량이 변했을 때만 lastChange 갱신.
 * - 마지막 변동 후 10분 미만: running (가동중)
 * - 10~30분: idle (유휴)
 * - 30분 이상: stopped (비가동)
 */
function attachLineStatus(lines) {
  const now = Date.now()
  for (const row of lines) {
    const key = stateKey(row)
    const prod = row.prodQty
    const prev = state.get(key)
    if (!prev) {
      state.set(key, {
        lastProd: prod,
        lastChangeAt: coldStartLastChangeAt(row, now),
      })
    } else if (!sameProd(prev.lastProd, prod)) {
      state.set(key, { lastProd: prod, lastChangeAt: now })
    } else {
      state.set(key, { lastProd: prod, lastChangeAt: prev.lastChangeAt })
    }

    const { lastChangeAt } = state.get(key)
    const minutes = (now - lastChangeAt) / 60000
    let lineStatus = 'stopped'
    if (minutes < 10) lineStatus = 'running'
    else if (minutes < 30) lineStatus = 'idle'

    row.lineStatus = lineStatus
    row.minutesSinceProdChange = Math.max(0, Math.floor(minutes))
  }

  schedulePersistState()
}

module.exports = { attachLineStatus }
