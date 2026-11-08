// Camera proctoring for the student page. The video never leaves the browser:
// MediaPipe models run locally and only short events ("phone seen at 03:12 for 5 s") are sent,
// plus one snapshot when a phone is seen or the camera is covered, so the teacher can check it.

const MP = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const MODELS = "https://storage.googleapis.com/mediapipe-models";

// How long a condition must last before it becomes an event, ms.
const THRESHOLDS = { no_face: 3000, look_away: 3000, multi_face: 1500, phone: 1000, covered: 2000 };
const GRACE_MS = 1500;   // a short flicker does not split one episode into two
const TICK_MS = 400;
const PHONE_EVERY = 1400;
// Phone mode: catches a second phone held up to the screen (e.g. Google Lens) faster and more readily.
// Every other run looks at one quarter of the frame enlarged, so a phone far from the camera is still big enough.
const PHONE_MODE = { every: 700, threshold: 0, minScore: 0.28 };
const PHONE_HITS = { need: 2, windowMs: 3500 };  // a phone counts once it is found twice within this window
const PHONE_MIN_SCORE = 0.45;
const YAW_LIMIT = 0.55;  // nose offset from the eyes' midpoint, in eye distances
// A covered lens gives a dark or flat frame: low brightness, or almost no difference between pixels.
const COVERED = { maxMean: 26, maxStd: 9 };
const TILES = [[0, 0], [.4, 0], [0, .4], [.4, .4]];  // top-left corners of four overlapping 60% crops

const Proctor = {
  stream: null,
  events: [],        // shared with the draft, so it survives a reload
  startedAt: 0,
  onChange: () => {},
  onCameraLost: () => {},
  onPhone: () => {},      // (snapshot) when a new phone episode starts
  onCovered: () => {},    // (snapshot) when the lens has been covered for a moment
  onStatus: () => {},     // ({faces, covered}) every tick, for the "stay in the frame" countdown
  phoneMode: false,
  _face: null,
  _phone: null,
  _tiles: null,
  _video: null,
  _overlay: null,
  _loop: null,
  _state: {},        // type -> {since, lastTrue, event}
  _phoneSeen: false,
  _lastPhoneRun: 0,
  _phoneRuns: 0,
  _phoneHits: [],    // times the detector found a phone
  _tileIdx: 0,
  _focusTile: null,  // the quarter where a phone was just found: looked at again next run
  _lostEvent: null,
  _models: null,     // promise of the model loading
  _probe: null,      // tiny canvas for the brightness check
  _crop: null,

  // Throws a DOMException (NotAllowedError, NotFoundError, …) when there is no camera access.
  async requestCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw Object.assign(new Error("no mediaDevices"), { name: "NotSupportedError" });
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" }, audio: false,
    });
    this.stream.getVideoTracks().forEach(tr => tr.addEventListener("ended", () => this._cameraLost()));
    return this.stream;
  },

  async start(video, startedAt, events, overlay) {
    this._video = video;
    this._overlay = overlay || null;
    this.startedAt = startedAt;
    this.events = events;
    video.srcObject = this.stream;
    await video.play().catch(() => {});
    if (this._lostEvent) {
      this._lostEvent.dur = this._secs(Date.now()) - this._lostEvent.at;
      this._lostEvent = null;
      this.onChange();
    }
    clearInterval(this._loop);
    this._loop = setInterval(() => this._tick(), TICK_MS);  // the cover check runs at once; the rest once a model is loaded
    this.preload();
  },

  // Starts loading the models (once; a failed load is retried next call). Resolves when all are ready.
  preload() {
    this._models = this._models || this._loadModels().catch(e => {
      this._models = null;
      console.warn("proctoring models failed to load", e);
    });
    return this._models;
  },

  fullyReady() { return !!(this._face && this._phone && this._tiles); },

  stop() {
    clearInterval(this._loop);
    this._loop = null;
    if (this.stream) this.stream.getTracks().forEach(tr => tr.stop());
    this.stream = null;
  },

  ready() { return !!this._face; },

  async _loadModels() {
    const modelBytes = fetch(`${MODELS}/object_detector/efficientdet_lite2/int8/latest/efficientdet_lite2.tflite`)
      .then(r => r.arrayBuffer()).then(b => new Uint8Array(b));  // downloads while the runtime loads
    const vision = await import(`${MP}/vision_bundle.mjs`);
    const files = await vision.FilesetResolver.forVisionTasks(`${MP}/wasm`);
    // CPU on purpose: the GPU delegate silently finds nothing with the int8 object model.
    const make = (Task, opts) => Task.createFromOptions(files, { ...opts, baseOptions: { ...opts.baseOptions, delegate: "CPU" } });
    const face = this._face ? Promise.resolve(this._face) : make(vision.FaceDetector, {
      baseOptions: { modelAssetPath: `${MODELS}/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite` },
      runningMode: "VIDEO", minDetectionConfidence: 0.6,
    });
    face.then(f => { this._face = f; });
    // EfficientDet-Lite2 (448 px input) finds much smaller phones than Lite0 (320 px);
    // downloaded once and shared by the whole-frame and the enlarged-quarter detectors
    const bytes = await modelBytes;
    const phoneModel = {
      baseOptions: { modelAssetBuffer: bytes },
      categoryAllowlist: ["cell phone"], scoreThreshold: PHONE_MODE.minScore, maxResults: 3,
    };
    const [f, phone, tiles] = await Promise.all([face,
      this._phone || make(vision.ObjectDetector, { ...phoneModel, runningMode: "VIDEO" }),
      this._tiles || make(vision.ObjectDetector, { ...phoneModel, runningMode: "IMAGE" })]);
    this._face = f; this._phone = phone; this._tiles = tiles;
  },

  // Current camera frame as a small JPEG data URL (mirrored, like the student sees it).
  snapshot() {
    const v = this._video;
    if (!v || !v.videoWidth) return null;
    const w = 480, h = Math.round(v.videoHeight * w / v.videoWidth);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.translate(w, 0); ctx.scale(-1, 1);
    ctx.drawImage(v, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.7);
  },

  _secs(ms) { return Math.max(0, Math.round((ms - this.startedAt) / 1000)); },

  _isCovered(v) {
    const c = this._probe || (this._probe = Object.assign(document.createElement("canvas"), { width: 32, height: 24 }));
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, 32, 24);
    const d = ctx.getImageData(0, 0, 32, 24).data;
    let sum = 0, sq = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const y = .299 * d[i] + .587 * d[i + 1] + .114 * d[i + 2];
      sum += y; sq += y * y;
    }
    const mean = sum / n, std = Math.sqrt(Math.max(0, sq / n - mean * mean));
    return mean < COVERED.maxMean || std < COVERED.maxStd;
  },

  _detectPhone(v, minScore) {
    const hit = r => r.detections.some(d => d.categories.some(c => c.score >= minScore));
    this._phoneRuns++;
    let tile = null;
    if (this.phoneMode && (this._focusTile !== null || this._phoneRuns % 2 === 0)) {
      tile = this._focusTile ?? (this._tileIdx = (this._tileIdx + 1) % TILES.length);
    }
    if (tile === null) return hit(this._phone.detectForVideo(v, performance.now()));
    // enlarge one quarter of the frame (turn by turn) so a distant phone is big enough to be seen
    const [fx, fy] = TILES[tile];
    const c = this._crop || (this._crop = Object.assign(document.createElement("canvas"), { width: 448, height: 448 }));
    c.getContext("2d").drawImage(v, v.videoWidth * fx, v.videoHeight * fy, v.videoWidth * .6, v.videoHeight * .6, 0, 0, 448, 448);
    const found = hit(this._tiles.detect(c));
    this._focusTile = found ? tile : null;
    return found;
  },

  _drawFaces(faces, ok) {
    const o = this._overlay, v = this._video;
    if (!o || !v.videoWidth) return;
    if (o.width !== v.videoWidth) { o.width = v.videoWidth; o.height = v.videoHeight; }
    const ctx = o.getContext("2d");
    ctx.clearRect(0, 0, o.width, o.height);
    ctx.lineWidth = Math.max(4, o.width / 50);  // the preview is small, so the frame is drawn thick
    ctx.strokeStyle = ok ? "#45D98E" : "#FF4D5E";
    for (const f of faces) {
      const b = f.boundingBox;
      // the preview is mirrored, so the box is too
      ctx.strokeRect(o.width - b.originX - b.width, b.originY, b.width, b.height);
    }
  },

  _tick() {
    const v = this._video;
    if (!v || v.readyState < 2 || !this.stream) return;
    const now = Date.now();
    const covered = this._isCovered(v);
    this._track("covered", covered, now);
    if (!this._face) { this.onStatus({ faces: covered ? 0 : 1, covered, loading: true }); return; }

    let faces = [];
    try { faces = this._face.detectForVideo(v, performance.now()).detections; } catch { return; }

    if (this._phone && !covered && now - this._lastPhoneRun >= (this.phoneMode ? PHONE_MODE.every : PHONE_EVERY)) {
      this._lastPhoneRun = now;
      let found = false;
      try { found = this._detectPhone(v, this.phoneMode ? PHONE_MODE.minScore : PHONE_MIN_SCORE); } catch {}
      if (found) this._phoneHits.push(now);
    }
    this._phoneHits = this._phoneHits.filter(t => now - t < PHONE_HITS.windowMs);
    this._phoneSeen = this._phoneHits.length >= PHONE_HITS.need;

    let lookAway = false;
    if (faces.length === 1) {
      const k = faces[0].keypoints;  // right eye, left eye, nose tip, mouth, right ear, left ear
      if (k && k.length >= 3) {
        const eyeDist = Math.abs(k[0].x - k[1].x);
        const yaw = eyeDist > 0 ? (k[2].x - (k[0].x + k[1].x) / 2) / eyeDist : 0;
        lookAway = Math.abs(yaw) > YAW_LIMIT;
      }
    }

    this._drawFaces(faces, faces.length === 1 && !lookAway);
    this._track("no_face", !covered && faces.length === 0, now);
    this._track("multi_face", faces.length >= 2, now);
    this._track("look_away", lookAway, now);
    this._track("phone", !covered && this._phoneSeen, now);
    this.onStatus({ faces: faces.length, covered });
  },

  _track(type, on, now) {
    const s = this._state[type] || (this._state[type] = { since: 0, lastTrue: 0, event: null });
    if (on) {
      if (!s.since || now - s.lastTrue > GRACE_MS) { s.since = now; s.event = null; }
      s.lastTrue = now;
      const threshold = type === "phone" && this.phoneMode ? PHONE_MODE.threshold : THRESHOLDS[type];
      if (!s.event && now - s.since >= threshold) {
        s.event = { type, at: this._secs(s.since), dur: 0 };
        this.events.push(s.event);
        if (type === "phone") this.onPhone(this.snapshot());
        if (type === "covered") this.onCovered(this.snapshot());
      }
      if (s.event) {
        s.event.dur = Math.round((now - s.since) / 1000);
        this.onChange();
      }
    } else if (s.since && now - s.lastTrue > GRACE_MS) {
      s.since = 0;
      s.event = null;
    }
  },

  _cameraLost() {
    if (!this.stream) return;  // stopped on purpose
    this.stop();
    this._lostEvent = { type: "camera_off", at: this._secs(Date.now()), dur: 0 };
    this.events.push(this._lostEvent);
    this.onChange();
    this.onCameraLost();
  },
};

// Error name from getUserMedia -> i18n key for the student.
function cameraErrorKey(e) {
  if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) return "camera_denied";
  if (e && (e.name === "NotFoundError" || e.name === "OverconstrainedError")) return "camera_missing";
  return "camera_error";
}

// Loud siren played when a phone is seen. A web page cannot go above the device's own volume,
// so the sound is made as harsh as possible instead: two detuned waves sweeping 600-1400 Hz, compressed to full scale.
const Alarm = {
  ctx: null,

  // Call from a click: browsers only allow sound after the user interacted with the page.
  unlock() {
    try {
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
      this.ctx.resume();
    } catch {}
  },

  play(seconds) {
    this.unlock();
    if (navigator.vibrate) navigator.vibrate(Array(seconds * 2).fill(500));
    if (!this.ctx) return;
    const ctx = this.ctx, t0 = ctx.currentTime, end = t0 + seconds;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.ratio.value = 20;
    comp.connect(ctx.destination);
    const gain = ctx.createGain();
    gain.gain.value = 1;
    gain.connect(comp);
    for (const [type, shift] of [["square", 1], ["sawtooth", 1.03]]) {
      const osc = ctx.createOscillator();
      osc.type = type;
      for (let t = t0; t < end; t += 0.5) {
        osc.frequency.setValueAtTime(600 * shift, t);
        osc.frequency.linearRampToValueAtTime(1400 * shift, t + 0.25);
        osc.frequency.linearRampToValueAtTime(600 * shift, t + 0.5);
      }
      osc.connect(gain);
      osc.start(t0);
      osc.stop(end);
    }
  },
};
