// Camera proctoring for the student page. The video never leaves the browser:
// MediaPipe models run locally and only short events ("phone seen at 03:12 for 5 s") are sent,
// plus one snapshot at the moment a phone is seen, so the teacher can check it.

const MP = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const MODELS = "https://storage.googleapis.com/mediapipe-models";

// How long a condition must last before it becomes an event, ms.
const THRESHOLDS = { no_face: 3000, look_away: 3000, multi_face: 1500, phone: 1000 };
const GRACE_MS = 1500;   // a short flicker does not split one episode into two
const FACE_EVERY = 400;
const PHONE_EVERY = 1200;
// Phone mode: catches a second phone held up to the screen (e.g. Google Lens) faster and more readily.
const PHONE_MODE = { every: 500, threshold: 500, minScore: 0.3 };
const PHONE_MIN_SCORE = 0.45;
const YAW_LIMIT = 0.55;  // nose offset from the eyes' midpoint, in eye distances

const Proctor = {
  stream: null,
  events: [],        // shared with the draft, so it survives a reload
  startedAt: 0,
  onChange: () => {},
  onCameraLost: () => {},
  onPhone: () => {},  // (snapshot data URL) when a new phone episode starts
  phoneMode: false,
  _face: null,
  _phone: null,
  _video: null,
  _loop: null,
  _state: {},        // type -> {since, lastTrue, event}
  _phoneSeen: false,
  _lastPhoneRun: 0,
  _lostEvent: null,
  _models: null,     // promise of the model loading

  // Throws a DOMException (NotAllowedError, NotFoundError, …) when there is no camera access.
  async requestCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw Object.assign(new Error("no mediaDevices"), { name: "NotSupportedError" });
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" }, audio: false,
    });
    this.stream.getVideoTracks().forEach(tr => tr.addEventListener("ended", () => this._cameraLost()));
    return this.stream;
  },

  async start(video, startedAt, events) {
    this._video = video;
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
    this._loop = setInterval(() => this._tick(), FACE_EVERY);  // ticks do nothing until a model is loaded
    // load once; a failed load is retried the next time the camera starts
    this._models = this._models || this._loadModels().catch(e => {
      this._models = null;
      console.warn("proctoring models failed to load", e);
    });
  },

  stop() {
    clearInterval(this._loop);
    this._loop = null;
    if (this.stream) this.stream.getTracks().forEach(tr => tr.stop());
    this.stream = null;
  },

  ready() { return !!this._face; },

  async _loadModels() {
    const vision = await import(`${MP}/vision_bundle.mjs`);
    const files = await vision.FilesetResolver.forVisionTasks(`${MP}/wasm`);
    // CPU on purpose: the GPU delegate silently finds nothing with the int8 object model; both models are small.
    const make = (Task, opts) => Task.createFromOptions(files, { ...opts, baseOptions: { ...opts.baseOptions, delegate: "CPU" } });
    this._face = this._face || await make(vision.FaceDetector, {
      baseOptions: { modelAssetPath: `${MODELS}/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite` },
      runningMode: "VIDEO", minDetectionConfidence: 0.6,
    });
    this._phone = this._phone || await make(vision.ObjectDetector, {
      baseOptions: { modelAssetPath: `${MODELS}/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite` },
      runningMode: "VIDEO", categoryAllowlist: ["cell phone"], scoreThreshold: PHONE_MODE.minScore, maxResults: 1,
    });
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

  _tick() {
    const v = this._video;
    if (!this._face || !v || v.readyState < 2 || !this.stream) return;
    const now = Date.now();
    let faces = [];
    try { faces = this._face.detectForVideo(v, performance.now()).detections; } catch { return; }

    if (this._phone && now - this._lastPhoneRun >= (this.phoneMode ? PHONE_MODE.every : PHONE_EVERY)) {
      this._lastPhoneRun = now;
      const minScore = this.phoneMode ? PHONE_MODE.minScore : PHONE_MIN_SCORE;
      try {
        this._phoneSeen = this._phone.detectForVideo(v, performance.now()).detections
          .some(d => d.categories.some(c => c.score >= minScore));
      } catch { this._phoneSeen = false; }
    }

    let lookAway = false;
    if (faces.length === 1) {
      const k = faces[0].keypoints;  // right eye, left eye, nose tip, mouth, right ear, left ear
      if (k && k.length >= 3) {
        const eyeDist = Math.abs(k[0].x - k[1].x);
        const yaw = eyeDist > 0 ? (k[2].x - (k[0].x + k[1].x) / 2) / eyeDist : 0;
        lookAway = Math.abs(yaw) > YAW_LIMIT;
      }
    }

    this._track("no_face", faces.length === 0, now);
    this._track("multi_face", faces.length >= 2, now);
    this._track("look_away", lookAway, now);
    this._track("phone", this._phoneSeen, now);
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
