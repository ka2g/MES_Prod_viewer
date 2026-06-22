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

const SETTINGS_PIN = 'smt1234'
const CAL_STEP = 0.1
const CAL_MIN = -50
const CAL_MAX = 50

let envEventSource = null
let envChart = null
let lastEnvPayload = null
/** @type {'day'|'month'} */
let chartViewMode = 'day'
let monthChartMeta = null
/** @type {{ year: number, month: number, key: string }[]} */
let availableMonths = []
let selectedMonthYear = new Date().getFullYear()
let selectedMonthNum = new Date().getMonth() + 1
let draftTempOffset = 0
let draftHumOffset = 0
let settingsPin = null
let prevTempC = null
let prevHumidityPct = null

const TEMP_LIMITS = [22, 28]
const HUM_LIMITS = [40, 60]

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

function buildRefDatasets(xMin, xMax, yAxisID, values, color) {
  return values.map((y) => ({
    label: `_limit_${yAxisID}_${y}`,
    data: [
      { x: xMin, y },
      { x: xMax, y },
    ],
    borderColor: color,
    borderDash: [6, 5],
    borderWidth: 1.2,
    pointRadius: 0,
    pointHitRadius: 0,
    yAxisID,
    order: 0,
    tension: 0,
  }))
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
      pointRadius: 2,
      pointHoverRadius: 4,
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
      pointRadius: 2,
      pointHoverRadius: 4,
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

function createChart(mode, daysInMonth) {
  destroyChart()
  if (!envChartCanvas || typeof Chart === 'undefined') return null

  const xMin = mode === 'day' ? 0 : 1
  const xMax = mode === 'day' ? 1440 : daysInMonth || 31

  envChart = new Chart(envChartCanvas, {
    type: 'line',
    data: {
      datasets: [
        ...mainDatasets(),
        ...buildRefDatasets(xMin, xMax, 'yTemp', TEMP_LIMITS, 'rgba(220, 38, 38, 0.55)'),
        ...buildRefDatasets(xMin, xMax, 'yHum', HUM_LIMITS, 'rgba(37, 99, 235, 0.55)'),
      ],
    },
    options: {
      envMode: mode,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          labels: {
            font: { family: "'Noto Sans KR', sans-serif" },
            filter: (item) => !String(item.text).startsWith('_limit_'),
          },
        },
        tooltip: {
          callbacks: {
            title(items) {
              if (!items.length) return ''
              const x = items[0].parsed.x
              if (mode === 'day') return formatMinLabel(x)
              return `${Math.round(x)}일`
            },
          },
        },
      },
      scales: mode === 'day' ? dayScaleOptions() : monthScaleOptions(daysInMonth),
    },
    plugins: [tenMinGridPlugin],
  })
  return envChart
}

function ensureChart(mode, daysInMonth) {
  if (!envChart || envChart.options.envMode !== mode) {
    return createChart(mode, daysInMonth)
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
  if (!envMonthNavEl) return
  envMonthNavEl.classList.toggle('hidden', chartViewMode !== 'month')
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

function applyGaugeReadings(tempC, humidityPct) {
  if (!Number.isFinite(tempC) || !Number.isFinite(humidityPct)) {
    if (envTempValEl) envTempValEl.textContent = '—'
    if (envHumValEl) envHumValEl.textContent = '—'
    if (envTempTrendEl) envTempTrendEl.classList.add('hidden')
    if (envHumTrendEl) envHumTrendEl.classList.add('hidden')
    prevTempC = null
    prevHumidityPct = null
    return
  }

  updateTrendEl(envTempTrendEl, prevTempC, tempC)
  updateTrendEl(envHumTrendEl, prevHumidityPct, humidityPct)
  formatGaugeValue(tempC, humidityPct)
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
  if (!envVisible()) return

  const latest = payload.latest
  if (latest) {
    applyGaugeReadings(latest.tempC, latest.humidityPct)
    const m = minutesSince(latest.ts)
    if (envUpdatedEl) {
      envUpdatedEl.textContent =
        m === null ? '—' : m === 0 ? '방금 갱신' : `${m}분 전 갱신`
    }
  } else {
    applyGaugeReadings(NaN, NaN)
    if (envUpdatedEl) envUpdatedEl.textContent = '수신 대기'
  }

  if (envStatusEl) {
    if (!latest) {
      envStatusEl.textContent = '센서 데이터 없음'
      envStatusEl.className = 'env-panel__status env-panel__status--warn'
    } else {
      const stale = minutesSince(latest.ts) != null && minutesSince(latest.ts) > 5
      envStatusEl.textContent = stale ? '센서 수신 지연' : '실시간'
      envStatusEl.className = stale
        ? 'env-panel__status env-panel__status--warn'
        : 'env-panel__status env-panel__status--ok'
    }
  }

  if (chartViewMode === 'day') {
    updateChartTitleDay()
    updateDayChart(payload.history || [])
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
    }
  } else {
    const now = new Date()
    if (
      selectedMonthYear === now.getFullYear() &&
      selectedMonthNum === now.getMonth() + 1 &&
      !monthChartMeta
    ) {
      /* keep current month */
    }
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
void fetchEnvSnapshot()
connectEnvStream()
