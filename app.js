/* Keells Bill Reader: the page.
 * Desktop browsers watch the screen live (getDisplayMedia). Phones can't share other apps' screens with a
 * website, so there the bill is read from a screen recording or screenshots. Either way every picture is
 * read here, in this browser, by Tesseract OCR; bills are kept in this browser's storage.
 */
(() => {
  'use strict';
  const KB = window.KeellsBill;
  const $ = s => document.querySelector(s);
  const STORE_KEY = 'keells-bill-reader/bills';

  // --- what this device can do --------------------------------------------------------------------
  const ua = navigator.userAgent;
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  const isApple = /iPhone|iPad|iPod/i.test(ua) || iPadOS;
  const isMobile = (navigator.userAgentData && navigator.userAgentData.mobile) || /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || iPadOS;
  // Android browsers define getDisplayMedia but it always fails there, so phones and tablets use recordings.
  const canLive = !isMobile && !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

  // --- small helpers -------------------------------------------------------------------------------
  const money = KB.money;
  const esc = s => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function status(msg, level = 'info') {
    const el = $('#status');
    el.textContent = msg || '';
    el.className = `status ${level}`;
  }

  let toastTimer = 0;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
  }

  function chime() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [880, 1320].forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.15);
        g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + i * 0.15 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.15 + 0.35);
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + i * 0.15);
        o.stop(ctx.currentTime + i * 0.15 + 0.4);
      });
      setTimeout(() => ctx.close(), 1000);
    } catch (e) { /* no sound */ }
  }

  function notify(title, body) {
    if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
    try { new Notification(title, { body, icon: 'icons/icon-192.png', tag: 'keells-bill' }); } catch (e) { /* not allowed here */ }
  }

  // --- OCR: Tesseract.js, with all its files served from this site ---------------------------------------
  const ocr = {
    worker: null,
    starting: null,
    // Tesseract.js never settles createWorker when its cached language data turns out to be bad (it deletes
    // the cache and reports through errorHandler), so that is watched for and the start is tried once more.
    create(cacheMethod) {
      const at = p => new URL(p, location.href).href;
      let fail, timer;
      const failed = new Promise((_, reject) => { fail = reject; });
      timer = setTimeout(() => fail(new Error('timed out')), 120000);
      const made = Tesseract.createWorker('eng', 1, {
        workerPath: at('vendor/tesseract/worker.min.js'),
        corePath: at('vendor/tesseract/core'),
        langPath: at('vendor/tesseract/lang'),
        workerBlobURL: false,
        cacheMethod,
        errorHandler: e => fail(new Error(String(e))),
        logger: m => {
          if (m.status && /loading|initializ/.test(m.status) && m.progress < 1) {
            $('#engine').textContent = `Getting the reader ready (first time only)... ${Math.round(m.progress * 100)}%`;
          }
        },
      });
      return Promise.race([made, failed])
        .catch(e => { made.then(w => w.terminate(), () => {}); throw e; })
        .finally(() => clearTimeout(timer));
    },
    start() {
      if (!this.starting) {
        this.starting = (async () => {
          $('#engine').textContent = 'Getting the reader ready...';
          let w;
          try { w = await this.create('write'); }
          catch (e) { w = await this.create('refresh'); }
          await w.setParameters({ tessedit_pageseg_mode: '6' });     // one block of rows: keeps the line numbers
          this.worker = w;
          $('#engine').textContent = '';
          return w;
        })().catch(e => {
          this.starting = null;
          $('#engine').textContent = '';
          throw new Error(`The reader couldn't start (${e && e.message ? e.message : e}). Check the connection and try again.`);
        });
      }
      return this.starting;
    },
    async words(canvas) {
      const w = await this.start();
      const { data } = await w.recognize(canvas, {}, { blocks: true, text: false });
      return KB.wordsFromTesseract(data);
    },
  };

  // --- pictures ---------------------------------------------------------------------------------------
  const frame = document.createElement('canvas');            // the whole picture as captured
  const work = document.createElement('canvas');             // the part that is read, enlarged
  const tiny = document.createElement('canvas');
  tiny.width = 40; tiny.height = 80;
  const tinyCtx = tiny.getContext('2d', { willReadFrequently: true });

  function drawFrame(src, w, h) {
    if (frame.width !== w || frame.height !== h) { frame.width = w; frame.height = h; }
    frame.getContext('2d').drawImage(src, 0, 0, w, h);
  }

  // A 40x80 grey thumbnail, to see whether the picture changed or is still moving.
  function thumb(a) {
    tinyCtx.drawImage(frame, a.x, a.y, a.w, a.h, 0, 0, 40, 80);
    const d = tinyCtx.getImageData(0, 0, 40, 80).data;
    const g = new Float32Array(3200);
    let max = 0;
    for (let i = 0; i < 3200; i++) { g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114; if (g[i] > max) max = g[i]; }
    g.blank = max < 24;
    return g;
  }
  const thumbDiff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };

  // Enlarge or shrink so the bill is about 1100 px wide: OCR misses thin characters ("1", decimal
  // points) in small text, and a full-size phone recording only makes it slower.
  function prepare(a, factor) {
    let s = factor;
    if (a.h > a.w * 1.3) s *= Math.min(3, Math.max(0.5, 1100 / a.w));      // a phone screen
    else if (a.w < 1000) s *= Math.min(3, Math.max(2, 1050 / a.w));
    s = Math.min(s, 4800 / Math.max(a.w, a.h));
    work.width = Math.round(a.w * s);
    work.height = Math.round(a.h * s);
    const ctx = work.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(frame, a.x, a.y, a.w, a.h, 0, 0, work.width, work.height);
    return s;
  }

  // --- reading frames -------------------------------------------------------------------------------------
  let session = null;          // KB.BillSession for the current run (live, or a set of files)
  let reader = null;

  const area = { manual: null, auto: null };                  // where the bill is in a whole-screen picture

  // Decides which pictures to read: a new picture once it stops moving (or every couple of seconds while
  // it keeps moving), and a still, unfinished bill again at other sizes.
  class FrameReader {
    constructor(sess, forceAfter) {
      Object.assign(this, { sess, forceAfter, prev: null, lastRead: null, lastReadT: -1e9, rereads: 0, t: 0, noBill: 0 });
    }

    async offer(w, h, t) {
      this.t = t;
      const a = area.manual || area.auto || { x: 0, y: 0, w, h };
      const th = thumb(a);
      if (th.blank) return 'blank';
      const moving = this.prev && thumbDiff(th, this.prev) > 1;
      this.prev = th;
      const changed = !this.lastRead || thumbDiff(th, this.lastRead) > 1;
      const s = this.sess;
      let factor = null;
      if (changed && (!moving || t - this.lastReadT > this.forceAfter)) { factor = 1; this.rereads = 0; }
      else if (!changed && s.lastWasBill && s.cur && !s.cur.done && this.rereads < 2 && t - this.lastReadT > 1.5) {
        this.rereads++;
        factor = [1.25, 0.8][this.rereads - 1];
      }
      if (factor !== null) {
        this.lastRead = th;
        this.lastReadT = t;
        const scale = prepare(a, factor);
        const f = KB.readFrame(await ocr.words(work));
        this.learnArea(f, a, scale, w, h);
        s.frame(f);
      } else if (!changed) s.still();
      s.tick();
      return factor !== null ? 'read' : 'skip';
    }

    // On a wide picture (a whole screen) the phone is a small part: once a bill is found, read just that part.
    learnArea(f, a, scale, w, h) {
      if (area.manual) return;
      if (f.IsBill && f.Area && w > h && w >= 1000) {
        this.noBill = 0;
        const x0 = a.x + f.Area[0] / scale, x1 = a.x + f.Area[1] / scale;
        const pad = Math.max(80, (x1 - x0) * 0.3);
        let nx0 = Math.max(0, x0 - pad), nx1 = Math.min(w, x1 + pad);
        if (area.auto) { nx0 = Math.min(nx0, area.auto.x); nx1 = Math.max(nx1, area.auto.x + area.auto.w); }
        if (nx1 - nx0 < w * 0.8) { area.auto = { x: Math.round(nx0), y: 0, w: Math.round(nx1 - nx0), h }; showArea(); }
      } else if (!f.IsBill && area.auto && ++this.noBill >= 4) {
        area.auto = null;
        this.noBill = 0;
        showArea();
      }
    }
  }

  function newSession(clock) {
    return new KB.BillSession({
      now: clock,
      onProgress: showProgress,
      onBill: gotBill,
      onNote: (msg, level) => status(msg, level),
    });
  }

  // --- live: watching the screen ---------------------------------------------------------------------
  const live = { stream: null, track: null, capture: null, latest: null, waiters: [], ticker: null, busy: false, video: $('#liveVideo') };

  // Timers in a background tab slow down; a worker's don't, so the worker sets the pace.
  function startTicker(ms, fn) {
    try {
      const src = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${ms});`], { type: 'text/javascript' }));
      const w = new Worker(src);
      w.onmessage = fn;
      return { stop: () => { w.terminate(); URL.revokeObjectURL(src); } };
    } catch (e) {
      const id = setInterval(fn, ms);
      return { stop: () => clearInterval(id) };
    }
  }

  async function startLive() {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'window', frameRate: { ideal: 5, max: 10 } },
        audio: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'include',
      });
    } catch (e) {
      status(e && e.name === 'NotAllowedError' ? 'Screen sharing was cancelled.' : `Screen sharing didn't start: ${e && e.message}`, 'warn');
      return;
    }
    stopFiles();
    live.stream = stream;
    live.track = stream.getVideoTracks()[0];
    live.capture = window.ImageCapture ? new ImageCapture(live.track) : null;
    live.track.addEventListener('ended', () => stopLive('Screen sharing stopped.'));
    live.video.srcObject = stream;
    try { await live.video.play(); } catch (e) { /* plays once frames arrive */ }
    area.auto = null;
    session = newSession(() => performance.now() / 1000);
    reader = new FrameReader(session, 2);
    $('#stage').hidden = false;
    $('#stageHint').hidden = false;
    $('#startLive').hidden = true;
    $('#stopLive').hidden = false;
    status('Watching. Open a Keells bill and scroll slowly to the end.');
    showArea();
    ocr.start().catch(e => status(e.message, 'error'));
    live.ticker = startTicker(800, () => {
      live.waiters.splice(0).forEach(r => r());
      liveTick();
    });
    if (live.capture) grabLoop(live.capture);
  }

  // grabFrame reads the shared screen even while this tab is in the background (where a video element may
  // stop updating), but it waits for the next frame and a still window sends none. So frames are grabbed
  // in their own loop, paced by the ticker rather than page timers, and the newest one is kept.
  async function grabLoop(cap) {
    while (live.capture === cap) {
      try {
        const bmp = await cap.grabFrame();
        if (live.capture !== cap) { bmp.close(); break; }
        if (live.latest) live.latest.close();
        live.latest = bmp;
      } catch (e) { /* no frame yet */ }
      await new Promise(r => live.waiters.push(r));
    }
  }

  function grab() {
    const v = live.video;
    if (live.latest) { drawFrame(live.latest, live.latest.width, live.latest.height); return [live.latest.width, live.latest.height]; }
    if (!v.videoWidth) return null;
    drawFrame(v, v.videoWidth, v.videoHeight);
    return [v.videoWidth, v.videoHeight];
  }

  async function liveTick() {
    if (live.busy || !live.stream) return;
    live.busy = true;
    try {
      const size = grab();
      if (!size) return;
      const r = await reader.offer(size[0], size[1], performance.now() / 1000);
      if (r === 'blank') status('The shared window looks blank. Keep it open (not minimised).', 'warn');
      else if ($('#status').textContent.startsWith('The shared window looks blank')) status('Watching. Open a Keells bill and scroll slowly to the end.');
    } catch (e) {
      status(e.message || String(e), 'error');
    } finally {
      live.busy = false;
    }
  }

  function stopLive(msg) {
    if (!live.stream) return;
    if (live.ticker) live.ticker.stop();
    live.stream.getTracks().forEach(t => t.stop());
    if (live.latest) live.latest.close();
    live.waiters.splice(0).forEach(r => r());
    live.stream = live.track = live.capture = live.latest = live.ticker = null;
    live.video.srcObject = null;
    if (session) session.closeBill();
    $('#stage').hidden = true;
    $('#stageHint').hidden = true;
    $('#startLive').hidden = false;
    $('#stopLive').hidden = true;
    if (msg && !/^Only part/.test($('#status').textContent)) status(msg);
  }

  // Marking the bill's area by dragging on the live picture.
  function videoBox() {
    const v = live.video, r = v.getBoundingClientRect();
    const s = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    return { left: r.left + (r.width - v.videoWidth * s) / 2, top: r.top + (r.height - v.videoHeight * s) / 2, s };
  }

  function showArea() {
    const a = area.manual || area.auto, box = $('#areaBox'), v = live.video;
    $('#clearArea').hidden = !area.manual;
    if (!a || !v.videoWidth || $('#stage').hidden) { box.hidden = true; return; }
    const b = videoBox(), st = $('#stage').getBoundingClientRect();
    Object.assign(box.style, { left: `${b.left - st.left + a.x * b.s}px`, top: `${b.top - st.top + a.y * b.s}px`, width: `${a.w * b.s}px`, height: `${a.h * b.s}px` });
    box.className = area.manual ? 'area' : 'area auto';
    box.hidden = false;
  }

  function setupAreaDrag() {
    const stage = $('#stage');
    let start = null;
    const toVideo = e => {
      const b = videoBox(), v = live.video;
      return [Math.max(0, Math.min(v.videoWidth, (e.clientX - b.left) / b.s)), Math.max(0, Math.min(v.videoHeight, (e.clientY - b.top) / b.s))];
    };
    stage.addEventListener('pointerdown', e => {
      if (!live.video.videoWidth) return;
      start = toVideo(e);
      stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener('pointermove', e => {
      if (!start) return;
      const p = toVideo(e);
      area.manual = { x: Math.round(Math.min(start[0], p[0])), y: Math.round(Math.min(start[1], p[1])), w: Math.round(Math.abs(p[0] - start[0])), h: Math.round(Math.abs(p[1] - start[1])) };
      showArea();
    });
    const end = () => {
      if (!start) return;
      start = null;
      if (area.manual && (area.manual.w < 60 || area.manual.h < 60)) area.manual = null;     // a click, not a drag
      if (reader) reader.lastRead = null;                                                   // read the new area now
      showArea();
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    $('#clearArea').addEventListener('click', e => { e.preventDefault(); area.manual = null; showArea(); });
    window.addEventListener('resize', showArea);
    live.video.addEventListener('loadedmetadata', showArea);
  }

  // --- recordings and screenshots -----------------------------------------------------------------------
  const files = { running: false, cancel: false, wake: null };

  async function readFiles(list) {
    list = [...list].filter(f => /^(video|image)\//.test(f.type) || /\.(mp4|mov|m4v|webm|png|jpe?g|heic|webp)$/i.test(f.name));
    if (!list.length) { status('Choose a screen recording (video) or screenshots of the bill.', 'warn'); return; }
    if (files.running) return;
    stopLive();
    // Screenshots in the order they were taken.
    list.sort((a, b) => (a.lastModified - b.lastModified) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    Object.assign(files, { running: true, cancel: false });
    $('#fileRun').hidden = false;
    $('#result').hidden = true;
    try { files.wake = navigator.wakeLock ? await navigator.wakeLock.request('screen') : null; } catch (e) { files.wake = null; }
    area.auto = area.manual = null;
    let clockT = 0;
    session = newSession(() => clockT);
    reader = new FrameReader(session, 1);
    const found = billsFound;
    try {
      setFileProgress(0, 'Getting the reader ready...');
      await ocr.start();
      for (let i = 0; i < list.length && !files.cancel; i++) {
        const f = list[i], label = list.length > 1 ? ` (${i + 1} of ${list.length})` : '';
        const part = p => setFileProgress((i + p) / list.length, `Reading ${/^video/.test(f.type) || /\.(mp4|mov|m4v|webm)$/i.test(f.name) ? 'the recording' : 'screenshots'}${label}... ${Math.round(((i + p) / list.length) * 100)}%`);
        if (/^video/.test(f.type) || /\.(mp4|mov|m4v|webm)$/i.test(f.name)) {
          clockT = await readVideo(f, clockT + 10, t => { clockT = t; }, part);
        } else {
          clockT = await readImage(f, clockT + 1, t => { clockT = t; });
          part(1);
        }
      }
      session.closeBill();
      if (files.cancel) status('Stopped.');
      else if (billsFound === found && !/^Only part/.test($('#status').textContent)) {
        status('No Keells bill was found. Open the bill itself in the Keells Nexus app and record it while scrolling slowly from top to bottom.', 'warn');
      }
    } catch (e) {
      status(e.message || String(e), 'error');
    } finally {
      files.running = false;
      $('#fileRun').hidden = true;
      if (files.wake) files.wake.release().catch(() => {});
    }
  }

  async function readImage(file, t0, setT) {
    let bmp;
    try { bmp = await createImageBitmap(file); }
    catch (e) { status(`Can't open ${file.name}. Use a PNG or JPG screenshot.`, 'warn'); return t0; }
    drawFrame(bmp, bmp.width, bmp.height);
    const [w, h] = [bmp.width, bmp.height];
    if (bmp.close) bmp.close();
    reader.prev = reader.lastRead = null;
    // A screenshot is a still picture: read it, and an unfinished bill again at two other sizes.
    let t = t0;
    for (let pass = 0; pass < 3 && !files.cancel; pass++) {
      setT(t);
      const r = await reader.offer(w, h, t);
      if (r === 'skip' && pass > 0) break;
      t += 1.6;
    }
    return t;
  }

  function readVideo(file, t0, setT, part) {
    return new Promise((resolve, reject) => {
      const v = document.createElement('video');
      const url = URL.createObjectURL(file);
      v.muted = true; v.playsInline = true; v.preload = 'auto';
      v.setAttribute('playsinline', '');
      const fail = () => { URL.revokeObjectURL(url); reject(new Error(`This browser can't play ${file.name}. Try another recording, or screenshots.`)); };
      v.addEventListener('error', fail, { once: true });
      v.addEventListener('loadeddata', async () => {
        v.removeEventListener('error', fail);
        try {
          try { await v.play(); } catch (e) { /* frames still decode when seeking */ }
          v.pause();
          let dur = v.duration;
          if (!isFinite(dur)) { await seek(v, 1e7); dur = v.currentTime || v.duration; }
          reader.prev = reader.lastRead = null;
          const step = 0.25;
          let t = t0;
          for (let at = 0; at <= dur && !files.cancel; at += step) {
            await seek(v, at);
            if (!v.videoWidth) continue;
            drawFrame(v, v.videoWidth, v.videoHeight);
            t = t0 + at;
            setT(t);
            await reader.offer(v.videoWidth, v.videoHeight, t);
            part(Math.min(1, at / dur));
          }
          URL.revokeObjectURL(url);
          resolve(t + 6);            // later than any bill's "off screen" wait
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      }, { once: true });
      v.src = url;
    });
  }

  function seek(v, at) {
    return new Promise(res => {
      let done = false;
      const fin = () => { if (done) return; done = true; v.removeEventListener('seeked', fin); res(); };
      v.addEventListener('seeked', fin);
      setTimeout(fin, 4000);
      v.currentTime = at;
    });
  }

  function setFileProgress(p, text) {
    $('#fileBar').style.width = `${Math.round(p * 100)}%`;
    $('#fileText').textContent = text;
  }

  function stopFiles() { if (files.running) files.cancel = true; }

  // --- progress, results ----------------------------------------------------------------------------------
  function showProgress(p, state) {
    const box = $('#progress');
    if (!p || state === 'done') { box.hidden = true; return; }
    box.hidden = false;
    $('#pTitle').textContent = state === 'incomplete' ? 'Only part of the bill was read'
      : p.receipt ? `Reading bill ${p.receipt}...` : 'Reading the bill...';
    $('#pFrames').textContent = `${p.frames} picture${p.frames === 1 ? '' : 's'} read`;
    const target = p.target;
    const pct = target ? Math.max(0, Math.min(100, (p.itemsSum - p.discount) / target * 100)) : Math.min(90, p.lines * 8);
    $('#pBar').style.width = `${pct}%`;
    $('#pText').textContent = `${p.lines} line${p.lines === 1 ? '' : 's'} read · Rs ${money(p.itemsSum)}` + (target !== null ? ` of Rs ${money(target)}` : '');
    const hint = $('#pHint');
    hint.className = 'hint';
    if (p.missing.length) hint.textContent = `Scroll back up a little: line${p.missing.length > 1 ? 's' : ''} ${p.missing.slice(0, 6).join(', ')} ${p.missing.length > 1 ? "weren't" : "wasn't"} read yet.`;
    else if (target === null) hint.textContent = 'Keep scrolling slowly to the end of the bill (Gross / Net Amount).';
    else if (!p.addsUp) hint.textContent = "The lines don't add up to the total yet. Scroll back over the bill slowly.";
    else if (!p.known) hint.textContent = 'Scroll back to the top for a moment so the receipt number can be read.';
    else { hint.textContent = 'Everything adds up. Finishing...'; hint.className = 'hint good'; }
  }

  let bills = loadBills();
  let billsFound = 0;

  function loadBills() {
    try { const v = JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }

  function saveBills() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(bills)); return true; }
    catch (e) { status("This browser didn't let the bill be saved (private window?). Download the CSV to keep it.", 'warn'); return false; }
  }

  // The same bill read before: same receipt number, or the same date and time and total.
  function findSaved(rec) {
    return bills.find(b => b.BillKey === rec.BillKey || (rec.BillNo && b.BillNo === rec.BillNo) ||
      (b.BillDate && b.BillDate.includes(':') && b.BillDate === rec.BillDate && Math.abs((b.Total || 0) - (rec.Total || 0)) < 0.01));
  }

  function gotBill(rec) {
    billsFound++;
    const old = findSaved(rec);
    let shown = rec, seen = false;
    if (old) {
      seen = true;
      shown = old;
      // A receipt number read now that the first reading missed.
      if (!old.BillNo && rec.BillNo) { Object.assign(old, { BillNo: rec.BillNo, BillKey: rec.BillKey }); saveBills(); }
    } else {
      rec.ReadAt = new Date().toISOString();
      bills.unshift(rec);
      saveBills();
      renderBills();
    }
    showResult(shown, seen);
    const what = `${shown.BillNo ? `Bill ${shown.BillNo}` : 'Bill'}: Rs ${money(shown.Total)}, ${shown.Items.length} item${shown.Items.length === 1 ? '' : 's'}`;
    status(seen ? `${what}. You already have this bill.` : `${what}. Saved.`, shown.Check === 'mismatch' ? 'warn' : 'info');
    toast(seen ? 'You already have this bill' : `Keells bill read: Rs ${money(shown.Total)}`);
    chime();
    notify(seen ? 'Bill already collected' : 'Keells bill read', what);
  }

  function showResult(b, seen) {
    const box = $('#result');
    box.hidden = false;
    box.className = `card result${seen ? ' seen' : ''}${b.Check === 'mismatch' ? ' mismatch' : ''}`;
    $('#rTitle').textContent = seen ? 'You already have this bill' : b.Check === 'mismatch' ? 'Bill read, but please check it' : 'Keells bill read';
    $('#rSub').textContent = [b.Store, b.Counter ? `Counter ${b.Counter}` : ''].filter(Boolean).join(' · ');
    const facts = [
      ['Receipt', b.BillNo || 'not read'],
      ['Date', b.DateText || b.BillDate || '-'],
      ['Items', String(b.Items.length)],
      ['Total', `Rs ${money(b.Total)}`],
    ];
    if (b.PointsEarned !== null && b.PointsEarned !== undefined) facts.push(['Points earned', money(b.PointsEarned)]);
    if (b.PointsBalance !== null && b.PointsBalance !== undefined) facts.push(['Points balance', money(b.PointsBalance)]);
    $('#rFacts').innerHTML = facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
    $('#rCheck').textContent = b.CheckMessage || '';
    $('#rCheck').className = `check${b.Check === 'mismatch' ? ' mismatch' : ''}`;
    $('#rItemsSum').textContent = `${b.Items.length} item${b.Items.length === 1 ? '' : 's'}`;
    $('#rItems').innerHTML = itemRows(b);
    $('#rItemsBox').open = b.Items.length <= 12;
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function itemRows(b) {
    return (b.CsvLines || b.Items).map((it, i) => `<tr class="${it.Type === 'Discount' ? 'disc' : ''}"><td>${esc(it.LineNo || i + 1)}</td>` +
      `<td>${esc(it.Item)}${it.ItemCode ? ` <span class="muted small">${esc(it.ItemCode)}</span>` : ''}</td>` +
      `<td class="num">${money(it.UnitPrice)}</td><td class="num">${esc(+(+it.Qty).toFixed(3))}</td><td class="num">${money(it.Amount)}</td></tr>`).join('');
  }

  function renderBills() {
    $('#billCount').textContent = bills.length ? `(${bills.length})` : '';
    $('#downloadCsv').disabled = $('#clearBills').disabled = !bills.length;
    const host = $('#bills');
    if (!bills.length) { host.innerHTML = '<p class="empty">No bills yet. Read one above.</p>'; return; }
    host.innerHTML = bills.map((b, i) => `
      <details class="bill">
        <summary>
          <span><span class="when">${esc(b.DateText || b.BillDate || 'Unknown date')}</span>${b.Check === 'mismatch' ? '<span class="badge">check</span>' : ''}<br>
          <span class="meta">${esc(b.BillNo ? `Receipt ${b.BillNo}` : 'Receipt not read')} · ${b.Items.length} item${b.Items.length === 1 ? '' : 's'}</span></span>
          <span class="amt">Rs ${money(b.Total)}</span>
        </summary>
        <div class="table-wrap"><table class="items"><thead><tr><th>#</th><th>Item</th><th class="num">Price</th><th class="num">Qty</th><th class="num">Amount</th></tr></thead><tbody>${itemRows(b)}</tbody></table></div>
        <div class="tools"><span class="muted small">${esc(b.CheckMessage || '')}</span><button class="btn small ghost" data-del="${i}">Remove</button></div>
      </details>`).join('');
  }

  function downloadCsv() {
    const rows = [];
    bills.slice().reverse().forEach(b => rows.push(...KB.csvRows(b)));
    const blob = new Blob([KB.toCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'keells_ebill_items.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // --- set up ---------------------------------------------------------------------------------------------
  function phoneSteps() {
    const rec = isApple
      ? 'Swipe down from the top-right corner to open Control Centre and tap <b>Screen Recording</b> (add it in Settings &gt; Control Centre if it isn\'t there).'
      : 'Swipe down twice from the top of the screen and tap <b>Screen record</b> (or <b>Screen recorder</b>).';
    $('#phoneSteps').innerHTML = [
      'Open the bill in the <b>Keells Nexus</b> app.',
      rec,
      'Scroll <b>slowly</b> from the top of the bill to the end, pausing on each screenful. Then stop the recording.',
      'Come back here, tap <b>Choose the recording</b> and pick it from your videos.',
    ].map(s => `<li>${s}</li>`).join('');
  }

  function init() {
    if (!KB || !window.Tesseract) { status("This page didn't load completely. Reload it.", 'error'); return; }
    $('#liveIntro').hidden = !canLive;
    $('#fileIntro').hidden = canLive;
    if (!canLive) phoneSteps();
    $('#startLive').addEventListener('click', startLive);
    $('#stopLive').addEventListener('click', () => stopLive('Stopped watching.'));
    $('#stopFiles').addEventListener('click', stopFiles);
    document.querySelectorAll('input.pick').forEach(inp => {
      inp.addEventListener('click', () => { ocr.start().catch(() => {}); });     // start loading while the picker is open
      inp.addEventListener('change', () => { const l = [...inp.files]; inp.value = ''; readFiles(l); });
    });
    $('#downloadCsv').addEventListener('click', downloadCsv);
    $('#clearBills').addEventListener('click', () => {
      if (!confirm(`Remove all ${bills.length} saved bills from this browser? Download the CSV first if you want to keep them.`)) return;
      bills = [];
      saveBills();
      renderBills();
    });
    $('#bills').addEventListener('click', e => {
      const i = e.target.getAttribute && e.target.getAttribute('data-del');
      if (i === null || i === undefined) return;
      bills.splice(+i, 1);
      saveBills();
      renderBills();
    });
    setupAreaDrag();
    renderBills();
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
    // For testing: the reading code, without the screen.
    window.KeellsApp = { readFiles, get session() { return session; }, get bills() { return bills; } };
  }

  init();
})();
