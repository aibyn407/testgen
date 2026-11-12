// Living backgrounds shared by the teacher and student pages: five looks (stars, aurora, ocean,
// sunset, paper) remembered per browser, plus the particle lettering on the sign-in page.

const BG_LOOKS = ["steppe", "aurora", "ocean", "sunset", "paper"];
const REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;
// Phones: the full-screen sky redrawn 60 times a second (and every blurred card re-blurred with it)
// left too little CPU/GPU for taps, so there it is drawn at a lower resolution, a few times a second.
const LIGHT_MODE = matchMedia("(pointer: coarse), (max-width: 760px)").matches;
const SKY_FRAME_MS = LIGHT_MODE ? 160 : 0;

const TGBg = {
  _sky: null,
  _stars: [],
  _lastDraw: 0,
  paused: false,  // set while the camera AI runs on a phone: the sky then stays still

  init() {
    document.body.insertAdjacentHTML("afterbegin",
      `<div class="backdrop" aria-hidden="true"><i></i><i></i><i></i></div><canvas id="sky" aria-hidden="true"></canvas>`);
    this._sky = document.getElementById("sky");
    let saved = "steppe";
    try { saved = localStorage.getItem("tg-bg") || saved; } catch {}
    this.set(BG_LOOKS.includes(saved) ? saved : "steppe");
    document.addEventListener("click", e => {
      const sw = e.target.closest(".sw[data-v]");
      if (sw) this.set(sw.dataset.v);
    });
    addEventListener("resize", () => this._makeStars());
    this._makeStars();
    requestAnimationFrame(t => this._drawSky(t));
  },

  set(look) {
    document.body.dataset.bg = look;
    document.querySelectorAll(".sw[data-v]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === look)));
    try { localStorage.setItem("tg-bg", look); } catch {}
    TGParticles.readColors();
  },

  // the five round swatches, for any page that wants a picker
  pickerHtml() {
    return `<div class="bg-switch" role="group" aria-label="${escapeHtml(t("bg_label"))}">` +
      BG_LOOKS.map(v => `<button type="button" class="sw" data-v="${v}" title="${escapeHtml(t("bg_" + v))}"
        aria-label="${escapeHtml(t("bg_" + v))}" aria-pressed="${document.body.dataset.bg === v}"></button>`).join("") + `</div>`;
  },

  _makeStars() {
    const dpr = LIGHT_MODE ? 1 : Math.min(2, devicePixelRatio || 1), c = this._sky;
    c.width = Math.round(innerWidth * dpr); c.height = Math.round(innerHeight * dpr);
    this._stars = Array.from({ length: Math.round(innerWidth * innerHeight / 9000) }, () => ({
      x: Math.random() * c.width, y: Math.random() * c.height * .85,
      r: (Math.random() * 1.3 + .3) * dpr, ph: Math.random() * 6.28, sp: .5 + Math.random() * 1.5,
    }));
  },

  _drawSky(time) {
    if ((this.paused && this._lastDraw) || time - this._lastDraw < SKY_FRAME_MS) {
      requestAnimationFrame(t => this._drawSky(t));
      return;
    }
    this._lastDraw = time;
    const c = this._sky, ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    if (document.body.dataset.bg === "steppe") {
      ctx.fillStyle = "#EAF0FF";
      for (const s of this._stars) {
        ctx.globalAlpha = REDUCED_MOTION ? .8 : .3 + .7 * (Math.sin(time / 1000 * s.sp + s.ph) * .5 + .5);
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.29); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    requestAnimationFrame(t => this._drawSky(t));
  },
};

// Thousands of dots that settle into a word, scatter from the cursor and morph into another word.
const TGParticles = {
  canvas: null, ctx: null, parts: [], word: "", palette: ["text"], colors: {},
  W: 0, H: 0, dpr: 1, running: false, mouse: { x: -9999, y: -9999, down: false },
  anchor: () => ({ x: .5, y: .45, w: .9, h: .4 }),  // where the word sits, as fractions of the screen

  readColors() {
    const css = getComputedStyle(document.body);
    for (const k of ["text", "accent", "gold", "ice"]) this.colors[k] = css.getPropertyValue("--" + k).trim();
  },

  start(canvas, word, palette) {
    this.canvas = canvas; this.ctx = canvas.getContext("2d");
    this.readColors();
    if (!this._bound) {
      this._bound = true;
      addEventListener("pointermove", e => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; });
      addEventListener("pointerdown", e => { this.mouse.down = true; this.mouse.x = e.clientX; this.mouse.y = e.clientY; });
      addEventListener("pointerup", () => { this.mouse.down = false; });
      addEventListener("resize", () => { if (this.running) this._resize(); });
    }
    this.word = word; this.palette = palette || ["text", "text", "ice"];
    canvas.classList.remove("hidden");
    this._resize();
    if (!this.running) { this.running = true; requestAnimationFrame(() => this._frame()); }
    // the lettering face may still be loading; redraw the word once it is there
    document.fonts.load('900 100px Unbounded').catch(() => {}).then(() => { if (this.running) this._resize(); });
  },

  stop() {
    this.running = false;
    if (this.canvas) { this.ctx.clearRect(0, 0, this.W, this.H); this.canvas.classList.add("hidden"); }
  },

  morph(word, palette) { this.word = word; if (palette) this.palette = palette; this.scatter(60); this._build(); },

  scatter(power) {
    for (const p of this.parts) {
      const a = Math.random() * 6.28, s = Math.random() * power * this.dpr;
      p.vx += Math.cos(a) * s; p.vy += Math.sin(a) * s;
    }
  },

  _resize() {
    this.dpr = LIGHT_MODE ? 1 : Math.min(2, devicePixelRatio || 1);
    this.W = this.canvas.width = Math.round(innerWidth * this.dpr);
    this.H = this.canvas.height = Math.round(innerHeight * this.dpr);
    this._build();
  },

  _build() {
    const { W, H } = this, a = this.anchor();
    const off = document.createElement("canvas"); off.width = W; off.height = H;
    const o = off.getContext("2d");
    const size = Math.min(W * a.w / (this.word.length * .78), H * a.h);
    o.font = `900 ${size}px Unbounded, "Arial Black", sans-serif`;
    o.textAlign = "center"; o.textBaseline = "middle"; o.fillStyle = "#fff";
    o.fillText(this.word, W * a.x, H * a.y);
    const data = o.getImageData(0, 0, W, H).data, pts = [];
    const gap = Math.max(4, Math.round(5 * this.dpr));
    for (let y = 0; y < H; y += gap) for (let x = 0; x < W; x += gap) if (data[(y * W + x) * 4 + 3] > 128) pts.push([x, y]);
    pts.sort(() => Math.random() - .5);
    while (this.parts.length < pts.length) this.parts.push({ x: Math.random() * W, y: Math.random() * H, vx: 0, vy: 0, tx: 0, ty: 0, c: "text", s: 1 });
    this.parts.length = pts.length;
    this.parts.forEach((p, i) => { p.tx = pts[i][0]; p.ty = pts[i][1]; p.c = this.palette[i % this.palette.length]; p.s = (Math.random() * 1.1 + .8) * this.dpr; });
  },

  _frame() {
    if (!this.running) return;
    const { ctx, W, H, dpr, colors } = this;
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "rgba(0,0,0,0.3)"; ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";
    const R = 110 * dpr, mx = this.mouse.x * dpr, my = this.mouse.y * dpr;
    for (const p of this.parts) {
      const dx = p.x - mx, dy = p.y - my, d2 = dx * dx + dy * dy;
      if (!REDUCED_MOTION && d2 < R * R) { const d = Math.sqrt(d2) || 1, f = (1 - d / R) * (this.mouse.down ? 9 : 4.5); p.vx += dx / d * f; p.vy += dy / d * f; }
      p.vx += (p.tx - p.x) * .045; p.vy += (p.ty - p.y) * .045;
      p.vx *= .82; p.vy *= .82; p.x += p.vx; p.y += p.vy;
      const sp = Math.min(1, Math.hypot(p.vx, p.vy) / 18);
      ctx.fillStyle = sp > .25 ? colors.accent : colors[p.c];
      ctx.fillRect(p.x, p.y, p.s + sp * 2 * dpr, p.s + sp * 2 * dpr);
    }
    requestAnimationFrame(() => this._frame());
  },
};
