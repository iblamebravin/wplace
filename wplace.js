(() => { ‘use strict’;
// ===== CONFIG =====
const VERSION = 'v8.5';
const UI_TICK_MS = 500;
const REOPEN_DELAY_MS = 2000;
const FULL_DEPLETION_REOPEN_MS = 35000;
const DEFAULT_COOLDOWN_MIN = 10;
const AUTOSAVE_EVERY_N_PIXELS = 50;

// ===== THEME =====
const THEME = {
    bg: '#0A0A0F',
    panel: 'rgba(16, 16, 26, 0.85)',
    border: 'rgba(127, 90, 240, 0.5)',
    text: '#E0E0FF',
    subtle: '#8F8FB8',
    neon1: '#7F5AF0',
    neon2: '#2CB67D',
    good: '#00FF7F',
    warn: '#FFD700',
    bad: '#F92A82',
    backdrop: 'rgba(0, 0, 0, 0.4)'
};

// ===== TEXT (English only) =====
const TEXT = {
    title: `FXBot ${VERSION}`,
    tab_control: 'Control',
    tab_image: 'Image',
    tab_advanced: 'Advanced',
    upload: 'Upload',
    resize: 'Resize',
    selectPos: 'Set Position',
    preview: 'Show Preview',
    start: 'Start',
    pause: 'Pause',
    resume: 'Resume',
    stop: 'Stop',
    builtQueue: 'Queue built: {n} pixels',
    needImgPos: 'Select an area, capture the image, and set the position on the canvas.',
    waitingClick: 'Click the top-left then bottom-right of the area.',
    posOK: 'Aligned at X:{x} Y:{y}.',
    loadOK: 'Image: {w}×{h}',
    overlayOn: 'Overlay ON',
    overlayOff: 'Overlay OFF',
    done: '✅ Done!',
    paused: '⏸️ Paused.',
    resumed: '▶️ Resuming...',
    stopped: '⏹️ Stopped.',
    committing: '⏳ Committing...',
    committed: '✅ Committed.',
    sessionSaved: '💾 Session saved.',
    sessionLoaded: '📦 Session restored.',
    toastHit: '⚠️ Out of paint!',
    coolingDown: '🧊 Cooldown {min}min... {mmss} left',
    noCanvas: 'ERROR: Site canvas not found!',
    openPalette: 'ERROR: Site color palette is closed!',
    colorMissing: 'ERROR: Color #{id} not found in palette! Pausing.',
    nothingToPaint: 'Nothing to paint with current filters.',
    started: '🚀 Painting...',
    mustPickPos: 'Set position first.',
    mustUpload: 'Capture image first.',
    cooldownLabel: 'Cooldown (min)',
    speed: 'Speed (CPS)',
    order: 'Paint Order',
    order_scanline: 'Scanline',
    order_bycolor: 'By Color (Efficient)',
    skipWhite: 'Skip White',
    skipAlpha: 'Skip Transparent',
    processed: 'Progress',
    manualStartLabel: 'Manual Start',
    manualStartIndex: 'Start Pixel (#)',
    captchaDetected: '⚠️ MANUAL ACTION: Solve the Captcha to continue!',
    turboMode: 'Turbo Mode (Max Speed)'
};

// ===== STATE =====
const state = {
    running: false,
    paused: false,
    stopFlag: false,
    captchaHold: false,
    imgData: null,
    imgWidth: 0,
    imgHeight: 0,
    pos: null,
    selection: null, // {x, y, w, h}
    pixelSize: 1,
    skipWhite: true,
    skipTransparent: true,
    whiteThr: 250,
    alphaThr: 100,
    order: 'bycolor',
    turbo: true,
    queue: [],
    queuePtr: 0,
    palette: [],
    colorCache: new Map(),
    overlayCanvas: null,
    overlayNeedsRepaint: true,
    cps: 80,
    sinceSave: 0,
    cooldownMin: DEFAULT_COOLDOWN_MIN,
    toast: {
        enabled: true,
        seen: false,
        seenAt: 0,
        handling: false,
        lastSeenAt: 0,
        observer: null,
        root: null
    },
    supervisor: {
        observer: null
    },
    committing: false,
    applied: {
        set: new Set(),
        pending: [],
        pendingSet: new Set()
    },
    loopActive: false,
    lastPaintTs: 0,
    loopRequestId: null,
    uiTicker: null,
    ui: {
        keydownHandler: null,
        uiRoot: null
    },
    manualStart: {
        enabled: false,
        index: 0
    }
};
const dom = {};

// ===== UTILS =====
const qs = (s, r = document) => r.querySelector(s);
const qsa = (s, r = document) => Array.from(r.querySelectorAll(s));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const colorDist = (a, b) => {
    const dr = a[0] - b[0],
        dg = a[1] - b[1],
        db = a[2] - b[2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
};
const log = (...args) => {
    console.log(`%c[FXBot ${VERSION}]`, `color:${THEME.neon1}`, ...args);
};
const mmss = ms => {
    ms = Math.max(0, ms | 0);
    const s = Math.ceil(ms / 1000);
    const m = (s / 60 | 0);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
};
const toDataURL = imgData => {
    const c = document.createElement('canvas');
    c.width = imgData.width;
    c.height = imgData.height;
    c.getContext('2d').putImageData(imgData, 0, 0);
    return c.toDataURL('image/png');
};
const fromDataURL = async (dataURL) => {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const c = document.createElement('canvas');
            c.width = img.width;
            c.height = img.height;
            const ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0);
            resolve(ctx.getImageData(0, 0, img.width, img.height));
        };
        img.onerror = reject;
        img.src = dataURL;
    });
};
const now = () => performance.now();
const t = (id, params) => {
    const raw = (TEXT[id] ?? id);
    if (!params) return raw;
    return raw.replace(/\{(\w+)\}/g, (_, k) => (params[k] !== undefined ? String(params[k]) : ''));
};

// ===== CORE =====
const getTargetCanvas = () => qs('.maplibregl-canvas, canvas[aria-label="Map"], canvas');
const canvasRect = () => {
    const c = getTargetCanvas();
    return c ? c.getBoundingClientRect() : null;
};
const extractPalette = () => {
    try {
        return qsa('[id^="color-"]').filter(el => !el.querySelector('svg')).map(el => {
            const id = parseInt(el.id.replace('color-', ''), 10);
            const m = (el.style.backgroundColor || '').match(/\d+/g);
            const rgb = m ? m.map(Number).slice(0, 3) : [0, 0, 0];
            return {
                id,
                rgb,
                element: el
            };
        }).filter(x => Number.isFinite(x.id));
    } catch {
        return [];
    }
};
const selectColor = id => {
    const el = document.getElementById(`color-${id}`);
    if (el) {
        el.click();
        return true;
    }
    return false;
};

// ===== SESSION =====
const sessKey = () => `fxbot-pixels-v9:${location.host}`;

function snapshot() {
    return {
        img: state.imgData ? toDataURL(state.imgData) : null,
        pos: state.pos,
        imgWidth: state.imgWidth,
        imgHeight: state.imgHeight,
        pixelSize: state.pixelSize,
        skipWhite: state.skipWhite,
        skipTransparent: state.skipTransparent,
        whiteThr: state.whiteThr,
        alphaThr: state.alphaThr,
        order: state.order,
        turbo: state.turbo,
        cps: state.cps,
        queuePtr: state.queuePtr,
        cooldownMin: state.cooldownMin,
        manualStart: {
            ...state.manualStart
        },
        appliedSet: Array.from(state.applied.set),
        ts: Date.now()
    };
}
async function restore(obj) {
    if (!obj) return false;
    try {
        if (obj.img) {
            state.imgData = await fromDataURL(obj.img);
            state.imgWidth = state.imgData.width;
            state.imgHeight = state.imgData.height;
        }
        state.pos = obj.pos || null;
        state.imgWidth = obj.imgWidth || 0;
        state.imgHeight = obj.imgHeight || 0;
        state.pixelSize = obj.pixelSize || 1;
        state.skipWhite = !!obj.skipWhite;
        state.skipTransparent = !!obj.skipTransparent;
        state.whiteThr = obj.whiteThr ?? 250;
        state.alphaThr = obj.alphaThr ?? 100;
        state.order = obj.order || 'bycolor';
        state.turbo = obj.turbo !== false;
        state.cps = obj.cps ?? 80;
        state.queuePtr = obj.queuePtr ?? 0;
        state.cooldownMin = obj.cooldownMin ?? DEFAULT_COOLDOWN_MIN;
        if (obj.manualStart) {
            state.manualStart = {
                ...state.manualStart,
                ...obj.manualStart
            };
        }
        state.applied.set = new Set(obj.appliedSet || []);
        markOverlayDirty();
        applyStateToUI();
        enableAfterImg();
        setStatus(t('sessionLoaded'));
        updateProgress();
        if (state.imgData && state.pos) {
            ensureOverlay();
            repaintOverlay();
            placeOverlay();
            setStatus(t('overlayOn'));
        }
        return true;
    } catch {
        return false;
    }
}

function saveSession(reason = '') {
    try {
        localStorage.setItem(sessKey(), JSON.stringify(snapshot()));
        if (reason !== 'silent') setStatus(t('sessionSaved'));
    } catch {}
}

function hasSession() {
    return !!localStorage.getItem(sessKey());
}
async function loadSession() {
    const s = localStorage.getItem(sessKey());
    if (!s) return false;
    return await restore(JSON.parse(s));
}

// ===== UI =====
function getToastContainer() {
    let c = document.getElementById('fx-toast-container');
    if (!c) {
        c = document.createElement('div');
        c.id = 'fx-toast-container';
        document.body.appendChild(c);
    }
    return c;
}

function showToast(message, type = 'info', ms = 3000) {
    const toast = document.createElement('div');
    toast.className = `fx-toast fx-toast-${type}`;
    toast.textContent = message;
    getToastContainer().appendChild(toast);
    setTimeout(() => toast.classList.add('fx-toast-fade'), ms - 500);
    setTimeout(() => {
        try {
            toast.remove();
        } catch {}
    }, ms);
}

function buildUI() {
    const old = document.getElementById('fxbot-ui');
    if (old) {
        if (state.ui.keydownHandler) {
            window.removeEventListener('keydown', state.ui.keydownHandler, true);
            state.ui.keydownHandler = null;
        }
        old.remove();
    }
    const root = document.createElement('div');
    root.id = 'fxbot-ui';
    state.ui.uiRoot = root;
    root.innerHTML = `<div id="fx-drag-handle"><div class="title-gradient">${t('title')}</div><div class="header-controls"><button id="fx-save" class="fx-btn icon" title="Save Session">💾</button><button id="fx-restore" class="fx-btn icon" title="Restore Session" ${hasSession()?'':'disabled'}>📦</button><button id="fx-min" class="fx-btn icon" title="Minimize">─</button></div></div><div id="fx-body"><div class="fx-tabs"><button class="fx-tab-btn active" data-tab="control">${t('tab_control')}</button><button class="fx-tab-btn" data-tab="image">${t('tab_image')}</button><button class="fx-tab-btn" data-tab="advanced">${t('tab_advanced')}</button></div><div id="fx-status">${t('needImgPos')}</div><div class="fx-tab-content active" data-content="control"><div class="progress-bar-container"><div id="fx-progress-bar"></div></div><div id="fx-progress-text">${t('processed')}: <span>0</span> / <span>0</span></div><div class="grid2 main-controls"><button id="fx-start" class="fx-btn success" disabled>▶️ ${t('start')}</button><button id="fx-pause" class="fx-btn warn" style="display:none">⏸️ ${t('pause')}</button><button id="fx-resume" class="fx-btn success" style="display:none">▶️ ${t('resume')}</button><button id="fx-stop" class="fx-btn danger" style="display:none">⏹️ ${t('stop')}</button></div></div><div class="fx-tab-content" data-content="image"><div class="icon-toolbar"><button id="fx-select-area" class="fx-btn icon-btn primary" title="Select Area">🔲</button><button id="fx-capture" class="fx-btn icon-btn" title="Capture" disabled>📸</button><button id="fx-preview" class="fx-btn icon-btn" title="${t('preview')}" disabled>👁️</button></div><div id="fx-img-status" class="info-text"></div></div><div class="fx-tab-content" data-content="advanced"><div class="adv-group"><label>${t('cooldownLabel')}<input id="cooldown-min" type="number" min="1" max="60" value="${state.cooldownMin}"></label><label>${t('speed')}<input id="fx-cps" type="number" min="1" max="1000" value="${state.cps}"></label></div><div class="adv-group"><label>${t('order')}<select id="fx-order"><option value="bycolor" ${state.order==='bycolor'?'selected':''}>${t('order_bycolor')}</option><option value="scanline" ${state.order==='scanline'?'selected':''}>${t('order_scanline')}</option></select></label><label class="checkbox-label">${t('turboMode')} <input id="fx-turbo" type="checkbox" ${state.turbo?'checked':''}></label></div><div class="adv-group"><label class="checkbox-label">${t('skipWhite')} <input id="fx-skipw" type="checkbox" ${state.skipWhite?'checked':''}></label><label class="checkbox-label">${t('skipAlpha')} <input id="fx-skipa" type="checkbox" ${state.skipTransparent?'checked':''}></label></div><div class="adv-group"><label class="checkbox-label">${t('manualStartLabel')} <input id="fx-manualstart-en" type="checkbox" ${state.manualStart?.enabled?'checked':''}></label><label>${t('manualStartIndex')} <input id="fx-manualstart-idx" type="number" min="0" value="${state.manualStart?.index||0}" ${state.manualStart?.enabled?'':'disabled'}></label></div></div></div>`;
    document.body.appendChild(root);
    cacheDomElements();
    makeDraggable(root, dom.dragHandle);
    const g = sel => root.querySelector(sel);
    dom.minBtn.addEventListener('click', () => {
        dom.body.style.display = dom.body.style.display === 'none' ? 'flex' : 'none';
    });
    dom.saveBtn.addEventListener('click', () => {
        saveSession('manual');
        showToast(t('sessionSaved'));
    });
    dom.restoreBtn.addEventListener('click', async () => {
        if (await loadSession()) {
            showToast(t('sessionLoaded'));
        }
    });
    dom.selectAreaBtn.addEventListener('click', selectArea);
    dom.captureBtn.addEventListener('click', captureArea);
    dom.previewBtn.addEventListener('click', toggleOverlay);
    dom.startBtn.addEventListener('click', startPainting);
    dom.pauseBtn.addEventListener('click', pausePainting);
    dom.resumeBtn.addEventListener('click', resumePainting);
    dom.stopBtn.addEventListener('click', stopPainting);
    const onInput = (sel, fn) => g(sel)?.addEventListener('input', fn);
    onInput('#fx-cps', e => state.cps = clamp(parseInt(e.target.value, 10) || 80, 1, 1000));
    g('#fx-order')?.addEventListener('change', e => {
        state.order = e.target.value;
    });
    g('#fx-turbo')?.addEventListener('change', e => {
        state.turbo = e.target.checked;
    });
    g('#fx-skipw')?.addEventListener('change', e => {
        state.skipWhite = e.target.checked;
        markOverlayDirty();
        refreshOverlay();
    });
    g('#fx-skipa')?.addEventListener('change', e => {
        state.skipTransparent = e.target.checked;
        markOverlayDirty();
        refreshOverlay();
    });
    onInput('#cooldown-min', e => {
        state.cooldownMin = clamp(parseInt(e.target.value, 10) || DEFAULT_COOLDOWN_MIN, 1, 60);
    });
    const msChk = g('#fx-manualstart-en');
    const msIdx = g('#fx-manualstart-idx');
    msChk?.addEventListener('change', () => {
        state.manualStart.enabled = !!msChk.checked;
        if (msIdx) msIdx.disabled = !state.manualStart.enabled;
    });
    msIdx?.addEventListener('input', () => {
        state.manualStart.index = Math.max(0, parseInt(msIdx.value, 10) || 0);
    });
    root.querySelectorAll('.fx-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            root.querySelectorAll('.fx-tab-btn, .fx-tab-content').forEach(el => el.classList.remove('active'));
            btn.classList.add('active');
            root.querySelector(`.fx-tab-content[data-content="${tab}"]`).classList.add('active');
        });
    });
    if (state.ui.keydownHandler) window.removeEventListener('keydown', state.ui.keydownHandler, true);
    state.ui.keydownHandler = (ev) => {
        if (ev.target.matches('input, select')) return;
        const key = ev.key.toLowerCase();
        if (key === 'p') state.running && !state.paused && !state.captchaHold ? pausePainting() : resumePainting();
        else if (key === 's') stopPainting();
    };
    window.addEventListener('keydown', state.ui.keydownHandler, true);
    applyStateToUI();
    updateButtons();
    updateProgress();
}

function cacheDomElements() {
    const root = state.ui.uiRoot;
    dom.status = qs('#fx-status', root);
    dom.imgStatus = qs('#fx-img-status', root);
    dom.progressText = qs('#fx-progress-text', root);
    dom.progressBar = qs('#fx-progress-bar', root);
    dom.startBtn = qs('#fx-start', root);
    dom.pauseBtn = qs('#fx-pause', root);
    dom.resumeBtn = qs('#fx-resume', root);
    dom.stopBtn = qs('#fx-stop', root);
    dom.selectAreaBtn = qs('#fx-select-area', root);
    dom.captureBtn = qs('#fx-capture', root);
    dom.previewBtn = qs('#fx-preview', root);
    dom.minBtn = qs('#fx-min', root);
    dom.saveBtn = qs('#fx-save', root);
    dom.restoreBtn = qs('#fx-restore', root);
    dom.dragHandle = qs('#fx-drag-handle', root);
    dom.body = qs('#fx-body', root);
}
const setStatus = (msg, type = '') => {
    if (dom.status) {
        dom.status.innerHTML = msg;
        dom.status.className = type ? `status-${type}` : '';
    }
};
const setImgStatus = msg => {
    if (dom.imgStatus) dom.imgStatus.innerHTML = msg;
};
const setProgressText = msg => {
    if (dom.progressText) dom.progressText.innerHTML = msg;
};

function updateProgress() {
    const done = state.applied.set.size + state.applied.pending.length;
    const total = state.totalTarget;
    setProgressText(`${t('processed')}: <span>${done}</span> / <span>${total}</span>`);
    if (dom.progressBar) dom.progressBar.style.width = total > 0 ? `${clamp((done / total) * 100, 0, 100)}%` : '0%';
}

function updateButtons() {
    if (!dom.startBtn) return;
    if (!state.running) {
        dom.startBtn.style.display = 'block';
        dom.pauseBtn.style.display = 'none';
        dom.resumeBtn.style.display = 'none';
        dom.stopBtn.style.display = 'none';
    } else if (state.paused || state.captchaHold) {
        dom.startBtn.style.display = 'none';
        dom.pauseBtn.style.display = 'none';
        dom.resumeBtn.style.display = 'block';
        dom.stopBtn.style.display = 'block';
    } else {
        dom.startBtn.style.display = 'none';
        dom.pauseBtn.style.display = 'block';
        dom.resumeBtn.style.display = 'none';
        dom.stopBtn.style.display = 'block';
    }
}

function applyStateToUI() {
    const root = state.ui.uiRoot;
    const setVal = (sel, val) => {
        const el = qs(sel, root);
        if (el) el.value = val;
    };
    const setChk = (sel, val) => {
        const el = qs(sel, root);
        if (el) el.checked = !!val;
    };
    setVal('#fx-cps', state.cps);
    setChk('#fx-skipw', state.skipWhite);
    setChk('#fx-skipa', state.skipTransparent);
    setChk('#fx-turbo', state.turbo);
    setVal('#cooldown-min', state.cooldownMin);
    setChk('#fx-manualstart-en', state.manualStart.enabled);
    setVal('#fx-manualstart-idx', state.manualStart.index || 0);
}

function enableAfterImg() {
    if (dom.captureBtn) {
        dom.captureBtn.disabled = false;
    }
    if (dom.previewBtn) {
        dom.previewBtn.disabled = false;
    }
    if (dom.startBtn) {
        dom.startBtn.disabled = false;
    }
}

function makeDraggable(panel, handle) {
    let sx = 0,
        sy = 0,
        sl = 0,
        st = 0,
        drag = false;
    const onStart = (e) => {
        if (e.target.matches('button, select, input')) return;
        drag = true;
        const p = e.touches ? e.touches[0] : e;
        sx = p.clientX;
        sy = p.clientY;
        const r = panel.getBoundingClientRect();
        sl = r.left;
        st = r.top;
        document.addEventListener('mousemove', onMove, {
            passive: false
        });
        document.addEventListener('touchmove', onMove, {
            passive: false
        });
        document.addEventListener('mouseup', onEnd, true);
        document.addEventListener('touchend', onEnd, true);
    };
    const onMove = (e) => {
        if (!drag) return;
        e.preventDefault();
        const p = e.touches ? e.touches[0] : e;
        panel.style.left = (sl + p.clientX - sx) + 'px';
        panel.style.top = (st + p.clientY - sy) + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
    };
    const onEnd = () => {
        drag = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('mouseup', onEnd, true);
        document.removeEventListener('touchend', onEnd, true);
    };
    handle.addEventListener('mousedown', onStart);
    handle.addEventListener('touchstart', onStart, {
        passive: true
    });
}

// ===== IMAGE =====
function selectArea() {
    const rect = canvasRect();
    if (!rect) {
        showToast(t('noCanvas'), 'error');
        return;
    }
    setStatus('Click the top-left of the area.');
    let startPos = null;
    const clickHandler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (state.ui.uiRoot?.contains(e.target)) return;
        const relX = Math.floor(e.clientX - rect.left);
        const relY = Math.floor(e.clientY - rect.top);
        if (!startPos) {
            startPos = {x: relX, y: relY};
            setStatus('Click the bottom-right of the area.');
            return;
        }
        const endPos = {x: relX, y: relY};
        const minX = Math.min(startPos.x, endPos.x);
        const minY = Math.min(startPos.y, endPos.y);
        const maxX = Math.max(startPos.x, endPos.x);
        const maxY = Math.max(startPos.y, endPos.y);
        state.pos = {x: minX, y: minY};
        state.imgWidth = maxX - minX + 1;
        state.imgHeight = maxY - minY + 1;
        document.removeEventListener('click', clickHandler, {capture: true});
        markOverlayDirty();
        setStatus(t('posOK', {x: minX, y: minY}) + ` Size: ${state.imgWidth}×${state.imgHeight}`);
        dom.captureBtn.disabled = false;
        saveSession('auto');
    };
    document.addEventListener('click', clickHandler, {capture: true});
}

function captureArea() {
    if (!state.pos || !state.imgWidth || !state.imgHeight) {
        showToast('Select area first', 'warn');
        return;
    }
    const canvas = getTargetCanvas();
    if (!canvas) {
        showToast(t('noCanvas'), 'error');
        return;
    }
    const rect = canvasRect();
    const cropX = state.pos.x;
    const cropY = state.pos.y;
    const cropW = state.imgWidth;
    const cropH = state.imgHeight;
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = cropW;
    tempCanvas.height = cropH;
    const ctx = tempCanvas.getContext('2d');
    ctx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
    state.imgData = ctx.getImageData(0, 0, cropW, cropH);
    state.queuePtr = 0;
    state.applied.set.clear();
    state.applied.pending.length = 0;
    state.applied.pendingSet.clear();
    markOverlayDirty();
    setImgStatus(t('loadOK', {
        w: cropW,
        h: cropH
    }));
    enableAfterImg();
    state.totalTarget = 0;
    updateProgress();
    saveSession('capture');
    if (state.overlayCanvas) {
        repaintOverlay();
        placeOverlay();
        setStatus(t('overlayOn'));
    }
}

// ===== OVERLAY =====
function ensureOverlay() {
    if (state.overlayCanvas && document.body.contains(state.overlayCanvas)) return state.overlayCanvas;
    const c = document.createElement('canvas');
    c.id = 'fx-overlay';
    document.body.appendChild(c);
    state.overlayCanvas = c;
    state.overlayNeedsRepaint = true;
    window.addEventListener('scroll', placeOverlay, {
        passive: true
    });
    window.addEventListener('resize', placeOverlay);
    return c;
}

function toggleOverlay() {
    if (state.overlayCanvas) {
        state.overlayCanvas.remove();
        state.overlayCanvas = null;
        setStatus(t('overlayOff'));
        return;
    }
    if (!state.imgData || !state.pos) {
        showToast(t('mustPickPos'), 'warn');
        return;
    }
    ensureOverlay();
    markOverlayDirty();
    repaintOverlay();
    placeOverlay();
    setStatus(t('overlayOn'));
}

function markOverlayDirty() {
    state.overlayNeedsRepaint = true;
}

function refreshOverlay() {
    if (!state.overlayCanvas) return;
    repaintOverlay();
    placeOverlay();
}

function repaintOverlay() {
    if (!state.overlayCanvas || !state.imgData) return;
    const tile = Math.max(1, state.pixelSize | 0);
    const iw = state.imgWidth,
        ih = state.imgHeight;
    const cw = iw * tile,
        ch = ih * tile;
    if (state.overlayCanvas.width !== cw) state.overlayCanvas.width = cw;
    if (state.overlayCanvas.height !== ch) state.overlayCanvas.height = ch;
    if (!state.overlayNeedsRepaint) return;
    state.overlayNeedsRepaint = false;
    const ctx = state.overlayCanvas.getContext('2d');
    ctx.clearRect(0, 0, cw, ch);
    const data = state.imgData.data;
    for (let y = 0; y < ih; y++) {
        for (let x = 0; x < iw; x++) {
            const i = (y * iw + x) * 4;
            const r = data[i],
                g = data[i + 1],
                b = data[i + 2],
                a = data[i + 3];
            if ((state.skipTransparent && a < state.alphaThr) || (state.skipWhite && r >= state.whiteThr && g >= state.whiteThr && b >= state.whiteThr)) continue;
            ctx.fillStyle = `rgba(${r},${g},${b},${a/255})`;
            ctx.fillRect(x * tile, y * tile, tile, tile);
        }
    }
}

function placeOverlay() {
    if (!state.overlayCanvas || !state.pos) return;
    const rect = canvasRect();
    if (!rect) {
        state.overlayCanvas.style.display = 'none';
        return;
    }
    state.overlayCanvas.style.display = 'block';
    state.overlayCanvas.style.left = (rect.left + window.scrollX + state.pos.x) + 'px';
    state.overlayCanvas.style.top = (rect.top + window.scrollY + state.pos.y) + 'px';
}

// ===== QUEUE =====
function buildQueue() {
    state.colorCache.clear();
    const canvas = getTargetCanvas();
    if (!canvas || !state.pos || !state.imgData) {
        state.queue = [];
        return;
    }
    const w = state.imgWidth,
        h = state.imgHeight;
    const cropX = state.pos.x;
    const cropY = state.pos.y;
    const cropW = w;
    const cropH = h;
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = cropW;
    tempCanvas.height = cropH;
    const ctx = tempCanvas.getContext('2d');
    ctx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
    const currentData = ctx.getImageData(0, 0, cropW, cropH);
    const targetData = state.imgData.data;
    const currData = currentData.data;

    const pixelsToProcess = [];
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const idx = (y * w + x) * 4;
            const tr = targetData[idx],
                tg = targetData[idx + 1],
                tb = targetData[idx + 2],
                ta = targetData[idx + 3];
            const cr = currData[idx],
                cg = currData[idx + 1],
                cb = currData[idx + 2],
                ca = currData[idx + 3];
            if ((state.skipTransparent && ta < state.alphaThr) || (state.skipWhite && tr >= state.whiteThr && tg >= state.whiteThr && tb >= state.whiteThr)) continue;
            if (colorDist([tr, tg, tb], [cr, cg, cb]) <= 5) continue; // Small threshold for minor differences

            let best = state.colorCache.get(`${tr},${tg},${tb}`);
            if (!best) {
                let md = Infinity,
                    sel = state.palette[0] || {
                        id: 0,
                        rgb: [tr, tg, tb]
                    };
                if (state.palette.length) {
                    for (const p of state.palette) {
                        const d = colorDist([tr, tg, tb], p.rgb);
                        if (d < md) {
                            md = d;
                            sel = p;
                        }
                    }
                }
                best = sel;
                state.colorCache.set(`${tr},${tg},${tb}`, best);
            }

            const c = imageToCanvas(x, y);
            if (!c || state.applied.set.has(`${c.x},${c.y}`)) continue;

            pixelsToProcess.push({
                x,
                y,
                colorId: best.id,
                rgb: best.rgb,
                canvas: c
            });
        }
    }

    if (state.order === 'bycolor') {
        const byColor = new Map();
        for (const p of pixelsToProcess) {
            if (!byColor.has(p.colorId)) byColor.set(p.colorId, []);
            byColor.get(p.colorId).push(p);
        }
        const sortedKeys = Array.from(byColor.keys()).sort((a, b) => a - b);

        let finalQueue = [];
        for (const key of sortedKeys) {
            finalQueue = finalQueue.concat(byColor.get(key));
        }
        state.queue = finalQueue;

    } else {
        state.queue = pixelsToProcess;
    }

    setStatus(t('builtQueue', {
        n: state.queue.length
    }));
    state.totalTarget = state.applied.set.size + state.queue.length;
    updateProgress();
}

function imageToCanvas(ix, iy) {
    const rect = canvasRect();
    if (!rect || !state.pos) return null;
    const s = Math.max(1, state.pixelSize | 0);
    const clickX = state.pos.x + ix * s + Math.floor(s / 2);
    const clickY = state.pos.y + iy * s + Math.floor(s / 2);
    if (clickX < 0 || clickY < 0 || clickX > rect.width || clickY > rect.height) return null;
    return {
        x: clickX,
        y: clickY
    };
}

// ===== ACTIONS =====
function clickCanvasSynthetic(canvas, cx, cy) {
    const rect = canvas.getBoundingClientRect();
    if (!rect) return;
    const absX = Math.round(rect.left + cx);
    const absY = Math.round(rect.top + cy);
    const commonPointer = {
        clientX: absX,
        clientY: absY,
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        isPrimary: true,
        button: 0,
        buttons: 1
    };
    const commonMouse = {
        clientX: absX,
        clientY: absY,
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1
    };
    canvas.dispatchEvent(new PointerEvent('pointerdown', commonPointer));
    canvas.dispatchEvent(new MouseEvent('mousedown', commonMouse));
    canvas.dispatchEvent(new PointerEvent('pointerup', commonPointer));
    canvas.dispatchEvent(new MouseEvent('mouseup', commonMouse));
    canvas.dispatchEvent(new MouseEvent('click', commonMouse));
}

function isPixelProcessed(it) {
    if (!it) return true;
    const key = `${it.canvas.x},${it.canvas.y}`;
    return state.applied.set.has(key) || state.applied.pendingSet.has(key);
}

function paintCanvasOnce(canvas, it, lastColorRef) {
    if (lastColorRef.value !== it.colorId) {
        if (!selectColor(it.colorId)) {
            return false;
        }
        lastColorRef.value = it.colorId;
    }
    const key = `${it.canvas.x},${it.canvas.y}`;
    state.applied.pending.push({
        k: key,
        t: now(),
        it
    });
    state.applied.pendingSet.add(key);
    clickCanvasSynthetic(canvas, it.canvas.x, it.canvas.y);
    return true;
}
async function commitAndSync(reopenDelayMs) {
    const btn = qsa('button').find(b => /(Pintar|Paint)/i.test(b.textContent.trim()));
    if (btn) btn.click();
    await sleep(200);
    for (const p of state.applied.pending) state.applied.set.add(p.k);
    state.applied.pending.length = 0;
    state.applied.pendingSet.clear();
    saveSession('commit');
    updateProgress();
    await sleep(reopenDelayMs ?? REOPEN_DELAY_MS);
    const btn2 = qsa('button').find(b => /(Pintar|Paint)/i.test(b.textContent.trim()));
    if (btn2) btn2.click();
}

// ===== OBSERVERS =====
function startToastObserver() {
    try {
        if (state.toast.observer) return;
        const root = qs('[data-sonner-toaster="true"]') || document.body;
        const re = /Acabou a tinta|Out of paint|No more charges/i;
        state.toast.observer = new MutationObserver((muts) => {
            if (state.toast.handling || now() - state.toast.lastSeenAt < 2000) return;
            for (const m of muts) {
                for (const n of m.addedNodes) {
                    if (re.test(n.textContent || '')) {
                        state.toast.seenAt = now();
                        state.toast.lastSeenAt = state.toast.seenAt;
                        showToast(t('toastHit'), 'warn', 2500);
                        handleInkDepletedToast();
                        return;
                    }
                }
            }
        });
        state.toast.observer.observe(root, {
            subtree: true,
            childList: true
        });
    } catch (e) {
        log('Toast observer failed:', e);
    }
}

function stopToastObserver() {
    if (state.toast.observer) state.toast.observer.disconnect();
    state.toast.observer = null;
}

function startSupervisor() {
    stopSupervisor();
    const targetNode = document.body;
    const config = {
        childList: true,
        subtree: true
    };
    const callback = (mutationsList, observer) => {
        for (const mutation of mutationsList) {
            if (mutation.type === 'childList') {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === 1 && node.querySelector('label.cb-lb input[type="checkbox"]')) {
                        if (state.running && !state.captchaHold) {
                            log('Captcha detected! Pausing operations.');
                            state.captchaHold = true;
                            pausePainting();
                            setStatus(t('captchaDetected'), 'warn');
                            showToast(t('captchaDetected'), 'warn', 10000);
                        }
                    }
                }
                for (const node of mutation.removedNodes) {
                    if (node.nodeType === 1 && node.querySelector('label.cb-lb input[type="checkbox"]')) {
                        if (state.running && state.captchaHold) {
                            log('Captcha solved! Resuming operations.');
                            state.captchaHold = false;
                            setStatus(t('resumed'));
                            showToast(t('resumed'));
                            resumePainting();
                        }
                    }
                }
            }
        }
    };
    state.supervisor.observer = new MutationObserver(callback);
    state.supervisor.observer.observe(targetNode, config);
    log('Challenge Supervisor activated.');
}

function stopSupervisor() {
    if (state.supervisor.observer) {
        state.supervisor.observer.disconnect();
        state.supervisor.observer = null;
        log('Challenge Supervisor deactivated.');
    }
}
async function handleInkDepletedToast() {
    if (state.toast.handling) return;
    state.toast.handling = true;
    state.paused = true;
    updateButtons();
    const cutoff = state.toast.seenAt;
    const keep = [],
        rollback = [];
    for (const p of state.applied.pending) {
        if (p.t <= cutoff) keep.push(p);
        else rollback.push(p);
    }
    if (rollback.length) {
        state.queue.splice(state.queuePtr, 0, ...rollback.map(p => p.it));
        state.queuePtr -= rollback.length;
        for (const p of rollback) {
            state.applied.pendingSet.delete(p.k);
        }
    }
    state.applied.pending = keep;
    await commitAndSync(FULL_DEPLETION_REOPEN_MS);
    const total = Math.max(1, state.cooldownMin | 0) * 60 * 1000;
    for (let remain = total; remain > 0 && state.running && !state.stopFlag; remain -= 1000) {
        setStatus(t('coolingDown', {
            min: String(state.cooldownMin),
            mmss: mmss(remain)
        }));
        await sleep(1000);
    }
    if (state.running && !state.stopFlag) {
        resumePainting();
    }
    state.toast.handling = false;
}

// ===== RUNNER =====
function startUITicker() {
    stopUITicker();
    state.uiTicker = setInterval(() => {
        if (state.overlayCanvas && state.pos) placeOverlay();
    }, UI_TICK_MS);
}

function stopUITicker() {
    if (state.uiTicker) {
        clearInterval(state.uiTicker);
        state.uiTicker = null;
    }
}
async function startPainting() {
    if (state.loopActive) {
        showToast('Already running', 'warn');
        return;
    }
    if (!state.imgData) {
        setStatus(t('mustUpload'));
        showToast(t('mustUpload'), 'error');
        return;
    }
    if (!state.pos) {
        setStatus(t('mustPickPos'));
        showToast(t('mustPickPos'), 'error');
        return;
    }
    const canvas = getTargetCanvas();
    if (!canvas) {
        setStatus(t('noCanvas'));
        showToast(t('noCanvas'), 'error');
        return;
    }
    state.palette = extractPalette();
    if (!state.palette.length) {
        setStatus(t('openPalette'), 'error');
        showToast(t('openPalette'), 'error');
        return;
    }
    buildQueue();
    if (!state.queue.length) {
        setStatus(t('nothingToPaint'));
        showToast(t('nothingToPaint'), 'warn');
        return;
    }
    if (state.manualStart?.enabled) {
        const idx = Math.max(0, parseInt(state.manualStart.index, 10) || 0);
        if (idx > 0 && idx < state.queue.length) {
            state.queuePtr = idx;
        }
    }
    state.running = true;
    state.paused = false;
    state.stopFlag = false;
    state.loopActive = true;
    updateButtons();
    startUITicker();
    startToastObserver();
    startSupervisor();
    setStatus(t('started'));
    const lastColorRef = {
        value: -1
    };
    const interval = 1000 / clamp(state.cps, 1, 1000);
    mainLoop(lastColorRef, canvas, interval);
}
const mainLoop = (lastColorRef, canvas, interval) => {
    if (!state.running || state.stopFlag) {
        finishRun();
        return;
    }
    if (state.paused || state.captchaHold) {
        state.loopRequestId = requestAnimationFrame(() => mainLoop(lastColorRef, canvas, interval));
        return;
    }
    if (state.queuePtr >= state.queue.length) {
        if (state.applied.pending.length > 0) {
            setStatus(t('committing'));
            commitAndSync();
        }
        finishRun();
        return;
    }
    const it = state.queue[state.queuePtr];
    if (isPixelProcessed(it)) {
        state.queuePtr++;
        state.loopRequestId = requestAnimationFrame(() => mainLoop(lastColorRef, canvas, interval));
        return;
    }
    const elapsed = now() - state.lastPaintTs;
    if (elapsed >= interval) {
        state.lastPaintTs = now();
        const paintOk = paintCanvasOnce(canvas, it, lastColorRef);
        if (!paintOk) {
            const msg = t('colorMissing', {
                id: it.colorId
            });
            setStatus(msg, 'warn');
            showToast(msg, 'error');
            pausePainting();
        } else {
            updateProgress();
            state.sinceSave++;
            if (state.sinceSave >= AUTOSAVE_EVERY_N_PIXELS) {
                saveSession('silent');
                state.sinceSave = 0;
            }
        }
        state.queuePtr++;
    }
    state.loopRequestId = requestAnimationFrame(() => mainLoop(lastColorRef, canvas, interval));
};

function finishRun() {
    if (state.loopRequestId) {
        cancelAnimationFrame(state.loopRequestId);
        state.loopRequestId = null;
    }
    state.running = false;
    state.loopActive = false;
    state.committing = false;
    stopUITicker();
    stopToastObserver();
    stopSupervisor();
    updateButtons();
    saveSession('finish');
    setStatus(state.stopFlag ? t('stopped') : t('done'));
    setProgressText(t('done'));
}

function pausePainting() {
    if (!state.running || state.paused) return;
    state.paused = true;
    updateButtons();
    saveSession('pause');
    setStatus(t('paused'));
}

function resumePainting() {
    if (!state.running || !state.paused || state.captchaHold) return;
    if (!getTargetCanvas()) {
        const msg = t('noCanvas');
        showToast(msg, 'error');
        setStatus(msg, 'error');
        stopPainting();
        return;
    }
    state.palette = extractPalette();
    if (!state.palette.length) {
        const msg = t('openPalette');
        showToast(msg, 'error');
        setStatus(msg, 'error');
        return;
    }
    state.paused = false;
    updateButtons();
    setStatus(t('resumed'));
}

function stopPainting() {
    state.stopFlag = true;
    state.running = false;
    state.loopActive = false;
    if (state.loopRequestId) {
        cancelAnimationFrame(state.loopRequestId);
        state.loopRequestId = null;
    }
    stopUITicker();
    stopToastObserver();
    stopSupervisor();
    state.queue.length = 0;
    state.queuePtr = 0;
    state.totalTarget = 0;
    state.applied.set.clear();
    state.applied.pending.length = 0;
    state.applied.pendingSet.clear();
    try {
        localStorage.removeItem(sessKey());
    } catch {}
    updateButtons();
    setStatus(t('stopped'));
    setProgressText('—');
    updateProgress();
}

// ===== BOOT =====
function init() {
    addGlobalStyles();
    buildUI();
    setStatus(t('needImgPos'));
    startUITicker();
    if (hasSession()) {
        loadSession();
    }
}

function addGlobalStyles() {
    const s = document.createElement('style');
    s.textContent = `:root { --neon1: ${THEME.neon1}; --neon2: ${THEME.neon2}; --good: ${THEME.good}; --warn: ${THEME.warn}; --bad: ${THEME.bad}; } #fxbot-ui { position:fixed; bottom:20px; right:20px; z-index:999999; width:min(90vw,380px); background:${THEME.panel}; color:${THEME.text}; border:1px solid ${THEME.border}; border-radius:12px; font-family: 'Segoe UI', 'Roboto', sans-serif; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); box-shadow: 0 10px 30px rgba(0,0,0,0.5), 0 0 20px ${THEME.neon1}33; } #fx-drag-handle { display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:rgba(0,0,0,0.2); border-bottom:1px solid ${THEME.border}; cursor:move; } .title-gradient { font-weight:700; background:linear-gradient(90deg, var(--neon1), var(--neon2)); -webkit-background-clip:text; -webkit-text-fill-color:transparent; } .header-controls { display:flex; align-items:center; gap:6px; } #fx-body { display:flex; flex-direction:column; padding:10px; gap:8px; } .fx-tabs { display:flex; background:rgba(0,0,0,0.2); border-radius:8px; padding:4px; } .fx-tab-btn { flex:1; padding:6px; background:transparent; border:none; color:${THEME.subtle}; cursor:pointer; border-radius:6px; font-weight:600; transition:all 0.2s; } .fx-tab-btn.active { background:var(--neon1); color:${THEME.bg}; box-shadow:0 0 10px var(--neon1); } .fx-tab-content { display:none; flex-direction:column; gap:8px; } .fx-tab-content.active { display:flex; } #fx-status { font-size:12px; text-align:center; color:${THEME.subtle}; padding:4px 0; min-height: 1em; transition: color 0.3s; } #fx-status.status-warn { color: var(--warn); font-weight: 600; } #fx-status.status-error { color: var(--bad); font-weight: 600; } #fx-img-status { font-weight: 600; color: ${THEME.text}; } .progress-bar-container { width:100%; background:rgba(0,0,0,0.3); border-radius:99px; padding:3px; } #fx-progress-bar { height:10px; background:linear-gradient(90deg, var(--neon1), var(--neon2)); border-radius:99px; width:0%; transition:width 0.3s; } #fx-progress-text { font-size:12px; text-align:center; color:${THEME.subtle}; } .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:8px; } .icon-toolbar { display:grid; grid-template-columns: repeat(3, 1fr); gap:8px; } .adv-group { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; } .checkbox-label { flex-direction: row; align-items: center; justify-content: space-between; padding: 4px 0; } .fx-btn { background:rgba(255,255,255,0.05); border:1px solid ${THEME.border}; color:${THEME.text}; padding:8px; border-radius:8px; cursor:pointer; font-weight:600; text-align: center; transition:all 0.2s ease; } .fx-btn:hover:not(:disabled) { background:var(--neon1); color:${THEME.bg}; border-color:var(--neon1); box-shadow:0 0 10px var(--neon1); transform: translateY(-1px); } .fx-btn:disabled { opacity:0.4; cursor:not-allowed; } .fx-btn.primary { border-color: var(--neon1); color: var(--neon1); } .fx-btn.success { border-color: var(--good); color: var(--good); } .fx-btn.warn { border-color: var(--warn); color: var(--warn); } .fx-btn.danger { border-color: var(--bad); color: var(--bad); } .fx-btn.icon { padding: 6px 10px; font-size: 14px; } .fx-btn.icon-btn { font-size: 20px; padding: 8px; } #fxbot-ui label { display:flex; flex-direction:column; gap:4px; font-size:11px; color:${THEME.subtle}; } #fxbot-ui input, #fxbot-ui select { width:100%; background:rgba(0,0,0,0.3); border:1px solid ${THEME.border}; color:${THEME.text}; border-radius:6px; padding:6px; outline:none; box-sizing:border-box; } #fxbot-ui input:focus, #fxbot-ui select:focus { border-color: var(--neon1); box-shadow: 0 0 5px var(--neon1) inset; } #fxbot-ui input[type="checkbox"] { width: auto; } #fx-overlay { position:fixed; pointer-events:none; opacity:0.6; z-index:999998; image-rendering: pixelated; image-rendering: -moz-crisp-edges; } #fx-toast-container { position:fixed; top:20px; left:50%; transform:translateX(-50%); z-index:1000000; display:flex; flex-direction:column; gap:8px; align-items:center; } .fx-toast { padding:10px 20px; border-radius:8px; color:#fff; font-weight:bold; background:rgba(20,20,30,0.9); border:1px solid var(--neon1); box-shadow:0 0 12px var(--neon1); transition: opacity 0.5s; } .fx-toast.fx-toast-warn { border-color:var(--warn); box-shadow:0 0 12px var(--warn); } .fx-toast.fx-toast-error { border-color:var(--bad); box-shadow:0 0 12px var(--bad); } .fx-toast-fade { opacity:0; }`;
    document.head.appendChild(s);
}

init();

})();
