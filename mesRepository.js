'use strict'

const sql = require('mssql')

let poolPromise = null

/** @param {string} key @param {boolean} fallback */
function envBool(key, fallback) {
  const v = process.env[key]
  if (v === undefined || v === '') return fallback
  return String(v).toLowerCase() === 'true'
}

function getConfig() {
  const server = process.env.MSSQL_SERVER
  const database = process.env.MSSQL_DATABASE
  const user = process.env.MSSQL_USER
  const password = process.env.MSSQL_PASSWORD

  return {
    server,
    database,
    user,
    password,
    options: {
      encrypt: envBool('MSSQL_ENCRYPT', false),
      trustServerCertificate: envBool('MSSQL_TRUST_SERVER_CERTIFICATE', true),
      enableArithAbort: true,
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
  }
}

async function getPool() {
  const cfg = getConfig()
  if (!cfg.server || !cfg.database || !cfg.user || cfg.password === undefined) {
    throw new Error(
      'MSSQL 서버 정보가 불완전합니다. MSSQL_SERVER, MSSQL_DATABASE, MSSQL_USER, MSSQL_PASSWORD 를 .env 에 설정하세요.',
    )
  }
  if (!poolPromise) {
    poolPromise = sql.connect(cfg)
  }
  return poolPromise
}

function parseNum(v) {
  if (v === null || v === undefined || v === '') return null
  const n =
    typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim())
  return Number.isFinite(n) ? n : null
}

function truthyYn(v) {
  if (v === null || v === undefined) return null
  const s = String(v).trim().toUpperCase()
  if (['Y', 'YES', 'OK', 'PASS', '1', '통과'].includes(s)) return true
  if (['N', 'NO', 'NG', 'FAIL', '0', '불량'].includes(s)) return false
  return null
}

/** SMT / ASSY 페이즈 정의 (라인 키·표시명·ASSY만 activated=Y) */
const PHASE = {
  smt: {
    lineKeys: ['SMT_ASSY_ASSEMBLY02', 'SMT03', 'SMT04'],
    labels: {
      SMT_ASSY_ASSEMBLY02: '셀렉티브02',
      SMT03: 'SMT C',
      SMT04: 'SMT D',
    },
    filterActiveOnly: false,
  },
  assy: {
    lineKeys: [
      'ASSEMBLY01',
      'ASSEMBLY04',
      'ASSEMBLY07',
      'DCSD_WRITE01',
      'DCSD_WRITE02',
      'ICT02',
      'ICT07',
      'MULTI_JACK01',
      'MULTI_JACK04',
      'MULTI_JACK07',
      'MULTI_JACK08',
      'WATCH01',
      'ASSY_ASSEMBLY01',
      'ASSY_ASSEMBLY03',
    ],
    labels: {
      ASSEMBLY01: '멀티01조립',
      ASSEMBLY04: '멀티04조립',
      ASSEMBLY07: '멀티07조립',
      DCSD_WRITE01: 'DCSD 라이팅기01',
      DCSD_WRITE02: 'DCSD 라이팅기02',
      ICT02: 'ICT02',
      ICT07: 'ICT07',
      MULTI_JACK01: '멀티잭 A',
      MULTI_JACK04: '멀티잭 D',
      MULTI_JACK07: '멀티잭 G',
      MULTI_JACK08: '멀티잭 H',
      WATCH01: '01',
      ASSY_ASSEMBLY01: '웨이브솔더01',
      ASSY_ASSEMBLY03: '웨이브솔더03',
    },
    filterActiveOnly: true,
  },
}

const ASSY_SELECTIVE_LINE = 'SMT_ASSY_ASSEMBLY02'

function normalizePhase(p) {
  const k = String(p || 'smt').toLowerCase()
  return k === 'assy' ? 'assy' : 'smt'
}

function getPhaseConfig(phase) {
  return PHASE[normalizePhase(phase)] || PHASE.smt
}

/** SQL IN 절용 — 키는 코드 상수만 사용 */
function sqlLineInList(lineKeys) {
  return lineKeys.map((k) => `N'${String(k).replace(/'/g, "''")}'`).join(',\n      ')
}

function canonicalLineKey(raw, lineKeys) {
  const t = String(raw || '').trim()
  const hit = lineKeys.find((k) => k.toLowerCase() === t.toLowerCase())
  return hit || t
}

function partitionLineKeyFromRow(r) {
  const line = r.line != null ? String(r.line).trim() : ''
  if (line) return line
  return String(r.process || '').trim()
}

function elapsedAnchorForUi(startRaw, createFallbackRaw) {
  for (const raw of [startRaw, createFallbackRaw]) {
    if (raw == null || raw === '') continue
    const t =
      raw instanceof Date
        ? raw.getTime()
        : typeof raw === 'string' || typeof raw === 'number'
          ? new Date(raw).getTime()
          : NaN
    if (Number.isFinite(t)) return new Date(t).toISOString()
  }
  return null
}

function rowCol(row, logicalName) {
  if (Object.prototype.hasOwnProperty.call(row, logicalName)) return row[logicalName]
  const lower = logicalName.toLowerCase()
  const k = Object.keys(row).find((x) => x.toLowerCase() === lower)
  return k !== undefined ? row[k] : undefined
}

function workSideFromModelNameEnd(modelName) {
  const s = String(modelName || '').trim()
  if (!s) return null
  const u = s.toUpperCase()
  if (/\bBOTTOM\s*$/.test(u)) return 'BOT'
  if (/\bBOT\s*$/.test(u)) return 'BOT'
  if (/\bTOP\s*$/.test(u)) return 'TOP'
  return null
}

function resolveWorkSideDisplay(phase, lineKey, modelTitle, r) {
  if (lineKey === ASSY_SELECTIVE_LINE) return 'TOP'

  if (phase === 'smt' && (lineKey === 'SMT03' || lineKey === 'SMT04')) {
    const candidates = [r.master_model_name, r.plan_model_name, modelTitle]
    for (const n of candidates) {
      const w = workSideFromModelNameEnd(n)
      if (w) return w
    }
  }

  if (phase === 'assy') {
    const candidates = [r.master_model_name, r.plan_model_name, modelTitle]
    for (const n of candidates) {
      const w = workSideFromModelNameEnd(n)
      if (w) return w
    }
  }

  const workSideRaw = (r.work_side && String(r.work_side).trim().toUpperCase()) || ''
  if (workSideRaw === 'UP' || workSideRaw === 'T' || workSideRaw === 'TOP') return 'TOP'
  if (workSideRaw === 'DN' || workSideRaw === 'B' || workSideRaw === 'BOT') return 'BOT'
  return workSideRaw || '—'
}

/**
 * 계획일(plan_date) 기준 조회 기간(일).
 * ASSY는 activated=Y가 오래 남는 경우가 많아 공통 lookback보다 짧게 기본 적용 가능.
 */
function planLookbackDaysForPhase(phase) {
  const globalLb = Math.min(
    365,
    Math.max(1, parseInt(process.env.MES_PLAN_LOOKBACK_DAYS || '14', 10) || 14),
  )
  if (normalizePhase(phase) !== 'assy') return globalLb

  const assyRaw = process.env.MES_ASSY_PLAN_LOOKBACK_DAYS
  if (assyRaw !== undefined && String(assyRaw).trim() !== '') {
    return Math.min(365, Math.max(1, parseInt(String(assyRaw), 10) || globalLb))
  }
  // 미설정: ASSY만 기본 7일 — 한 달 치 과거 플래그 행 노출 완화 (필요 시 .env 에서 확장)
  return Math.min(globalLb, 7)
}

async function fetchProductionLinesSnapshot(phaseArg) {
  const phase = normalizePhase(phaseArg)
  const cfg = getPhaseConfig(phase)
  const lookback = planLookbackDaysForPhase(phase)

  const lineIn = sqlLineInList(cfg.lineKeys)
  const activeOnlySql = cfg.filterActiveOnly
    ? `AND UPPER(LTRIM(RTRIM(COALESCE(p.activated, N'')))) = N'Y'`
    : ''
  const activeOnlySqlP2 = cfg.filterActiveOnly
    ? `AND UPPER(LTRIM(RTRIM(COALESCE(p2.activated, N'')))) = N'Y'`
    : ''

  const q = `
;WITH ranked AS (
  SELECT
    p.[process],
    p.plan_date,
    p.work_shift,
    p.line,
    p.work_side,
    p.work_side_name,
    p.work_item,
    p.work_item_name,
    p.model_code,
    p.model_name        AS plan_model_name,
    m.MODEL_NO,
    m.MODEL_NAME        AS master_model_name,
    m.CUST_CODE,
    m.MODEL_SPEC,
    p.revision,
    p.plan_qty,
    p.prod_qty,
    p.prod_lot,
    p.start_time,
    p.end_time,
    p.create_date       AS plan_row_create_dt,
    CASE
      WHEN p.start_time IS NOT NULL THEN
        CASE
          WHEN DATEDIFF(MINUTE, p.start_time, GETDATE()) < 0 THEN 0
          ELSE DATEDIFF(MINUTE, p.start_time, GETDATE())
        END
      WHEN p.create_date IS NOT NULL THEN
        CASE
          WHEN DATEDIFF(MINUTE, p.create_date, GETDATE()) < 0 THEN 0
          ELSE DATEDIFF(MINUTE, p.create_date, GETDATE())
        END
      ELSE NULL
    END                 AS elapsed_minutes_db,
    p.[update_date]     AS mes_last_update_dt,
    p.activated,
    p.attribute01,
    p.attribute02,
    ROW_NUMBER() OVER (
      PARTITION BY COALESCE(NULLIF(LTRIM(RTRIM(p.line)), ''), p.[process])
      ORDER BY
        CASE WHEN p.plan_date = CAST(GETDATE() AS date) THEN 0 ELSE 1 END,
        p.plan_date DESC,
        p.start_time DESC,
        p.create_date DESC,
        p.[update_date] DESC
    ) AS rn
  FROM dbo.TB_MES_PROD_PLAN p
  LEFT JOIN dbo.TB_MES_MODEL_MASTER m
    ON m.MODEL_CODE = p.model_code
  WHERE p.plan_date >= DATEADD(day, -@lookbackDays, CAST(GETDATE() AS date))
    AND COALESCE(NULLIF(LTRIM(RTRIM(p.line)), ''), p.[process]) IN (
      ${lineIn}
    )
    ${activeOnlySql}
)
SELECT
  r.[process],
  r.plan_date,
  r.work_shift,
  r.line,
  r.work_side,
  r.work_side_name,
  r.work_item,
  r.work_item_name,
  r.model_code,
  r.plan_model_name,
  r.MODEL_NO,
  r.master_model_name,
  r.CUST_CODE,
  r.MODEL_SPEC,
  r.revision,
  r.plan_qty,
  COALESCE(a.sum_prod_qty, r.prod_qty) AS prod_qty,
  r.prod_lot,
  COALESCE(a.job_start_time, r.start_time) AS start_time,
  r.end_time,
  r.plan_row_create_dt,
  CASE
    WHEN COALESCE(a.job_start_time, r.start_time) IS NOT NULL THEN
      CASE
        WHEN DATEDIFF(MINUTE, COALESCE(a.job_start_time, r.start_time), GETDATE()) < 0 THEN 0
        ELSE DATEDIFF(MINUTE, COALESCE(a.job_start_time, r.start_time), GETDATE())
      END
    WHEN r.plan_row_create_dt IS NOT NULL THEN
      CASE
        WHEN DATEDIFF(MINUTE, r.plan_row_create_dt, GETDATE()) < 0 THEN 0
        ELSE DATEDIFF(MINUTE, r.plan_row_create_dt, GETDATE())
      END
    ELSE NULL
  END AS elapsed_minutes_db,
  r.mes_last_update_dt,
  r.activated,
  r.attribute01,
  r.attribute02
FROM ranked r
OUTER APPLY (
  SELECT
    SUM(
      CASE
        WHEN p2.prod_qty IS NULL THEN 0
        WHEN ISNUMERIC(
          REPLACE(REPLACE(LTRIM(RTRIM(CAST(p2.prod_qty AS nvarchar(100)))), N',', N''), N' ', N'') + N'e0'
        ) = 1
          THEN CAST(
            REPLACE(REPLACE(LTRIM(RTRIM(CAST(p2.prod_qty AS nvarchar(100)))), N',', N''), N' ', N'')
            AS float
          )
        ELSE 0
      END
    ) AS sum_prod_qty,
    MIN(p2.start_time) AS job_start_time
  FROM dbo.TB_MES_PROD_PLAN p2
  WHERE NULLIF(LTRIM(RTRIM(r.prod_lot)), N'') IS NOT NULL
    AND NULLIF(LTRIM(RTRIM(p2.prod_lot)), N'') = NULLIF(LTRIM(RTRIM(r.prod_lot)), N'')
    AND COALESCE(NULLIF(LTRIM(RTRIM(p2.line)), N''), p2.[process]) =
        COALESCE(NULLIF(LTRIM(RTRIM(r.line)), N''), r.[process])
    AND p2.plan_date >= DATEADD(day, -@lookbackDays, CAST(GETDATE() AS date))
    AND COALESCE(NULLIF(LTRIM(RTRIM(p2.line)), N''), p2.[process]) IN (
      ${lineIn}
    )
    ${activeOnlySqlP2}
) a
WHERE r.rn = 1
ORDER BY r.line, r.[process];
`

  const pool = await getPool()
  const rq = pool.request()
  rq.input('lookbackDays', sql.Int, lookback)
  const result = await rq.query(q)
  const rows = result.recordset || []

  const mapped = rows.map((r, idx) => {
    const st = rowCol(r, 'start_time')
    const crt = rowCol(r, 'plan_row_create_dt')
    const elDb = rowCol(r, 'elapsed_minutes_db')

    const plan = parseNum(rowCol(r, 'plan_qty'))
    const prod = parseNum(r.prod_qty)
    let progressPct =
      plan !== null && plan > 0 && prod !== null
        ? Math.min(100, Math.round((prod / plan) * 1000) / 10)
        : null

    const modelTitle =
      (r.master_model_name && String(r.master_model_name).trim()) ||
      (r.plan_model_name && String(r.plan_model_name).trim()) ||
      '—'

    const modelCodeDisplay =
      (r.MODEL_NO && String(r.MODEL_NO).trim()) ||
      (r.model_code != null && String(r.model_code).trim()) ||
      ''

    const prodLotDisplay = r.prod_lot != null ? String(r.prod_lot).trim() : ''

    const lineKey = canonicalLineKey(partitionLineKeyFromRow(r) || String(idx), cfg.lineKeys)

    const workSideLabel = resolveWorkSideDisplay(phase, lineKey, modelTitle, r)

    const lastUd = r.mes_last_update_dt
    const lastUpdateAt = lastUd ? new Date(lastUd) : null

    const elapsedFromAt = elapsedAnchorForUi(st, crt)

    let elapsedMinutes = null
    if (elDb != null && elDb !== '') {
      const n = typeof elDb === 'number' ? elDb : Number.parseInt(String(elDb).trim(), 10)
      if (Number.isFinite(n) && !Number.isNaN(n)) elapsedMinutes = Math.max(0, n)
    }

    return {
      id: `${phase}::${lineKey}::${r.work_side || '-'}`,
      phase,
      lineKey,
      displayLineLabel:
        cfg.labels[lineKey] != null ? cfg.labels[lineKey] : lineKey,
      process: r.process,
      planDate: r.plan_date,
      workShift: r.work_shift,
      modelCode: modelCodeDisplay || null,
      prodLot: prodLotDisplay || null,
      modelTitle,
      masterModelName: r.master_model_name || null,
      planModelName: r.plan_model_name || null,
      modelNo: r.MODEL_NO ? String(r.MODEL_NO).trim() : null,
      workSide: workSideLabel,
      planQty: plan,
      prodQty: prod,
      progressPct,
      masterVerifyOk: truthyYn(r.attribute01),
      submaterialVerifyOk: true,
      lastUpdateAt: lastUpdateAt ? lastUpdateAt.toISOString() : null,
      elapsedFromAt,
      elapsedMinutes,
      startTime: st ? new Date(st).toISOString() : null,
      endTime: r.end_time ? new Date(r.end_time).toISOString() : null,
      colorIndex: idx % 4,
    }
  })

  const orderIndex = (k) => {
    const i = cfg.lineKeys.indexOf(k)
    return i === -1 ? 999 : i
  }

  return mapped
    .filter((row) => cfg.lineKeys.includes(row.lineKey))
    .sort((a, b) => orderIndex(a.lineKey) - orderIndex(b.lineKey))
    .map((row, i) => ({ ...row, colorIndex: i % 4 }))
}

module.exports = {
  getPool,
  fetchProductionLinesSnapshot,
  normalizePhase,
  getPhaseConfig,
}
