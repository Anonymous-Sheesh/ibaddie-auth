// ══════════════════════════════════════════════════════════════════════════════
// IBADDIE — BUYER CODE REQUEST PAGE (request.js v6.0)
// ══════════════════════════════════════════════════════════════════════════════
// v5.1 HOTFIX: this page is hosted on GitHub Pages but the backend is a
// Cloudflare Worker — all API calls now go to the Worker's own address
// (WORKER_URL) instead of relative "/api/..." paths that hit github.io (404).
// Flow: Request Code → upload screenshot → "checking" → admin review → code.
// Every upload is normalized through a canvas before sending.
// The Worker hashes the received image bytes, independent of its filename.
// If this token sent the same image before (even renamed),
// the request is held in "checking" for 5 seconds and then auto-rejected with
// OLD SCREENSHOT DETECTED. This page simply polls status and shows the result.
(() => {
    'use strict';

    const $ = id => document.getElementById(id);
    const IMG_RE = /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i;
    const POLL_MS = 2000;

    // Send credentials only to the configured backend, never a URL override.
    const WORKER_URL = 'https://totp-backend.ibaddie.workers.dev';
    try { localStorage.removeItem('ib_worker_url'); } catch {}


    const state = {
        token: null,
        requestId: null,
        freshMode: false,   // admin asked for a fresh screenshot → next upload goes to /fresh
        polling: null,
        countdown: null,
        presenceTimer: null,
        submitAt: 0,
        waiting: false,
        busy: false,
        processing: false,
        pollBusy: false,
        generation: 0,
        lastCode: null
    };

    // ─── SOUND (Web Audio — no files, unlocked by real clicks) ──────────────────
    const Sound = (() => {
        let ctx = null;
        function ensure() {
            try {
                if (!ctx) {
                    const AC = window.AudioContext || window.webkitAudioContext;
                    if (!AC) return null;
                    ctx = new AC();
                }
                if (ctx.state === 'suspended') ctx.resume().catch(() => {});
                return ctx;
            } catch (e) { return null; }
        }
        function tone(freq, at, dur, type, vol) {
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.type = type || 'sine';
            o.frequency.value = freq;
            g.gain.setValueAtTime(0.0001, at);
            g.gain.exponentialRampToValueAtTime(vol || 0.16, at + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
            o.connect(g); g.connect(ctx.destination);
            o.start(at); o.stop(at + dur + 0.05);
        }
        async function chime() {
            await unlock();
            const c = ensure(); if (!c || c.state !== 'running') return false;
            const t = c.currentTime + 0.02;
            tone(880, t, 0.18); tone(1174.66, t + 0.13, 0.20); tone(1567.98, t + 0.27, 0.35);
            return true;
        }
        function buzz() {
            const c = ensure(); if (!c || c.state !== 'running') return false;
            const t = c.currentTime + 0.02;
            tone(196, t, 0.28, 'square', 0.07); tone(147, t + 0.22, 0.40, 'square', 0.07);
            return true;
        }
        async function unlock() {
            const c = ensure(); if (!c) return false;
            try {
                const b = c.createBuffer(1, 1, 22050);
                const s = c.createBufferSource(); s.buffer = b; s.connect(c.destination); s.start(0);
            } catch (e) {}
            let timer;
            try {
                await Promise.race([c.resume(), new Promise(resolve => { timer = setTimeout(resolve, 1500); })]);
                return c.state === 'running';
            } catch { return false; }
            finally { clearTimeout(timer); }
        }
        return { chime, buzz, unlock };
    })();

    // ─── UI HELPERS ──────────────────────────────────────────────────────────────
    const showBox = el => { if (el) el.style.display = 'block'; };
    const showEl  = el => { if (el) el.style.display = ''; };
    const hide    = el => { if (el) el.style.display = 'none'; };

    function resetUI() {
        state.generation++;
        document.querySelector('.req-card').classList.remove('rejection-mode');
        state.requestId = null;
        state.freshMode = false;
        state.waiting = false;
        state.busy = false;
        if (state.polling) { clearInterval(state.polling); state.polling = null; }
        if (state.countdown) { clearInterval(state.countdown); state.countdown = null; }
        hide($('uploadArea')); hide($('waitArea')); hide($('codeBox')); hide($('rejectBox'));
        const rb = $('reqBtn');
        rb.disabled = !state.token;
        if (state.token) rb.textContent = '📸 Request Code';
        showEl(rb);
        $('fileInput').value = '';
    }

    function startWait(text) {
        state.waiting = true;
        hide($('reqBtn'));
        hide($('uploadArea')); hide($('codeBox')); hide($('rejectBox'));
        $('waitText').textContent = text || 'Waiting for Ibaddie to review...';
        showBox($('waitArea'));
    }

    function showReject(reason, shot) {
        hide($('reqBtn'));
        document.querySelector('.req-card').classList.add('rejection-mode');
        state.waiting = false;
        if (state.polling) { clearInterval(state.polling); state.polling = null; }
        hide($('waitArea')); hide($('uploadArea')); hide($('codeBox'));
        $('rejectReason').textContent = reason || 'Screenshot rejected.';
        const img = $('rejectedScreenshot'), missing = $('missingRejectedScreenshot');
        if (shot && IMG_RE.test(shot)) {
            img.src = shot;
            img.style.display = '';
            missing.style.display = 'none';
        } else {
            img.removeAttribute('src');
            img.style.display = 'none';
            missing.style.display = 'block';
        }
        showBox($('rejectBox'));
        Sound.buzz();
    }

    function showCode(code, secs) {
        if (secs <= 0) { resetUI(); return; }
        hide($('reqBtn'));
        state.waiting = false;
        if (state.polling) { clearInterval(state.polling); state.polling = null; }
        hide($('waitArea')); hide($('uploadArea')); hide($('rejectBox'));
        $('codeNum').textContent = code;
        showBox($('codeBox'));
        const delivery = state.requestId + ':' + code;
        if (state.lastCode !== delivery) { Sound.chime(); state.lastCode = delivery; }
        const expiresAt = Date.now() + Math.max(0, secs) * 1000;
        let left = Math.max(1, secs || 30);
        const render = () => { $('codeTimer').textContent = left > 0 ? 'Expires in ' + left + 's' : 'Expired — request again'; };
        render();
        if (state.countdown) clearInterval(state.countdown);
        state.countdown = setInterval(() => {
            left = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
            if (left <= 0) { clearInterval(state.countdown); state.countdown = null; resetUI(); return; }
            render();
        }, 1000);
    }

    // ─── PRESENCE ────────────────────────────────────────────────────────────────
    function refreshPresence() {
        $('badge').className = 'badge badge-on';
        $('badgeText').textContent = 'Ibaddie is online';
        $('badge').style.display = 'inline-flex';
    }

    // ─── IMAGE NORMALIZATION (browser-side, deterministic) ──────────────────────
    // The SAME pixels always produce the SAME strings in the same browser, so
    // renamed or metadata-resaved copies collapse to identical fingerprints.
    async function loadBitmap(file) {
        if (window.createImageBitmap) {
            try { return await createImageBitmap(file); } catch (e) {}
        }
        const url = URL.createObjectURL(file);
        try {
            return await new Promise((res, rej) => {
                const i = new Image();
                i.onload = () => res(i);
                i.onerror = () => rej(new Error('Could not read that image.'));
                i.src = url;
            });
        } finally {
            setTimeout(() => URL.revokeObjectURL(url), 5000);
        }
    }

    async function processFile(file) {
        if (!file || !file.type || !file.type.startsWith('image/')) throw new Error('Please upload an image file (PNG or JPG screenshot).');
        if (file.size > 20 * 1024 * 1024) throw new Error('That image is too large (max 20 MB).');
        const bmp = await loadBitmap(file);
        const w0 = bmp.width || bmp.naturalWidth, h0 = bmp.height || bmp.naturalHeight;
        if (!w0 || !h0) throw new Error('Could not read that image.');
        const MAX = 1600;
        const scale = Math.min(1, MAX / Math.max(w0, h0));
        const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(bmp, 0, 0, w, h);
        const screenshot = c.toDataURL('image/jpeg', 0.85);
        if (bmp.close) bmp.close();
        return { screenshot };
    }

    // ─── SUBMIT + POLL ───────────────────────────────────────────────────────────
    async function submitShot(payload) {
        if (state.busy) return;
        state.busy = true;
        startWait(state.freshMode ? 'Uploading your new screenshot...' : 'Verifying your screenshot...');
        state.submitAt = Date.now();
        try {
            const endpoint = WORKER_URL + (state.freshMode ? '/api/code-request/fresh' : '/api/code-request');
            const r = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(Object.assign({ token: state.token }, payload))
            });
            let d = {};
            try { d = await r.json(); } catch (e) {}
            if (!r.ok) throw new Error(d.error || 'Upload failed — check your connection and try again.');
            if (d.requestId) state.requestId = d.requestId;
            if (state.freshMode) { state.freshMode = false; startWait('Waiting for Ibaddie to review...'); }
            startPolling();
        } catch (e) {
            state.waiting = true;
            $('waitText').textContent = (e.message || 'Something went wrong.') + ' — press Cancel to go back.';
        } finally {
            state.busy = false;
        }
    }

    function startPolling() {
        if (state.polling) clearInterval(state.polling);
        state.polling = setInterval(pollOnce, POLL_MS);
        pollOnce();
    }

    async function pollOnce() {
        if (!state.token || state.pollBusy) return;
        state.pollBusy = true;
        const generation = state.generation;
        let d;
        try {
            const r = await fetch(WORKER_URL + '/api/code-request/status?token=' + encodeURIComponent(state.token), { cache: 'no-store' });
            d = await r.json();
        } catch (e) {
            $('waitText').textContent = 'Reconnecting...';
            return;
        } finally { state.pollBusy = false; }
        if (generation === state.generation) handleStatus(d);
    }

    function handleStatus(d) {
        if (!d || !d.status) return;
        if (d.requestId) state.requestId = d.requestId;
        switch (d.status) {
            case 'checking':
                startWait('Checking screenshot…');
                break;
            case 'pending':
                $('waitText').textContent = 'Waiting for Ibaddie to review...';
                break;
            case 'request_fresh':
                if (!state.freshMode) {
                    hide($('reqBtn'));
                    $('fileInput').value = '';
                    state.freshMode = true;
                    state.waiting = false;
                    if (state.polling) { clearInterval(state.polling); state.polling = null; }
                    $('waitText').textContent = 'Ibaddie asked for a NEW screenshot — pick a fresh one below.';
                    showBox($('waitArea'));
                    showBox($('uploadArea'));
                    Sound.buzz();
                }
                break;
            case 'approved_pending':
                $('waitText').textContent = 'Ibaddie approved — your code unlocks in ' + (d.waitSeconds || 1) + 's...';
                break;
            case 'approved':
                if (d.code) showCode(d.code, d.codeExpiresIn ?? 0);
                break;
            case 'expired':
                resetUI();
                break;
            case 'rejected': {
                const reason = d.rejectionReason || 'Screenshot rejected.';
                // The Worker already holds duplicates for 5s; keep the visible wait
                // at 5s minimum even if clocks drift slightly.
                showReject(reason, d.submittedScreenshot);
                break;
            }
            case 'none':
                if (state.waiting || state.freshMode) resetUI();
                break;
        }
    }

    async function withdraw() {
        if (!state.token) return;
        try {
            await fetch(WORKER_URL + '/api/code-request/withdraw', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: state.token })
            });
        } catch (e) {}
    }
    window.cancelRequest = async () => { if (state.busy || state.processing) return; state.generation++; await withdraw(); resetUI(); };

    // ─── RESUME AFTER RELOAD ─────────────────────────────────────────────────────
    async function resumeIfNeeded() {
        if (!state.token) return;
        try {
            const r = await fetch(WORKER_URL + '/api/code-request/status?token=' + encodeURIComponent(state.token), { cache: 'no-store' });
            const d = await r.json();
            if (!d || !d.status || d.status === 'none' || d.status === 'expired') return;
            if (d.status === 'rejected') { handleStatus(d); return; }
            if (d.status === 'approved') { if (d.code) showCode(d.code, d.codeExpiresIn ?? 0); return; }
            if (d.status === 'request_fresh') { handleStatus(d); return; }
            state.requestId = d.requestId || null;
            state.submitAt = Date.now() - 10000; // old request — never re-gate the 5s window
            startWait(d.status === 'checking' ? 'Verifying your screenshot...' : 'Waiting for Ibaddie to review...');
            startPolling();
        } catch (e) {}
    }

    // ─── TOKEN + INIT ────────────────────────────────────────────────────────────
    function extractToken() {
        const q = new URLSearchParams(location.search);
        let t = q.get('t') || q.get('token') || q.get('tid');
        if (!t && location.hash) {
            const h = new URLSearchParams(location.hash.replace(/^#/, ''));
            t = h.get('t') || h.get('token');
        }
        if (t) { try { sessionStorage.setItem('ib_token', t); } catch (e) {} return t; }
        try { t = sessionStorage.getItem('ib_token'); } catch (e) {}
        return t || null;
    }

    function init() {
        state.token = extractToken();
        const reqBtn = $('reqBtn'), upload = $('uploadArea'), input = $('fileInput');

        if (!state.token) {
            reqBtn.disabled = true;
            reqBtn.textContent = '🔗 Invalid link — ask Ibaddie for yours';
        }

        reqBtn.addEventListener('click', () => {
            if (!state.token) return;
            Sound.unlock(); // inside a real click → browser allows audio later
            hide(reqBtn);
            showBox(upload);
        });

        upload.addEventListener('click', event => { if (event.target !== input && !state.busy) { Sound.unlock(); input.click(); } });

        input.addEventListener('change', async () => {
            if (state.busy || state.processing) return;
            Sound.unlock();
            const file = input.files && input.files[0];
            if (!file) return;
            state.processing = true;
            startWait('Preparing screenshot…');
            try {
                const payload = await processFile(file);
                await submitShot(payload);
            } catch (e) {
                input.value = '';
                startWait((e.message || 'Upload failed.') + ' — press Cancel to go back.');
            } finally { state.processing = false; input.value = ''; }
        });

        $('tryAgainBtn').addEventListener('click', () => {
            // A resolved rejection can be replaced directly; no racing withdraw.
            resetUI();
            hide(reqBtn);
            showBox(upload);
            input.click();
        });

        $('codeNum').addEventListener('click', () => {
            const code = $('codeNum').textContent.trim();
            if (!/^\d{6}$/.test(code)) return;
            const hint = $('codeHint');
            const old = hint.textContent;
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(code).then(() => {
                    hint.textContent = '✅ Copied! Paste it into the launcher NOW.';
                    setTimeout(() => { hint.textContent = old; }, 2500);
                }).catch(() => {});
            }
        });

        $('buyerSoundBtn').addEventListener('click', () => {
            Sound.unlock();
            try { localStorage.setItem('ib_buyer_sound', '1'); } catch (e) {}
            setTimeout(async () => {
                const ok = await Sound.chime();
                $('buyerSoundStatus').textContent = ok
                    ? 'Sound is ON — you will hear this when your code arrives.'
                    : 'Your browser blocked audio — tap the button once more, or raise the volume.';
            }, 80);
        });

        refreshPresence();
        // The requested badge is always online; no presence polling.
        resetUI();
        resumeIfNeeded();
    }

    init();
})();
