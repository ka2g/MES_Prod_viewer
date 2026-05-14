'use strict'

const THEMES = [
  { badge: '#2563eb', bar: '#3b82f6' },
  { badge: '#16a34a', bar: '#22c55e' },
  { badge: '#ca8a04', bar: '#eab308' },
  { badge: '#db2777', bar: '#ec4899' },
]

const lineListEl = document.getElementById('lineList')
const hiddenLinesBarEl = document.getElementById('hiddenLinesBar')
const emptyEl = document.getElementById('emptyState')
const alertEl = document.getElementById('alertBar')
const connPillEl = document.getElementById('connPill')
const clockEl = document.getElementById('clockLabel')
const phaseSmtBtn = document.getElementById('phaseSmt')
const phaseAssyBtn = document.getElementById('phaseAssy')

/** smt | assy */
let currentPhase = 'smt'
let eventSource = null

/** 마지막으로 정상 payloads를 받은 시각(ms) — 경과 분 실시간 가산용 */
let mesPayloadReceivedWallMs = Date.now()

/** 순서/숨김 재적용용 마지막 정상 페이로드 */
let lastGoodPayload = null

/** 드래그 중인 라인 id (HTML5 DnD) */
let dragLineId = null

const LS_ORDER = (phase) => `mesViewer.order.${phase}`
const LS_HIDDEN = (phase) => `mesViewer.hidden.${phase}`

/** 드래그 직후 배지 더블클릭으로 숨김이 뜨는 것 방지 */
let suppressBadgeDblclick = false

function loadOrder(phase) {
  try {
    const raw = localStorage.getItem(LS_ORDER(phase))
    if (!raw) return []
    const a = JSON.parse(raw)
    return Array.isArray(a) ? a : []
  } catch {
    return []
  }
}

function saveOrder(phase, order) {
  try {
    localStorage.setItem(LS_ORDER(phase), JSON.stringify(order))
  } catch (_) {}
}

function loadHiddenSet(phase) {
  try {
    const raw = localStorage.getItem(LS_HIDDEN(phase))
    if (!raw) return new Set()
    const a = JSON.parse(raw)
    return new Set(Array.isArray(a) ? a : [])
  } catch {
    return new Set()
  }
}

function saveHiddenSet(phase, set) {
  try {
    localStorage.setItem(LS_HIDDEN(phase), JSON.stringify([...set]))
  } catch (_) {}
}

/** 서버에만 있는 신규 라인은 정렬 배열 끝에 유지 */
function mergeOrderWithPayload(phase, lines) {
  const ids = lines.map((l) => l.id)
  const next = loadOrder(phase).filter((id) => ids.includes(id))
  for (const id of ids) {
    if (!next.includes(id)) next.push(id)
  }
  saveOrder(phase, next)
  return next
}

function sortLinesByOrder(lines, order) {
  return order.map((id) => lines.find((l) => l.id === id)).filter(Boolean)
}

function moveIdBefore(order, fromId, toId) {
  const o = order.filter((id) => id !== fromId)
  const i = o.indexOf(toId)
  if (i === -1) return order
  o.splice(i, 0, fromId)
  return o
}

function moveIdAfter(order, fromId, toId) {
  const o = order.filter((id) => id !== fromId)
  const i = o.indexOf(toId)
  if (i === -1) return order
  o.splice(i + 1, 0, fromId)
  return o
}

function emptyMessage(phase) {
  if (phase === 'assy') {
    return '표시할 ASSY 라인이 없습니다. activated=Y 인 계획이 없거나, 조회 기간 내 데이터가 없을 수 있습니다.'
  }
  return '표시할 생산 라인 데이터가 없습니다. SQL 연결과 최근 계획 행 존재 여부를 확인하세요.'
}

function updatePhaseButtons() {
  const isSmt = currentPhase === 'smt'
  phaseSmtBtn.classList.toggle('phase-btn--active', isSmt)
  phaseAssyBtn.classList.toggle('phase-btn--active', !isSmt)
  phaseSmtBtn.setAttribute('aria-selected', isSmt ? 'true' : 'false')
  phaseAssyBtn.setAttribute('aria-selected', !isSmt ? 'true' : 'false')
}

function apiLinesUrl() {
  return `/api/lines?phase=${encodeURIComponent(currentPhase)}`
}

function streamUrl() {
  return `/api/lines/stream?phase=${encodeURIComponent(currentPhase)}`
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

function formatClock(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(
    d.getMinutes(),
  )}:${pad2(d.getSeconds())}`
}

setInterval(() => {
  clockEl.textContent = formatClock(new Date())
  refreshElapsedLiveDisplay()
}, 500)
clockEl.textContent = formatClock(new Date())

function formatInt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return new Intl.NumberFormat('ko-KR').format(Math.round(Number(n)))
}

function minutesSince(iso) {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const diffMs = Date.now() - t
  const m = Math.floor(diffMs / 60000)
  if (!Number.isFinite(m) || m < 0) return 0
  return m
}

/** 서버(SQL GETDATE) 계산 분 + 수신 후 분 가산 */
function refreshElapsedLiveDisplay() {
  const addMin = Math.floor((Date.now() - mesPayloadReceivedWallMs) / 60000)
  document.querySelectorAll('[data-el-base-min]').forEach((el) => {
    const raw = el.getAttribute('data-el-base-min')
    if (raw === null || raw === '') {
      el.textContent = '—'
      return
    }
    const b = Number.parseInt(raw, 10)
    if (!Number.isFinite(b)) {
      el.textContent = '—'
      return
    }
    el.textContent = `${b + addMin}분`
  })
}

function verifyClass(ok) {
  if (ok === true) return 'verif verif--ok'
  if (ok === false) return 'verif verif--ng'
  return 'verif verif--unk'
}

function verifyLabel(ok, kind) {
  if (ok === true) return '● OK'
  if (ok === false) return '● NG'
  return '—'
}

function prodQtyClass(progressPct, lineStatus) {
  if (progressPct === null) return 'qty qty--prod'
  if (lineStatus === 'stopped') return 'qty qty--bad'
  if (lineStatus === 'idle') return 'qty qty--warn'
  return 'qty qty--prod'
}

function statusClass(lineStatus) {
  if (lineStatus === 'running') return 'status-pill status-pill--on'
  if (lineStatus === 'idle') return 'status-pill status-pill--idle'
  return 'status-pill status-pill--off'
}

function statusLabel(lineStatus) {
  if (lineStatus === 'running') return '가동중'
  if (lineStatus === 'idle') return '유휴'
  return '비가동'
}

function barGradient(theme, pct) {
  const p = pct === null ? 0 : pct
  return `linear-gradient(90deg, ${theme.bar}, ${pct !== null && p > 92 ? '#22c55e' : theme.bar})`
}

function renderLine(row) {
  const theme = THEMES[row.colorIndex % THEMES.length] || THEMES[0]
  const pct = row.progressPct
  const m = minutesSince(row.lastUpdateAt)
  const st = row.lineStatus || 'stopped'

  const el = document.createElement('article')
  el.className = 'line-card'
  el.dataset.lineId = row.id

  el.innerHTML = `
    <div class="line-card__grid">
      <div class="line-card__cell">
        <span
          class="badge-line badge-line--drag"
          draggable="true"
          style="background:${theme.badge}"
          title="드래그: 순서 변경 · 더블클릭: 숨김"
          aria-label="${escapeHtml(row.displayLineLabel)}: 드래그로 순서 변경, 더블클릭으로 숨김"
        >${escapeHtml(row.displayLineLabel)}</span>
      </div>
      <div class="line-card__cell line-card__cell--extra">
        <div class="badge-model-pack">
          <div class="badge-model-pack__code">${escapeHtml(row.modelCode || '—')}</div>
          <div class="badge-model-pack__lot">${escapeHtml(row.prodLot || '—')}</div>
        </div>
      </div>
      <div class="line-card__cell line-card__cell--extra car-model-col">
        <div class="car-model-title">${escapeHtml(row.modelTitle)}</div>
      </div>
      <div class="line-card__cell line-card__cell--extra">
        <span class="chip-plane">${escapeHtml(row.workSide || '—')}</span>
      </div>
      <div class="line-card__cell line-card__cell--extra">
        <div class="cell-label-muted">계획수량</div>
        <div class="qty">${formatInt(row.planQty)}</div>
      </div>
      <div class="line-card__cell line-card__cell--extra">
        <div class="cell-label-muted">생산수량</div>
        <div class="${prodQtyClass(pct, st)}">${formatInt(row.prodQty)}</div>
      </div>
      <div class="line-card__cell line-card__cell--extra">
        <div class="cell-label-muted">경과(분)</div>
        <div class="qty qty--elapsed" data-el-base-min="${row.elapsedMinutes != null ? String(row.elapsedMinutes) : ''}">${row.elapsedMinutes != null ? `${row.elapsedMinutes}분` : '—'}</div>
      </div>
      <div class="line-card__cell line-card__cell--extra verif-group">
        <div class="${verifyClass(row.masterVerifyOk)}">
          <div>마스터</div>${verifyLabel(row.masterVerifyOk)}
        </div>
        <div class="${verifyClass(row.submaterialVerifyOk)}">
          <div>부자재</div>${verifyLabel(row.submaterialVerifyOk)}
        </div>
      </div>
      <div class="line-card__cell line-card__cell--extra progress-block">
        <div class="progress-hint">${m === null ? '실적 갱신 —' : `실적갱신 ${m}분 전`}</div>
        <div class="progress-row">
          <span style="opacity:.75;font-weight:600;font-size:.78rem;">진척율</span>
          <span class="progress-pct">${pct === null ? '—' : `${pct}%`}</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width:${pct ?? 0}%;background-image:${barGradient(theme, pct)}"></div>
        </div>
      </div>
      <div class="line-card__cell line-card__cell--status">
        <span class="${statusClass(st)}">${statusLabel(st)}</span>
      </div>
    </div>
  `

  return el
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function setAlert(message) {
  if (!message) {
    alertEl.classList.add('hidden')
    alertEl.textContent = ''
    connPillEl.className = 'pill pill--live'
    connPillEl.innerHTML =
      '<span class="dot dot--green"></span><span>실시간 연동</span>'
    return
  }
  alertEl.textContent = message
  alertEl.classList.remove('hidden')
  connPillEl.className = 'pill pill--muted'
  connPillEl.innerHTML = '<span class="dot dot--green" style="background:#94a3b8;box-shadow:none"></span><span>연결 오류</span>'
}

function renderHiddenStrip(phase, sortedLines, hidden) {
  const hiddenRows = sortedLines.filter((r) => hidden.has(r.id))
  if (hiddenRows.length === 0) {
    hiddenLinesBarEl.classList.add('hidden')
    hiddenLinesBarEl.replaceChildren()
    return
  }

  hiddenLinesBarEl.classList.remove('hidden')
  hiddenLinesBarEl.replaceChildren()

  const head = document.createElement('div')
  head.className = 'hidden-lines-bar__title'
  head.textContent = `숨긴 라인 (${hiddenRows.length})`
  hiddenLinesBarEl.appendChild(head)

  const chips = document.createElement('div')
  chips.className = 'hidden-lines-bar__chips'

  for (const row of hiddenRows) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'hidden-line-chip'
    b.textContent = row.displayLineLabel || row.lineKey || row.id
    b.title = '다시 표시'
    b.dataset.lineId = row.id
    chips.appendChild(b)
  }

  const restoreAll = document.createElement('button')
  restoreAll.type = 'button'
  restoreAll.className = 'hidden-lines-bar__restore-all'
  restoreAll.textContent = '숨김 전체 해제'
  restoreAll.dataset.action = 'restore-all-hidden'

  hiddenLinesBarEl.appendChild(chips)
  hiddenLinesBarEl.appendChild(restoreAll)
}

/** 캐시된 페이로드로 목록만 다시 그림 (순서·숨김 변경 시) */
function repaintFromCache() {
  if (!lastGoodPayload || !lastGoodPayload.ok || !Array.isArray(lastGoodPayload.lines)) return
  applyPayload(lastGoodPayload, { skipCacheReplace: true })
}

function applyPayload(payload, opts = {}) {
  if (!opts.skipCacheReplace && payload && payload.ok && Array.isArray(payload.lines)) {
    lastGoodPayload = payload
  }

  if (!payload || !payload.ok || !Array.isArray(payload.lines)) {
    lineListEl.replaceChildren()
    hiddenLinesBarEl.classList.add('hidden')
    hiddenLinesBarEl.replaceChildren()
    emptyEl.textContent = emptyMessage(payload && payload.phase ? payload.phase : currentPhase)
    emptyEl.classList.remove('hidden')
    setAlert((payload && payload.error) || '데이터 형식 오류 또는 서버 응답 실패.')
    return
  }

  if (payload.lines.length === 0) {
    lineListEl.replaceChildren()
    hiddenLinesBarEl.classList.add('hidden')
    hiddenLinesBarEl.replaceChildren()
    emptyEl.textContent = emptyMessage(payload.phase || currentPhase)
    emptyEl.classList.remove('hidden')
    setAlert(null)
    return
  }

  const phase = payload.phase || currentPhase
  const order = mergeOrderWithPayload(phase, payload.lines)
  const sorted = sortLinesByOrder(payload.lines, order)
  const hidden = loadHiddenSet(phase)

  emptyEl.classList.add('hidden')
  setAlert(null)

  renderHiddenStrip(phase, sorted, hidden)

  lineListEl.replaceChildren()

  const visible = sorted.filter((r) => !hidden.has(r.id))

  if (visible.length === 0) {
    const hint = document.createElement('p')
    hint.className = 'all-lines-hidden-hint'
    hint.textContent = '표시 중인 라인이 없습니다. 아래에서 숨김을 해제하세요.'
    lineListEl.appendChild(hint)
  } else {
    mesPayloadReceivedWallMs = Date.now()
    for (const row of visible) {
      lineListEl.appendChild(renderLine(row))
    }
    refreshElapsedLiveDisplay()
  }
}

hiddenLinesBarEl.addEventListener('click', (e) => {
  const t = e.target
  if (!(t instanceof Element)) return
  if (t.dataset.action === 'restore-all-hidden') {
    const phase = (lastGoodPayload && lastGoodPayload.phase) || currentPhase
    saveHiddenSet(phase, new Set())
    repaintFromCache()
    return
  }
  const chip = t.closest('.hidden-line-chip')
  if (!chip || !chip.dataset.lineId) return
  const phase = (lastGoodPayload && lastGoodPayload.phase) || currentPhase
  const set = loadHiddenSet(phase)
  set.delete(chip.dataset.lineId)
  saveHiddenSet(phase, set)
  repaintFromCache()
})

lineListEl.addEventListener('dblclick', (e) => {
  const t = e.target
  if (!(t instanceof Element)) return
  const badge = t.closest('.badge-line--drag')
  if (!badge) return
  if (suppressBadgeDblclick) return
  const card = badge.closest('.line-card')
  if (!card || !card.dataset.lineId) return
  const phase = (lastGoodPayload && lastGoodPayload.phase) || currentPhase
  const set = loadHiddenSet(phase)
  set.add(card.dataset.lineId)
  saveHiddenSet(phase, set)
  repaintFromCache()
})

lineListEl.addEventListener('dragstart', (e) => {
  const badge = e.target instanceof Element && e.target.classList.contains('badge-line--drag') ? e.target : null
  if (!badge) return
  const card = badge.closest('.line-card')
  if (!card || !card.dataset.lineId) return
  dragLineId = card.dataset.lineId
  card.classList.add('line-card--dragging')
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', dragLineId)
})

lineListEl.addEventListener('dragend', (e) => {
  const badge = e.target instanceof Element && e.target.classList.contains('badge-line--drag') ? e.target : null
  if (badge) {
    const card = badge.closest('.line-card')
    if (card) card.classList.remove('line-card--dragging')
  }
  lineListEl.querySelectorAll('.line-card--drag-over').forEach((el) => el.classList.remove('line-card--drag-over'))
  dragLineId = null
  suppressBadgeDblclick = true
  window.setTimeout(() => {
    suppressBadgeDblclick = false
  }, 450)
})

lineListEl.addEventListener('dragover', (e) => {
  if (!dragLineId) return
  const card = e.target instanceof Element ? e.target.closest('.line-card') : null
  if (!card || !card.dataset.lineId || card.dataset.lineId === dragLineId) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'

  lineListEl.querySelectorAll('.line-card--drag-over').forEach((el) => {
    if (el !== card) {
      el.classList.remove('line-card--drag-over')
      delete el.dataset.dropBefore
    }
  })

  const rect = card.getBoundingClientRect()
  const before = e.clientY < rect.top + rect.height / 2
  card.classList.add('line-card--drag-over')
  card.dataset.dropBefore = before ? '1' : '0'
})

lineListEl.addEventListener('dragleave', (e) => {
  const card = e.target instanceof Element ? e.target.closest('.line-card') : null
  if (!card) return
  const related = e.relatedTarget
  if (related && card.contains(related)) return
  card.classList.remove('line-card--drag-over')
  delete card.dataset.dropBefore
})

lineListEl.addEventListener('drop', (e) => {
  if (!dragLineId) return
  const card = e.target instanceof Element ? e.target.closest('.line-card') : null
  if (!card || !card.dataset.lineId) return
  const targetId = card.dataset.lineId
  if (targetId === dragLineId) return
  e.preventDefault()

  const phase = (lastGoodPayload && lastGoodPayload.phase) || currentPhase
  let order = loadOrder(phase)
  const before = card.dataset.dropBefore === '1'
  order = before ? moveIdBefore(order, dragLineId, targetId) : moveIdAfter(order, dragLineId, targetId)
  saveOrder(phase, order)

  card.classList.remove('line-card--drag-over')
  delete card.dataset.dropBefore
  lineListEl.querySelectorAll('.line-card--drag-over').forEach((el) => el.classList.remove('line-card--drag-over'))

  repaintFromCache()
})

function connectStream() {
  if (eventSource) {
    eventSource.close()
    eventSource = null
  }
  if (typeof EventSource === 'undefined') {
    return
  }
  const src = new EventSource(streamUrl())
  eventSource = src
  src.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data)
      applyPayload(data)
    } catch (_e) {
      setAlert('SSE 메시지 파싱 오류.')
    }
  }
  src.onerror = () => {
    connPillEl.className = 'pill pill--muted'
    connPillEl.innerHTML =
      '<span class="dot dot--green" style="background:#f59e0b;box-shadow:none"></span><span>재연결 중…</span>'
  }
}

function switchPhase(next) {
  const p = next === 'assy' ? 'assy' : 'smt'
  if (p === currentPhase) return
  currentPhase = p
  updatePhaseButtons()
  lineListEl.replaceChildren()
  hiddenLinesBarEl.classList.add('hidden')
  hiddenLinesBarEl.replaceChildren()
  emptyEl.textContent = emptyMessage(currentPhase)
  emptyEl.classList.remove('hidden')
  setAlert(null)
  lastGoodPayload = null
  connectStream()
  if (typeof EventSource === 'undefined') {
    fetch(apiLinesUrl())
      .then((r) => r.json())
      .then(applyPayload)
      .catch(() => setAlert('초기 데이터 로드 실패.'))
  }
}

phaseSmtBtn.addEventListener('click', () => switchPhase('smt'))
phaseAssyBtn.addEventListener('click', () => switchPhase('assy'))

updatePhaseButtons()

if (typeof EventSource !== 'undefined') {
  connectStream()
} else {
  fetch(apiLinesUrl())
    .then((r) => r.json())
    .then(applyPayload)
    .catch(() => setAlert('초기 데이터 로드 실패.'))
}
