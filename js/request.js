// ══════════════════════════════════════════════════════════════════════════════
// IBADDIE — BUYER CODE REQUEST PAGE (request.js v5.0)
// ══════════════════════════════════════════════════════════════════════════════
// Flow: Request Code → upload screenshot → "checking" → admin review → code.
// Every upload is normalized through a canvas before sending, and a tiny
// thumbnail "fingerprint" is sent alongside it. The Worker hashes BOTH
// server-side: if this buyer ever sent the same image before (even renamed),
// the request is held in "checking" for 5 seconds and then auto-rejected with
// OLD SCREENSHOT DETECTED. This page simply polls status and shows the result.
(() => {
    'use strict';

    const $ = id => document.getElementById(id);
    const IMG_RE = /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i;
    const MIN_DUPLICATE_WAIT_MS = 5000; // keep the visible "checking" wait at 5s minimum
    const POLL_MS = 2000;

    const state = {
        token: null,
        requestId: null,
        freshMode: false,   // admin asked for a fresh screenshot → next upload goes to /fresh
        polling: null,
        countdown: null,
        presenceTimer: null,
        submitAt: 0,
        waiting: false,
        busy: false
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
        function chime() {
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
        function unlock() {
            const c = ensure(); if (!c) return false;
            try {
                const b = c.createBuffer(1, 1, 22050);
                const s = c.createBufferSource(); s.buffer = b; s.connect(c.destination); s.start(0);
            } catch (e) {}
            if (c.state === 'suspended') c.resume().catch(() => {});
            return true;
        }
        return { chime, buzz, unlock };
    })();

    // ─── UI HELPERS ──────────────────────────────────────────────────────────────
    const showBox = el => { if (el) el.style.display = 'block'; };
    const showEl  = el => { if (el) el.style.display = ''; };
    const hide    = el => { if (el) el.style.display = 'none'; };

    function resetUI() {
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
        hide($('uploadArea')); hide($('codeBox')); hide($('rejectBox'));
        $('waitText').textContent = text || 'Waiting for Ibaddie to review...';
        showBox($('waitArea'));
    }

    function showReject(reason, shot) {
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
        state.waiting = false;
        if (state.polling) { clearInterval(state.polling); state.polling = null; }
        hide($('waitArea')); hide($('uploadArea')); hide($('rejectBox'));
        $('codeNum').textContent = code;
        showBox($('codeBox'));
        Sound.chime();
        let left = Math.max(1, secs || 30);
        const render = () => { $('codeTimer').textContent = left > 0 ? 'Expires in ' + left + 's' : 'Expired — request again'; };
        render();
        if (state.countdown) clearInterval(state.countdown);
        state.countdown = setInterval(() => {
            left--;
            if (left <= 0) { clearInterval(state.countdown); state.countdown = null; resetUI(); return; }
            render();
        }, 1000);
    }

    // ─── PRESENCE ────────────────────────────────────────────────────────────────
    async function refreshPresence() {
        try {
            const r = await fetch('/api/presence', { cache: 'no-store' });
            const d = await r.json();
            const badge = $('badge'), txt = $('badgeText');
            if (d && d.online) { badge.className = 'badge badge-on'; txt.textContent = 'Ibaddie is online'; }
            else { badge.className = 'badge badge-off'; txt.textContent = 'Ibaddie is offline'; }
            badge.style.display = 'inline-flex';
        } catch (e) {}
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
        const fw = 256, fh = Math.max(1, Math.round((h / w) * 256) || 1);
        const c2 = document.createElement('canvas'); c2.width = fw; c2.height = fh;
        c2.getContext('2d').drawImage(bmp, 0, 0, fw, fh);
        const fingerprint = c2.toDataURL('image/jpeg', 0.7);
        if (bmp.close) bmp.close();
        return { screenshot, fingerprint };
    }

    // ─── SUBMIT + POLL ───────────────────────────────────────────────────────────
    async function submitShot(payload) {
        if (state.busy) return;
        state.busy = true;
        startWait(state.freshMode ? 'Uploading your new screenshot...' : 'Verifying your screenshot...');
        state.submitAt = Date.now();
        try {
            const endpoint = state.freshMode ? '/api/code-request/fresh' : '/api/code-request';
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
        if (!state.token) return;
        let d;
        try {
            const r = await fetch('/api/code-request/status?token=' + encodeURIComponent(state.token), { cache: 'no-store' });
            d = await r.json();
        } catch (e) {
            $('waitText').textContent = 'Reconnecting...';
            return;
        }
        handleStatus(d);
    }

    function handleStatus(d) {
        if (!d || !d.status) return;
        switch (d.status) {
            case 'checking':
                $('waitText').textContent = 'Verifying your screenshot...';
                break;
            case 'pending':
                $('waitText').textContent = 'Waiting for Ibaddie to review...';
                break;
            case 'request_fresh':
                if (!state.freshMode) {
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
                if (d.code) showCode(d.code, d.codeExpiresIn || 30);
                break;
            case 'expired':
                resetUI();
                break;
            case 'rejected': {
                const reason = d.rejectionReason || 'Screenshot rejected.';
                // The Worker already holds duplicates for 5s; keep the visible wait
                // at 5s minimum even if clocks drift slightly.
                const remain = MIN_DUPLICATE_WAIT_MS - (Date.now() - state.submitAt);
                if (remain > 0 && /OLD SCREENSHOT/i.test(reason)) {
                    $('waitText').textContent = 'Verifying your screenshot...';
                    setTimeout(() => showReject(reason, d.submittedScreenshot), remain);
                } else {
                    showReject(reason, d.submittedScreenshot);
                }
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
            await fetch('/api/code-request/withdraw', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: state.token })
            });
        } catch (e) {}
    }
    window.cancelRequest = async () => { await withdraw(); resetUI(); };

    // ─── RESUME AFTER RELOAD ─────────────────────────────────────────────────────
    async function resumeIfNeeded() {
        if (!state.token) return;
        try {
            const r = await fetch('/api/code-request/status?token=' + encodeURIComponent(state.token), { cache: 'no-store' });
            const d = await r.json();
            if (!d || !d.status || d.status === 'none' || d.status === 'rejected' || d.status === 'expired') return;
            if (d.status === 'approved') { if (d.code) showCode(d.code, d.codeExpiresIn || 30); return; }
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

        upload.addEventListener('click', () => { if (!state.busy) input.click(); });

        input.addEventListener('change', async () => {
            const file = input.files && input.files[0];
            if (!file) return;
            try {
                const payload = await processFile(file);
                await submitShot(payload);
            } catch (e) {
                input.value = '';
                startWait((e.message || 'Upload failed.') + ' — press Cancel to go back.');
            }
        });

        $('tryAgainBtn').addEventListener('click', () => {
            withdraw(); // fire & forget — must not delay the file picker gesture
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
            setTimeout(() => {
                const ok = Sound.chime();
                $('buyerSoundStatus').textContent = ok
                    ? 'Sound is ON — you will hear this when your code arrives.'
                    : 'Your browser blocked audio — tap the button once more, or raise the volume.';
            }, 80);
        });

        refreshPresence();
        state.presenceTimer = setInterval(refreshPresence, 10000);
        resetUI();
        resumeIfNeeded();
    }

    init();
})();
