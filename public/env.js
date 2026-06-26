'use strict'

const envPanelEl = document.getElementById('envPanel')
const envTempValEl = document.getElementById('envTempVal')
const envHumValEl = document.getElementById('envHumVal')
const envTempTrendEl = document.getElementById('envTempTrend')
const envHumTrendEl = document.getElementById('envHumTrend')
const envUpdatedEl = document.getElementById('envUpdated')
const envStatusEl = document.getElementById('envStatus')
const envChartCanvas = document.getElementById('envChart')
const envChartTitleEl = document.getElementById('envChartTitle')
const envModeDayBtn = document.getElementById('envModeDay')
const envModeMonthBtn = document.getElementById('envModeMonth')
const envMonthNavEl = document.getElementById('envMonthNav')
const envMonthPrevBtn = document.getElementById('envMonthPrev')
const envMonthNextBtn = document.getElementById('envMonthNext')
const envMonthSelectEl = document.getElementById('envMonthSelect')
const envSettingsBtn = document.getElementById('envSettingsBtn')
const envPinModal = document.getElementById('envPinModal')
const envPinInput = document.getElementById('envPinInput')
const envPinError = document.getElementById('envPinError')
const envPinSubmit = document.getElementById('envPinSubmit')
const envSettingsModal = document.getElementById('envSettingsModal')
const envCalTempValEl = document.getElementById('envCalTempVal')
const envCalHumValEl = document.getElementById('envCalHumVal')
const envCalTempUp = document.getElementById('envCalTempUp')
const envCalTempDown = document.getElementById('envCalTempDown')
const envCalHumUp = document.getElementById('envCalHumUp')
const envCalHumDown = document.getElementById('envCalHumDown')
const envCalApplyBtn = document.getElementById('envCalApply')
const envCalStatusEl = document.getElementById('envCalStatus')
const envTempGaugeEl = document.getElementById('envTempGauge')
const envHumGaugeEl = document.getElementById('envHumGauge')
const envTempStateEl = document.getElementById('envTempState')
const envHumStateEl = document.getElementById('envHumState')
const envTempStatsEl = document.getElementById('envTempStats')
const envHumStatsEl = document.getElementById('envHumStats')
const envStatTempEl = document.getElementById('envStatTemp')
const envStatHumEl = document.getElementById('envStatHum')
const envStatTempBreachEl = document.getElementById('envStatTempBreach')
const envStatHumBreachEl = document.getElementById('envStatHumBreach')
const envModeRangeBtn = document.getElementById('envModeRange')
const envRangeNavEl = document.getElementById('envRangeNav')
const envRangeFromEl = document.getElementById('envRangeFrom')
const envRangeToEl = document.getElementById('envRangeTo')
const envRangeApplyBtn = document.getElementById('envRangeApply')
const envRangeWeekBtn = document.getElementById('envRangeWeek')
const envExportBtn = document.getElementById('envExportBtn')
const envAlarmListEl = document.getElementById('envAlarmList')
const envAlarmRefreshBtn = document.getElementById('envAlarmRefresh')
const kioskBtn = document.getElementById('kioskBtn')

const SETTINGS_PIN = 'smt1234'
const CAL_STEP = 0.1
const CAL_MIN = -50
const CAL_MAX = 50

let envEventSource = null
let envChart = null
let lastEnvPayload = null
/** @type {'day'|'month'|'range'} */
let chartViewMode = 'day'
let monthChartMeta = null
let rangeChartMeta = null
/** @type {{ year: number, month: number, key: string }[]} */
let availableMonths = []
let selectedMonthYear = new Date().getFullYear()
let selectedMonthNum = new Date().getMonth() + 1
let draftTempOffset = 0
let draftHumOffset = 0
let settingsPin = null
let prevTempC = null
let prevHumidityPct = null
let lastAlarmSignature = ''

const thresholds = { tempMin: 22, tempMax: 28, humMin: 40, humMax: 60 }

const tenMinGridPlugin = {
  id: 'envTenMinGrid',
  beforeDraw(chart) {
    if (chart.config.options?.envMode !== 'day') return
    const { ctx, chartArea, scales } = chart
    if (!chartArea || !scales.x) return
    const { top, bottom, left, right } = chartArea
    ctx.save()
    for (let m = 0; m <= 1440; m += 10) {
      const x = scales.x.getPixelForValue(m)
      if (x < left || x > right) continue
      ctx.beginPath()
      ctx.strokeStyle = m % 30 === 0 ? 'rgba(107,114,128,0.22)' : 'rgba(107,114,128,0.07)'
      ctx.lineWidth = m % 30 === 0 ? 1 : 0.5
      ctx.moveTo(x, top)
      ctx.lineTo(x, bottom)
      ctx.stroke()
    }
    ctx.restore()
  },
}

const envLimitsPlugin = {
  id: 'envLimits',
  beforeDatasetsDraw(chart) {
    const { ctx, chartArea, scales } = chart
    if (!chartArea) return
    const { left, right } = chartArea
    const yTemp = scales.yTemp
    const yHum = scales.yHum
    ctx.save()

    // 온도 쾌적 구간 음영(연녹색)
    if (yTemp) {
      const yTop = yTemp.getPixelForValue(thresholds.tempMax)
      const yBot = yTemp.getPixelForValue(thresholds.tempMin)
      ctx.fillStyle = 'rgba(22, 163, 74, 0.07)'
      ctx.fillRect(left, yTop, right - left, yBot - yTop)
    }

    const dash = (y, color) => {
      ctx.beginPath()
      ctx.setLineDash([6, 5])
      ctx.strokeStyle = color
      ctx.lineWidth = 1.2
      ctx.moveTo(left, y)
      ctx.lineTo(right, y)
      ctx.stroke()
    }
    if (yTemp) {
      dash(yTemp.getPixelForValue(thresholds.tempMin), 'rgba(220, 38, 38, 0.5)')
      dash(yTemp.getPixelForValue(thresholds.tempMax), 'rgba(220, 38, 38, 0.5)')
    }
    if (yHum) {
      dash(yHum.getPixelForValue(thresholds.humMin), 'rgba(37, 99, 235, 0.5)')
      dash(yHum.getPixelForValue(thresholds.humMax), 'rgba(37, 99, 235, 0.5)')
    }
    ctx.setLineDash([])
    ctx.restore()
  },
}

function tempOutOfRange(y) {
  return Number.isFinite(y) && (y < thresholds.tempMin || y > thresholds.tempMax)
}

function humOutOfRange(y) {
  return Number.isFinite(y) && (y < thresholds.humMin || y > thresholds.humMax)
}

function envVisible() {
  return document.body.dataset.phase === 'smt'
}

function setEnvPanelVisible(show) {
  if (!envPanelEl) return
  envPanelEl.classList.toggle('hidden', !show)
  if (show && lastEnvPayload) {
    applyEnvPayload(lastEnvPayload)
  }
}

function minutesSince(ms) {
  if (!ms) return null
  return Math.max(0, Math.floor((Date.now() - ms) / 60000))
}

function formatMinLabel(totalMin) {
  if (totalMin >= 1440) return '24:00'
  const m = Math.max(0, Math.min(1439, Math.round(totalMin)))
  const h = Math.floor(m / 60) % 24
  const min = m % 60
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

function mainDatasets() {
  return [
    {
      label: '온도 (℃)',
      data: [],
      borderColor: '#dc2626',
      backgroundColor: 'rgba(220, 38, 38, 0.06)',
      yAxisID: 'yTemp',
      tension: 0.2,
      pointRadius: (ctx) => (tempOutOfRange(ctx.parsed?.y) ? 4 : 2),
      pointHoverRadius: 5,
      pointBackgroundColor: (ctx) => (tempOutOfRange(ctx.parsed?.y) ? '#7f1d1d' : '#dc2626'),
      pointBorderColor: (ctx) => (tempOutOfRange(ctx.parsed?.y) ? '#7f1d1d' : '#dc2626'),
      borderWidth: 2,
      order: 2,
    },
    {
      label: '습도 (%RH)',
      data: [],
      borderColor: '#2563eb',
      backgroundColor: 'rgba(37, 99, 235, 0.06)',
      yAxisID: 'yHum',
      tension: 0.2,
      pointRadius: (ctx) => (humOutOfRange(ctx.parsed?.y) ? 4 : 2),
      pointHoverRadius: 5,
      pointBackgroundColor: (ctx) => (humOutOfRange(ctx.parsed?.y) ? '#1e3a8a' : '#2563eb'),
      pointBorderColor: (ctx) => (humOutOfRange(ctx.parsed?.y) ? '#1e3a8a' : '#2563eb'),
      borderWidth: 2,
      order: 2,
    },
  ]
}

function dayScaleOptions() {
  return {
    x: {
      type: 'linear',
      min: 0,
      max: 1440,
      ticks: {
        stepSize: 30,
        maxRotation: 0,
        autoSkip: false,
        callback: (v) => formatMinLabel(v),
        font: { size: 10 },
      },
      title: { display: true, text: '시간 (00:00 ~ 24:00)' },
      grid: { drawOnChartArea: false },
    },
    yTemp: {
      type: 'linear',
      position: 'left',
      min: 10,
      max: 40,
      title: { display: true, text: '℃' },
      grid: { color: 'rgba(107,114,128,0.12)' },
    },
    yHum: {
      type: 'linear',
      position: 'right',
      min: 30,
      max: 80,
      title: { display: true, text: '%RH' },
      grid: { drawOnChartArea: false },
    },
  }
}

function monthScaleOptions(daysInMonth) {
  return {
    x: {
      type: 'linear',
      min: 1,
      max: daysInMonth,
      ticks: {
        stepSize: 1,
        maxRotation: 0,
        autoSkip: daysInMonth > 20,
        callback: (v) => `${Math.round(v)}일`,
        font: { size: 10 },
      },
      title: { display: true, text: '일' },
      grid: { color: 'rgba(107,114,128,0.1)' },
    },
    yTemp: dayScaleOptions().yTemp,
    yHum: dayScaleOptions().yHum,
  }
}

function destroyChart() {
  if (envChart) {
    envChart.destroy()
    envChart = null
  }
}

function rangeScaleOptions(fromMs, toMs) {
  const spanMs = Math.max(1, toMs - fromMs)
  const multiDay = spanMs > 36 * 3600 * 1000
  return {
    x: {
      type: 'linear',
      min: fromMs,
      max: toMs,
      ticks: {
        maxRotation: 0,
        autoSkip: true,
        maxTicksLimit: 12,
        callback: (v) => formatRangeTick(v, multiDay),
        font: { size: 10 },
      },
      title: { display: true, text: '기간' },
      grid: { color: 'rgba(107,114,128,0.1)' },
    },
    yTemp: dayScaleOptions().yTemp,
    yHum: dayScaleOptions().yHum,
  }
}

function formatRangeTick(ms, multiDay) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  if (multiDay) return `${d.getMonth() + 1}/${d.getDate()}`
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function scalesForMode(mode, arg) {
  if (mode === 'day') return dayScaleOptions()
  if (mode === 'month') return monthScaleOptions(arg || 31)
  return rangeScaleOptions(arg?.fromMs ?? Date.now() - 86400000, arg?.toMs ?? Date.now())
}

function createChart(mode, arg) {
  destroyChart()
  if (!envChartCanvas || typeof Chart === 'undefined') return null

  envChart = new Chart(envChartCanvas, {
    type: 'line',
    data: { datasets: mainDatasets() },
    options: {
      envMode: mode,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          labels: { font: { family: "'Noto Sans KR', sans-serif" } },
        },
        tooltip: {
          callbacks: {
            title(items) {
              if (!items.length) return ''
              const x = items[0].parsed.x
              if (mode === 'day') return formatMinLabel(x)
              if (mode === 'month') return `${Math.round(x)}일`
              return formatRangeFull(x)
            },
          },
        },
      },
      scales: scalesForMode(mode, arg),
    },
    plugins: [tenMinGridPlugin, envLimitsPlugin],
  })
  return envChart
}

function formatRangeFull(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function ensureChart(mode, arg) {
  if (!envChart || envChart.options.envMode !== mode) {
    return createChart(mode, arg)
  }
  return envChart
}

function updateDayChart(history) {
  const chart = ensureChart('day')
  if (!chart) return

  const tempDs = chart.data.datasets.find((d) => d.label === '온도 (℃)')
  const humDs = chart.data.datasets.find((d) => d.label === '습도 (%RH)')
  if (!tempDs || !humDs) return

  tempDs.data = (history || []).map((p) => ({
    x: p.xMin != null ? p.xMin : minutesSinceMidnightFromTs(p.ts),
    y: p.tempC,
  }))
  humDs.data = (history || []).map((p) => ({
    x: p.xMin != null ? p.xMin : minutesSinceMidnightFromTs(p.ts),
    y: p.humidityPct,
  }))

  chart.update('none')
}

function minutesSinceMidnightFromTs(ts) {
  const d = new Date(ts)
  return d.getHours() * 60 + d.getMinutes()
}

function updateMonthChart(payload) {
  const daysInMonth = payload.daysInMonth || 31
  const chart = ensureChart('month', daysInMonth)
  if (!chart) return

  const tempDs = chart.data.datasets.find((d) => d.label === '온도 (℃)')
  const humDs = chart.data.datasets.find((d) => d.label === '습도 (%RH)')
  if (!tempDs || !humDs) return

  tempDs.data = (payload.history || []).map((p) => ({ x: p.day, y: p.tempC }))
  humDs.data = (payload.history || []).map((p) => ({ x: p.day, y: p.humidityPct }))

  chart.update('none')
}

function updateChartTitleDay() {
  if (!envChartTitleEl) return
  const now = new Date()
  envChartTitleEl.textContent = `오늘 (${now.getMonth() + 1}/${now.getDate()}) · 10분 간격`
}

function updateChartTitleMonth(year, month, daysInMonth) {
  if (!envChartTitleEl) return
  envChartTitleEl.textContent = `${year}년 ${month}월 1일 ~ ${daysInMonth}일 (일별 평균 · CSV)`
}

function monthKey(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`
}

function formatMonthLabel(year, month) {
  return `${year}년 ${month}월`
}

function roundCal(v) {
  return Math.round(v * 10) / 10
}

function clampCal(v) {
  return Math.min(CAL_MAX, Math.max(CAL_MIN, roundCal(v)))
}

function formatCal(v) {
  const n = roundCal(v)
  return n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1)
}

function syncMonthNavVisibility() {
  if (envMonthNavEl) {
    envMonthNavEl.classList.toggle('hidden', chartViewMode !== 'month')
  }
  if (envRangeNavEl) {
    envRangeNavEl.classList.toggle('hidden', chartViewMode !== 'range')
  }
}

function toIsoDate(d) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function rangeBounds() {
  const fromStr = envRangeFromEl?.value
  const toStr = envRangeToEl?.value
  const from = fromStr ? new Date(`${fromStr}T00:00:00`).getTime() : Date.now() - 7 * 86400000
  const to = toStr ? new Date(`${toStr}T23:59:59`).getTime() : Date.now()
  return { from, to }
}

function updateRangeChart(payload) {
  const { from, to } = rangeBounds()
  const chart = createChart('range', { fromMs: from, toMs: to })
  if (!chart) return
  const tempDs = chart.data.datasets.find((d) => d.label === '온도 (℃)')
  const humDs = chart.data.datasets.find((d) => d.label === '습도 (%RH)')
  if (!tempDs || !humDs) return
  tempDs.data = (payload.history || []).map((p) => ({ x: p.ts, y: p.tempC }))
  humDs.data = (payload.history || []).map((p) => ({ x: p.ts, y: p.humidityPct }))
  chart.update('none')
}

async function loadRangeChart() {
  const { from, to } = rangeBounds()
  if (envChartTitleEl) {
    const d = (ms) => {
      const x = new Date(ms)
      return `${x.getFullYear()}/${x.getMonth() + 1}/${x.getDate()}`
    }
    envChartTitleEl.textContent = `${d(from)} ~ ${d(to)} (구간 평균)`
  }
  try {
    const r = await fetch(`/api/env/range?from=${from}&to=${to}`)
    const data = await r.json()
    if (!data.ok) return
    rangeChartMeta = data
    if (data.thresholds) applyThresholds(data.thresholds)
    updateRangeChart(data)
    renderStats(data.stats, '구간')
  } catch (_) {}
}

function findMonthIndex(year, month) {
  const key = monthKey(year, month)
  return availableMonths.findIndex((m) => m.key === key)
}

function updateMonthNavButtons() {
  const idx = findMonthIndex(selectedMonthYear, selectedMonthNum)
  const now = new Date()
  const atCurrentCalendarMonth =
    selectedMonthYear === now.getFullYear() && selectedMonthNum === now.getMonth() + 1

  if (envMonthPrevBtn) {
    envMonthPrevBtn.disabled = idx >= 0 && idx >= availableMonths.length - 1
  }
  if (envMonthNextBtn) {
    envMonthNextBtn.disabled = atCurrentCalendarMonth || (idx >= 0 && idx <= 0)
  }
}

function renderMonthSelect() {
  if (!envMonthSelectEl) return
  const selKey = monthKey(selectedMonthYear, selectedMonthNum)
  envMonthSelectEl.innerHTML = ''

  const list = availableMonths.length
    ? availableMonths
    : [{ year: selectedMonthYear, month: selectedMonthNum, key: selKey }]

  for (const m of list) {
    const opt = document.createElement('option')
    opt.value = m.key
    opt.textContent = formatMonthLabel(m.year, m.month)
    if (m.key === selKey) opt.selected = true
    envMonthSelectEl.appendChild(opt)
  }

  if (!list.some((m) => m.key === selKey)) {
    const opt = document.createElement('option')
    opt.value = selKey
    opt.textContent = formatMonthLabel(selectedMonthYear, selectedMonthNum)
    opt.selected = true
    envMonthSelectEl.insertBefore(opt, envMonthSelectEl.firstChild)
  }

  updateMonthNavButtons()
}

async function fetchAvailableMonths() {
  try {
    const r = await fetch('/api/env/months')
    const data = await r.json()
    if (data.ok && Array.isArray(data.months)) {
      availableMonths = data.months
    }
  } catch (_) {}
  renderMonthSelect()
}

function setSelectedMonth(year, month) {
  selectedMonthYear = year
  selectedMonthNum = month
  renderMonthSelect()
}

async function loadMonthChart(year = selectedMonthYear, month = selectedMonthNum) {
  setSelectedMonth(year, month)
  try {
    const r = await fetch(`/api/env/month?year=${year}&month=${month}`)
    const data = await r.json()
    if (!data.ok) return
    monthChartMeta = data
    updateChartTitleMonth(data.year, data.month, data.daysInMonth)
    updateMonthChart(data)
    updateMonthNavButtons()
  } catch (_) {}
}

/** @param {number} direction -1: 이전(과거) 달, +1: 다음(최근) 달 */
function shiftSelectedMonth(direction) {
  const idx = findMonthIndex(selectedMonthYear, selectedMonthNum)
  if (idx < 0) {
    const d = new Date(selectedMonthYear, selectedMonthNum - 1 + direction, 1)
    void loadMonthChart(d.getFullYear(), d.getMonth() + 1)
    return
  }
  const targetIdx = idx - direction
  const next = availableMonths[targetIdx]
  if (!next) return
  void loadMonthChart(next.year, next.month)
}

function applyThresholds(t) {
  if (!t) return
  if (t.tempMin != null) thresholds.tempMin = t.tempMin
  if (t.tempMax != null) thresholds.tempMax = t.tempMax
  if (t.humMin != null) thresholds.humMin = t.humMin
  if (t.humMax != null) thresholds.humMax = t.humMax
}

function renderStats(stats, labelPrefix) {
  const prefix = labelPrefix || '오늘'

  function fill(statsEl, valEl, breachEl, block, unit) {
    if (!statsEl || !valEl) return
    if (!stats || !stats.count || !block) {
      statsEl.classList.add('hidden')
      valEl.textContent = '—'
      if (breachEl) breachEl.textContent = ''
      return
    }
    statsEl.classList.remove('hidden')
    valEl.textContent = `${prefix} ${block.min} · ${block.avg} · ${block.max} ${unit}`
    if (breachEl) {
      breachEl.textContent = block.breachPct > 0 ? `이탈 ${block.breachPct}%` : ''
    }
  }

  fill(envTempStatsEl, envStatTempEl, envStatTempBreachEl, stats?.temp, '℃')
  fill(envHumStatsEl, envStatHumEl, envStatHumBreachEl, stats?.hum, '%RH')
}

function setGaugeState(gaugeEl, stateEl, value, min, max, hasAlarm) {
  if (!gaugeEl) return
  gaugeEl.classList.remove('env-gauge--ok', 'env-gauge--warn', 'env-gauge--alarm')
  if (stateEl) {
    stateEl.classList.add('hidden')
    stateEl.textContent = ''
  }
  if (!Number.isFinite(value)) return

  const out = value < min || value > max
  if (hasAlarm) {
    gaugeEl.classList.add('env-gauge--alarm')
    if (stateEl) {
      stateEl.classList.remove('hidden')
      stateEl.textContent = value > max ? '상한 초과' : value < min ? '하한 미만' : '경보'
    }
  } else if (out) {
    gaugeEl.classList.add('env-gauge--warn')
    if (stateEl) {
      stateEl.classList.remove('hidden')
      stateEl.textContent = '주의'
    }
  } else {
    gaugeEl.classList.add('env-gauge--ok')
    if (stateEl) {
      stateEl.classList.remove('hidden')
      stateEl.textContent = '정상'
    }
  }
}

function applyGaugeStates(tempC, humidityPct, activeAlarms) {
  const alarms = activeAlarms || []
  const tempAlarm = alarms.some((a) => a.metric === 'temp' && a.state === 'raised')
  const humAlarm = alarms.some((a) => a.metric === 'hum' && a.state === 'raised')
  setGaugeState(
    envTempGaugeEl,
    envTempStateEl,
    tempC,
    thresholds.tempMin,
    thresholds.tempMax,
    tempAlarm,
  )
  setGaugeState(
    envHumGaugeEl,
    envHumStateEl,
    humidityPct,
    thresholds.humMin,
    thresholds.humMax,
    humAlarm,
  )
}

function playAlarmBeep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.frequency.value = 880
    gain.gain.value = 0.08
    osc.start()
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35)
    osc.stop(ctx.currentTime + 0.35)
  } catch (_) {}
}

function checkAlarmSound(alarms) {
  const active = (alarms || []).filter((a) => a.state === 'raised')
  const sig = active.map((a) => `${a.metric}:${a.kind}`).sort().join('|')
  if (sig && sig !== lastAlarmSignature) playAlarmBeep()
  lastAlarmSignature = sig
}

function formatAlarmTime(ts) {
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatAlarmEvent(ev) {
  const metric =
    ev.metric === 'temp' ? '온도' : ev.metric === 'hum' ? '습도' : '센서'
  const kind =
    ev.kind === 'high' ? '상한 초과' : ev.kind === 'low' ? '하한 미만' : '수신 단절'
  const unit = ev.metric === 'temp' ? '℃' : ev.metric === 'hum' ? '%RH' : ''
  if (ev.state === 'raised') {
    if (ev.metric === 'sensor') return `${metric} ${kind}`
    return `${metric} ${kind} — ${ev.value}${unit}`
  }
  const dur =
    ev.durationMs != null ? ` (${Math.max(1, Math.round(ev.durationMs / 60000))}분)` : ''
  return `${metric} 정상 복귀${dur}`
}

function renderAlarmList(alarms) {
  if (!envAlarmListEl) return
  envAlarmListEl.innerHTML = ''
  if (!alarms || alarms.length === 0) {
    const li = document.createElement('li')
    li.className = 'env-alarm-empty'
    li.textContent = '최근 7일 경보 이력 없음'
    envAlarmListEl.appendChild(li)
    return
  }
  for (const ev of alarms.slice(0, 30)) {
    const li = document.createElement('li')
    li.className = `env-alarm-item env-alarm-item--${ev.state}`
    li.innerHTML = `<span class="env-alarm-item__time">${formatAlarmTime(ev.ts)}</span><span class="env-alarm-item__msg">${formatAlarmEvent(ev)}</span>`
    envAlarmListEl.appendChild(li)
  }
}

async function loadAlarmHistory() {
  const to = Date.now()
  const from = to - 7 * 24 * 3600 * 1000
  try {
    const r = await fetch(`/api/env/alarms?from=${from}&to=${to}`)
    const data = await r.json()
    if (data.ok) renderAlarmList(data.alarms)
  } catch (_) {
    renderAlarmList([])
  }
}

function initRangeDates() {
  const now = new Date()
  const weekAgo = new Date(now.getTime() - 6 * 86400000)
  if (envRangeFromEl && !envRangeFromEl.value) envRangeFromEl.value = toIsoDate(weekAgo)
  if (envRangeToEl && !envRangeToEl.value) envRangeToEl.value = toIsoDate(now)
}

function exportCsv() {
  const { from, to } = rangeBounds()
  window.location.href = `/api/env/export?from=${from}&to=${to}`
}

function toggleKiosk() {
  const on = document.body.classList.toggle('env-kiosk')
  const panel = envPanelEl
  if (!panel) return
  if (on) {
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' })
    panel.requestFullscreen?.().catch(() => {})
  } else {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
  }
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) document.body.classList.remove('env-kiosk')
})

function formatGaugeValue(temp, hum) {
  if (envTempValEl) envTempValEl.textContent = `${temp.toFixed(1)}℃`
  if (envHumValEl) envHumValEl.textContent = `${hum.toFixed(1)}%`
}

function updateTrendEl(el, prev, next) {
  if (!el) return
  if (prev == null || !Number.isFinite(prev) || !Number.isFinite(next)) {
    el.classList.add('hidden')
    el.textContent = ''
    return
  }
  const delta = Math.round((next - prev) * 10) / 10
  if (Math.abs(delta) < 0.05) {
    el.classList.add('hidden')
    el.textContent = ''
    return
  }
  el.classList.remove('hidden', 'env-gauge__trend--up', 'env-gauge__trend--down', 'env-gauge__trend--flat')
  if (delta > 0) {
    el.classList.add('env-gauge__trend--up')
    el.textContent = `▲ ${Math.abs(delta).toFixed(1)}`
  } else {
    el.classList.add('env-gauge__trend--down')
    el.textContent = `▼ ${Math.abs(delta).toFixed(1)}`
  }
}

function applyGaugeReadings(tempC, humidityPct, activeAlarms) {
  if (!Number.isFinite(tempC) || !Number.isFinite(humidityPct)) {
    if (envTempValEl) envTempValEl.textContent = '—'
    if (envHumValEl) envHumValEl.textContent = '—'
    if (envTempTrendEl) envTempTrendEl.classList.add('hidden')
    if (envHumTrendEl) envHumTrendEl.classList.add('hidden')
    applyGaugeStates(NaN, NaN, activeAlarms)
    prevTempC = null
    prevHumidityPct = null
    return
  }

  updateTrendEl(envTempTrendEl, prevTempC, tempC)
  updateTrendEl(envHumTrendEl, prevHumidityPct, humidityPct)
  formatGaugeValue(tempC, humidityPct)
  applyGaugeStates(tempC, humidityPct, activeAlarms)
  prevTempC = tempC
  prevHumidityPct = humidityPct
}

function setModeButtons(mode) {
  if (envModeDayBtn) {
    envModeDayBtn.classList.toggle('env-mode-btn--active', mode === 'day')
    envModeDayBtn.setAttribute('aria-selected', mode === 'day' ? 'true' : 'false')
  }
  if (envModeMonthBtn) {
    envModeMonthBtn.classList.toggle('env-mode-btn--active', mode === 'month')
    envModeMonthBtn.setAttribute('aria-selected', mode === 'month' ? 'true' : 'false')
  }
  if (envModeRangeBtn) {
    envModeRangeBtn.classList.toggle('env-mode-btn--active', mode === 'range')
    envModeRangeBtn.setAttribute('aria-selected', mode === 'range' ? 'true' : 'false')
  }
}

function applyEnvPayload(payload) {
  if (!payload || !payload.ok) {
    if (envStatusEl) {
      envStatusEl.textContent = (payload && payload.error) || '온습도 데이터 없음'
      envStatusEl.className = 'env-panel__status env-panel__status--warn'
    }
    return
  }

  lastEnvPayload = payload
  if (payload.thresholds) applyThresholds(payload.thresholds)

  const activeAlarms = payload.alarms || []
  checkAlarmSound(activeAlarms)

  if (envPanelEl) {
    const hasAlarm = activeAlarms.some((a) => a.state === 'raised')
    envPanelEl.classList.toggle('env-panel--alarm', hasAlarm)
  }

  if (!envVisible()) return

  const latest = payload.latest
  const warnMin = payload.staleWarnMin != null ? payload.staleWarnMin : 5
  const alarmMin = payload.staleAlarmMin != null ? payload.staleAlarmMin : 15

  if (latest) {
    applyGaugeReadings(latest.tempC, latest.humidityPct, activeAlarms)
    const m = minutesSince(latest.ts)
    if (envUpdatedEl) {
      envUpdatedEl.textContent =
        m === null ? '—' : m === 0 ? '방금 갱신' : `${m}분 전 갱신`
    }
  } else {
    applyGaugeReadings(NaN, NaN, activeAlarms)
    if (envUpdatedEl) envUpdatedEl.textContent = '수신 대기'
  }

  if (envStatusEl) {
    const sensorAlarm = activeAlarms.some(
      (a) => a.metric === 'sensor' && a.state === 'raised',
    )
    const metricAlarm = activeAlarms.some(
      (a) => (a.metric === 'temp' || a.metric === 'hum') && a.state === 'raised',
    )
    const staleMin = latest ? minutesSince(latest.ts) : null

    if (!latest) {
      envStatusEl.textContent = '센서 데이터 없음'
      envStatusEl.className = 'env-panel__status env-panel__status--warn'
    } else if (sensorAlarm || (staleMin != null && staleMin >= alarmMin)) {
      envStatusEl.textContent = '센서 단절 경보'
      envStatusEl.className = 'env-panel__status env-panel__status--alarm'
    } else if (metricAlarm) {
      envStatusEl.textContent = '한계 경보'
      envStatusEl.className = 'env-panel__status env-panel__status--alarm'
    } else if (staleMin != null && staleMin >= warnMin) {
      envStatusEl.textContent = '센서 수신 지연'
      envStatusEl.className = 'env-panel__status env-panel__status--warn'
    } else {
      envStatusEl.textContent = '실시간'
      envStatusEl.className = 'env-panel__status env-panel__status--ok'
    }
  }

  if (chartViewMode === 'day') {
    updateChartTitleDay()
    updateDayChart(payload.history || [])
    renderStats(payload.stats, '오늘')
  }
}

async function switchChartMode(mode) {
  chartViewMode = mode
  setModeButtons(mode)
  syncMonthNavVisibility()
  if (mode === 'day') {
    updateChartTitleDay()
    createChart('day')
    if (lastEnvPayload && lastEnvPayload.ok) {
      updateDayChart(lastEnvPayload.history || [])
      renderStats(lastEnvPayload.stats, '오늘')
    }
  } else if (mode === 'range') {
    initRangeDates()
    await loadRangeChart()
  } else {
    await fetchAvailableMonths()
    await loadMonthChart(selectedMonthYear, selectedMonthNum)
  }
}

function openModal(modal) {
  if (!modal) return
  modal.classList.remove('hidden')
}

function closeModal(modal) {
  if (!modal) return
  modal.classList.add('hidden')
}

function closeAllModals() {
  closeModal(envPinModal)
  closeModal(envSettingsModal)
  settingsPin = null
}

function renderCalibrationDraft() {
  if (envCalTempValEl) envCalTempValEl.textContent = formatCal(draftTempOffset)
  if (envCalHumValEl) envCalHumValEl.textContent = formatCal(draftHumOffset)
}

async function loadCalibrationDraft() {
  try {
    const r = await fetch('/api/env/calibration')
    const data = await r.json()
    if (data.ok && data.calibration) {
      draftTempOffset = roundCal(Number(data.calibration.tempOffset) || 0)
      draftHumOffset = roundCal(Number(data.calibration.humidityOffset) || 0)
    }
  } catch (_) {}
  renderCalibrationDraft()
}

function adjustDraft(which, delta) {
  if (which === 'temp') draftTempOffset = clampCal(draftTempOffset + delta)
  else draftHumOffset = clampCal(draftHumOffset + delta)
  renderCalibrationDraft()
  if (envCalStatusEl) envCalStatusEl.classList.add('hidden')
}

async function applyCalibration() {
  if (!settingsPin) {
    if (envCalStatusEl) {
      envCalStatusEl.textContent = '설정 인증이 필요합니다.'
      envCalStatusEl.className = 'env-modal__status env-modal__status--err'
      envCalStatusEl.classList.remove('hidden')
    }
    return
  }
  try {
    const r = await fetch('/api/env/calibration', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Settings-Pin': settingsPin,
      },
      body: JSON.stringify({
        tempOffset: draftTempOffset,
        humidityOffset: draftHumOffset,
      }),
    })
    const data = await r.json()
    if (!data.ok) throw new Error(data.error || '적용 실패')
    if (envCalStatusEl) {
      envCalStatusEl.textContent = '보정값이 적용되었습니다. 이후 수신 데이터부터 반영됩니다.'
      envCalStatusEl.className = 'env-modal__status env-modal__status--ok'
      envCalStatusEl.classList.remove('hidden')
    }
    await fetchEnvSnapshot()
    if (chartViewMode === 'month') await loadMonthChart()
    if (chartViewMode === 'range') await loadRangeChart()
  } catch (e) {
    if (envCalStatusEl) {
      envCalStatusEl.textContent = e.message || '적용 실패'
      envCalStatusEl.className = 'env-modal__status env-modal__status--err'
      envCalStatusEl.classList.remove('hidden')
    }
  }
}

async function openSettingsFlow() {
  settingsPin = null
  if (envPinInput) envPinInput.value = ''
  if (envPinError) envPinError.classList.add('hidden')
  openModal(envPinModal)
  envPinInput?.focus()
}

function submitPin() {
  const pin = envPinInput ? envPinInput.value.trim() : ''
  if (pin !== SETTINGS_PIN) {
    if (envPinError) envPinError.classList.remove('hidden')
    return
  }
  settingsPin = pin
  closeModal(envPinModal)
  void loadCalibrationDraft().then(() => openModal(envSettingsModal))
}

async function fetchEnvSnapshot() {
  try {
    const r = await fetch('/api/env/snapshot')
    const data = await r.json()
    applyEnvPayload(data)
  } catch (_) {
    applyEnvPayload({ ok: false, error: '온습도 API 연결 실패' })
  }
}

function connectEnvStream() {
  if (envEventSource) {
    envEventSource.close()
    envEventSource = null
  }
  if (typeof EventSource === 'undefined') {
    fetchEnvSnapshot()
    setInterval(fetchEnvSnapshot, 15000)
    return
  }
  const src = new EventSource('/api/env/stream')
  envEventSource = src
  src.onmessage = (ev) => {
    try {
      applyEnvPayload(JSON.parse(ev.data))
    } catch (_) {}
  }
  src.onerror = () => {
    if (envStatusEl) {
      envStatusEl.textContent = '재연결 중…'
      envStatusEl.className = 'env-panel__status env-panel__status--warn'
    }
  }
}

if (envModeDayBtn) {
  envModeDayBtn.addEventListener('click', () => void switchChartMode('day'))
}
if (envModeMonthBtn) {
  envModeMonthBtn.addEventListener('click', () => void switchChartMode('month'))
}
if (envModeRangeBtn) {
  envModeRangeBtn.addEventListener('click', () => void switchChartMode('range'))
}
if (envRangeApplyBtn) {
  envRangeApplyBtn.addEventListener('click', () => void loadRangeChart())
}
if (envRangeWeekBtn) {
  envRangeWeekBtn.addEventListener('click', () => {
    const now = new Date()
    const weekAgo = new Date(now.getTime() - 6 * 86400000)
    if (envRangeFromEl) envRangeFromEl.value = toIsoDate(weekAgo)
    if (envRangeToEl) envRangeToEl.value = toIsoDate(now)
    void loadRangeChart()
  })
}
if (envExportBtn) {
  envExportBtn.addEventListener('click', exportCsv)
}
if (envAlarmRefreshBtn) {
  envAlarmRefreshBtn.addEventListener('click', () => void loadAlarmHistory())
}
if (kioskBtn) {
  kioskBtn.addEventListener('click', toggleKiosk)
}
if (envMonthPrevBtn) {
  envMonthPrevBtn.addEventListener('click', () => shiftSelectedMonth(-1))
}
if (envMonthNextBtn) {
  envMonthNextBtn.addEventListener('click', () => shiftSelectedMonth(1))
}
if (envMonthSelectEl) {
  envMonthSelectEl.addEventListener('change', () => {
    const key = envMonthSelectEl.value
    const m = availableMonths.find((x) => x.key === key)
    if (m) void loadMonthChart(m.year, m.month)
    else {
      const [y, mo] = key.split('-').map((x) => parseInt(x, 10))
      if (y && mo) void loadMonthChart(y, mo)
    }
  })
}
if (envSettingsBtn) {
  envSettingsBtn.addEventListener('click', () => void openSettingsFlow())
}
if (envPinSubmit) {
  envPinSubmit.addEventListener('click', submitPin)
}
if (envPinInput) {
  envPinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitPin()
  })
}
for (const el of document.querySelectorAll('[data-env-modal-close]')) {
  el.addEventListener('click', closeAllModals)
}
if (envCalTempUp) envCalTempUp.addEventListener('click', () => adjustDraft('temp', CAL_STEP))
if (envCalTempDown) envCalTempDown.addEventListener('click', () => adjustDraft('temp', -CAL_STEP))
if (envCalHumUp) envCalHumUp.addEventListener('click', () => adjustDraft('hum', CAL_STEP))
if (envCalHumDown) envCalHumDown.addEventListener('click', () => adjustDraft('hum', -CAL_STEP))
if (envCalApplyBtn) envCalApplyBtn.addEventListener('click', () => void applyCalibration())

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAllModals()
})

window.addEventListener('mes-phase-change', (e) => {
  setEnvPanelVisible(e.detail && e.detail.phase === 'smt')
})

document.body.dataset.phase = document.body.dataset.phase || 'smt'
setEnvPanelVisible(envVisible())
setModeButtons('day')
syncMonthNavVisibility()
try {
  createChart('day')
  updateChartTitleDay()
} catch (e) {
  console.error('[env] chart init failed', e)
}
void fetchAvailableMonths()
initRangeDates()
void fetchEnvSnapshot()
void loadAlarmHistory()
connectEnvStream()
