// Student page: /t/<share_code>. No sign-in; progress survives a page reload.

const CODE = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "");
const DRAFT_KEY = "draft_" + CODE;
const LOCK_KEY = "lock_" + CODE;
const BAN_KEY = "ban_" + CODE;
const ALARM_SECONDS = 10;
const FACE_WARN_AFTER = 3000;   // out of the frame this long: a warning with a countdown
const FACE_LIMIT_SECONDS = 10;  // ...and when the countdown ends, the test is closed
let TEST = null;      // public test info
let DRAFT = null;     // {questions, answers, name, group, startedAt, idx, qStartedAt}
let timerId = null;
let qTimerId = null;
let lockTimerId = null;
let submitting = false;
let unloading = false;  // reload/close is not "leaving to another tab"
let quizOpen = false;

function loadDraft() { try { return JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch { return null; } }
function saveDraft() { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(DRAFT)); } catch {} }
function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch {} }
function lockUntil() { try { return Number(localStorage.getItem(LOCK_KEY)) || 0; } catch { return 0; } }
function setLock(until) { try { localStorage.setItem(LOCK_KEY, String(until)); } catch {} }
function isBanned() { try { return !!localStorage.getItem(BAN_KEY); } catch { return false; } }
function setBanned() { try { localStorage.setItem(BAN_KEY, "1"); } catch {} }

// One question at a time with its own countdown.
function stepMode() { return TEST.question_time > 0; }

function showOnly(id) {
  ["loading", "message", "view-start", "view-quiz", "view-result"].forEach(x =>
    document.getElementById(x).classList.toggle("hidden", x !== id));
}

function showMessage(key) {
  const m = document.getElementById("message");
  m.dataset.key = key;
  m.dataset.gate = "";
  m.textContent = t(key);
  showOnly("message");
}

function showLocked(until, reasonKey) {
  const m = document.getElementById("message");
  m.dataset.key = "";
  m.dataset.gate = "";
  clearInterval(lockTimerId);
  const tick = () => {
    const left = Math.max(0, Math.round((until - Date.now()) / 1000));
    m.innerHTML = `${reasonKey ? `<p class="status err">${t(reasonKey)}</p>` : ""}
      <div class="muted">${t("locked_retry")}</div>
      <div class="lock-time">${fmtDuration(left)}</div>`;
    if (left <= 0) { clearInterval(lockTimerId); location.reload(); }
  };
  tick();
  lockTimerId = setInterval(tick, 1000);
  showOnly("message");
}

function showBanned(reasonKey) {
  const m = document.getElementById("message");
  m.dataset.key = "";
  m.dataset.gate = "";
  m.innerHTML = `${reasonKey ? `<p class="status err">${escapeHtml(t(reasonKey))}</p>` : ""}
    <div class="lock-time">⛔</div><p>${escapeHtml(t("banned"))}</p>`;
  showOnly("message");
}

function onLangChange() {
  const m = document.getElementById("message");
  if (!m.classList.contains("hidden") && m.dataset.key) m.textContent = t(m.dataset.key);
  if (!m.classList.contains("hidden") && m.dataset.gate) showCameraGate(m.dataset.gate);
  if (TEST) renderStartMeta();
  if (DRAFT && !document.getElementById("view-quiz").classList.contains("hidden")) {
    collectInto(DRAFT.answers);
    renderQuestions();
  }
}

async function init() {
  let hasLangPref = false;
  try { hasLangPref = !!localStorage.getItem("lang"); } catch {}
  try {
    TEST = await apiCall("GET", `/api/public/${encodeURIComponent(CODE)}`);
  } catch (e) {
    applyI18n();
    showMessage(e.status === 404 ? "not_found" : "err_network");
    return;
  }
  if (!hasLangPref && I18N[TEST.language]) CURRENT_LANG = TEST.language;
  applyI18n();
  document.title = TEST.title;

  if (!TEST.is_open) { clearDraft(); showMessage("test_closed"); return; }
  if (TEST.proctoring && TEST.phone_penalty === "ban" && isBanned()) { showBanned(false); return; }
  if (lockUntil() > Date.now()) { showLocked(lockUntil(), false); return; }

  DRAFT = loadDraft();
  if (DRAFT && DRAFT.questions && DRAFT.questions.length) {
    if (TEST.proctoring) retryCamera(); else openQuiz();
    return;
  }
  if (!TEST.questions.length) { showMessage("test_empty"); return; }

  renderStartMeta();
  try {
    document.getElementById("student-name").value = localStorage.getItem("student_name") || "";
    document.getElementById("student-group").value = localStorage.getItem("student_group") || "";
  } catch {}
  showOnly("view-start");
}

function renderStartMeta() {
  document.getElementById("start-title").textContent = TEST.title;
  const time = TEST.time_limit ? `${TEST.time_limit} ${t("minutes")}` : t("no_limit");
  document.getElementById("start-meta").textContent = [
    TEST.teacher ? `${t("teacher_label")}: ${TEST.teacher}` : "",
    `${t("questions_total")}: ${TEST.questions.length}`, `${t("time_limit")}: ${time}`,
  ].filter(Boolean).join(" · ");
  document.getElementById("start-rules").innerHTML = rulesHtml();
}

function rulesHtml() {
  const rules = [];
  if (stepMode()) rules.push(t("rule_qtime").replace("{s}", TEST.question_time));
  if (TEST.anti_cheat) rules.push(t("rule_anticheat").replace("{m}", TEST.lock_minutes));
  if (TEST.proctoring) rules.push(t("rule_camera"), t("rule_face"));
  if (TEST.proctoring) rules.push(t("rule_phone_" + TEST.phone_penalty).replace("{m}", TEST.phone_lock_minutes));
  return rules.map(r => `<li>${escapeHtml(r)}</li>`).join("");
}

async function startTest(e) {
  e.preventDefault();
  const name = document.getElementById("student-name").value.trim();
  const group = document.getElementById("student-group").value.trim();
  if (name.length < 2) { alert(t("enter_name")); return; }
  try { localStorage.setItem("student_name", name); localStorage.setItem("student_group", group); } catch {}
  try {
    const lock = await apiCall("POST", `/api/public/${encodeURIComponent(CODE)}/lock`,
      { student_name: name, student_group: group });
    if (lock.banned) { setBanned(); showBanned(false); return; }
    if (lock.locked_seconds > 0) {
      setLock(Date.now() + lock.locked_seconds * 1000);
      showLocked(lockUntil(), false);
      return;
    }
  } catch {}
  if (TEST.proctoring) {
    const status = document.getElementById("start-status");
    const btn = document.getElementById("start-btn");
    status.textContent = "";
    btn.disabled = true;
    Alarm.unlock();
    try { await Proctor.requestCamera(); }
    catch (err) { status.textContent = t(cameraErrorKey(err)); btn.disabled = false; return; }
    await waitForAI(btn);
    btn.disabled = false;
  }
  const now = Date.now();
  DRAFT = { questions: TEST.questions, answers: {}, name, group, startedAt: now, idx: 0, qStartedAt: now,
            proctorEvents: [] };
  saveDraft();
  openQuiz();
}

function openQuiz() {
  document.getElementById("quiz-title").textContent = TEST.title;
  document.getElementById("quiz-student").textContent = [DRAFT.name, DRAFT.group].filter(Boolean).join(" · ");
  // the rules are shown on the start card only; keeping them above the questions crowds the test on a phone
  document.getElementById("quiz-rules").innerHTML = "";
  renderQuestions();
  showOnly("view-quiz");
  quizOpen = true;
  if (TEST.time_limit) startTimer();
  if (stepMode()) startQuestionTimer();
  if (TEST.proctoring) startProctor();
}

// ---------- camera proctoring ----------

function startProctor() {
  if (LIGHT_MODE) TGBg.paused = true;  // leave the phone's CPU to the camera AI and the student's taps
  if (!DRAFT.proctorEvents) DRAFT.proctorEvents = [];
  Proctor.onChange = saveDraft;
  Proctor.phoneMode = !!TEST.phone_detect;
  Proctor.onPhone = image => onCameraViolation("phone", image);
  Proctor.onCovered = image => onCameraViolation("covered", image);
  Proctor.onStatus = watchFace;
  Proctor.onCameraLost = () => {
    document.getElementById("cam-box").classList.add("hidden");
    if (!submitting) showCameraGate("camera_lost");
  };
  document.getElementById("cam-box").classList.remove("hidden");
  Proctor.start(document.getElementById("cam-video"), DRAFT.startedAt, DRAFT.proctorEvents, document.getElementById("cam-overlay"));
}

function stopProctor() {
  TGBg.paused = false;
  Proctor.stop();
  document.getElementById("cam-box").classList.add("hidden");
}

// Without camera access the test does not start (or continue).
function showCameraGate(key) {
  const m = document.getElementById("message");
  m.dataset.key = "";
  m.dataset.gate = key;
  m.innerHTML = `<p class="status err">${escapeHtml(t(key))}</p>
    <button class="primary big" onclick="retryCamera()">${escapeHtml(t("camera_enable"))}</button>`;
  showOnly("message");
}

// The test starts only once the AI watcher is fully loaded, so no minute goes unwatched.
// On a very slow connection it gives up waiting after a while rather than block the student.
async function waitForAI(btn) {
  if (Proctor.fullyReady()) return;
  const label = btn ? btn.textContent : "";
  if (btn) btn.innerHTML = `<span class="spinner"></span> ${escapeHtml(t("ai_loading"))}`;
  await Promise.race([Proctor.preload(), new Promise(r => setTimeout(r, 45000))]);
  if (btn) btn.textContent = label;
}

async function retryCamera() {
  Alarm.unlock();
  try { await Proctor.requestCamera(); }
  catch (err) { showCameraGate(cameraErrorKey(err)); return; }
  if (!Proctor.fullyReady()) {
    const m = document.getElementById("message");
    m.dataset.key = ""; m.dataset.gate = "";
    m.innerHTML = `<span class="spinner"></span><p>${escapeHtml(t("ai_loading"))}</p>`;
    showOnly("message");
    await waitForAI();
  }
  if (quizOpen) { showOnly("view-quiz"); startProctor(); }
  else openQuiz();
}

function renderQuestions() {
  const qs = DRAFT.questions;
  const btn = document.getElementById("submit-btn");
  if (stepMode()) {
    const i = Math.min(DRAFT.idx || 0, qs.length - 1);
    document.getElementById("questions").innerHTML =
      `<div class="q-timer" id="q-timer"><div class="q-timer-bar" id="q-bar"></div><span id="q-left"></span></div>` +
      questionHtml(qs[i], i);
    btn.textContent = i < qs.length - 1 ? t("next") : t("submit");
  } else {
    document.getElementById("questions").innerHTML = qs.map(questionHtml).join("");
    btn.textContent = t("submit");
  }
}

function questionHtml(q, i) {
  const a = DRAFT.answers;
  let body = "";
  if (q.type === "multiple_choice") {
    body = q.options.map(o => `
      <label class="choice"><input type="radio" name="q${q.id}" value="${escapeHtml(o)}"
        ${a[q.id] === o ? "checked" : ""} onchange="onAnswer()" /><span>${escapeHtml(o)}</span></label>`).join("");
  } else if (q.type === "open") {
    body = `<input type="text" name="q${q.id}" value="${escapeHtml(a[q.id] || "")}"
      placeholder="${escapeHtml(t("write_answer"))}" oninput="onAnswer()" autocomplete="off" />`;
  } else if (q.type === "matching") {
    const cur = a[q.id] || {};
    body = q.options.left.map(term => `
      <div class="match-row">
        <div class="term">${escapeHtml(term)}</div>
        <select data-qid="${q.id}" data-term="${escapeHtml(term)}" onchange="onAnswer()">
          <option value="">${t("choose")}</option>
          ${q.options.right.map(r => `<option value="${escapeHtml(r)}" ${cur[term] === r ? "selected" : ""}>${escapeHtml(r)}</option>`).join("")}
        </select>
      </div>`).join("");
  }
  const section = i === 0 || DRAFT.questions[i - 1].type !== q.type
    ? `<div class="section-title">${t("section_" + q.type)}</div>` : "";
  return `${section}<div class="question" id="qb${q.id}">
    <div class="num">${i + 1} / ${DRAFT.questions.length} <span class="pill type">${t("type_" + q.type)}</span></div>
    <div class="q-text">${escapeHtml(q.question)}</div>
    ${body}
  </div>`;
}

function collectInto(answers) {
  for (const q of DRAFT.questions) {
    if (!document.getElementById("qb" + q.id)) continue;  // not on screen (one-at-a-time mode)
    if (q.type === "multiple_choice") {
      const el = document.querySelector(`input[name="q${q.id}"]:checked`);
      answers[q.id] = el ? el.value : "";
    } else if (q.type === "open") {
      const el = document.querySelector(`input[name="q${q.id}"]`);
      answers[q.id] = el ? el.value : "";
    } else {
      const map = {};
      document.querySelectorAll(`select[data-qid="${q.id}"]`).forEach(s => { map[s.dataset.term] = s.value; });
      answers[q.id] = map;
    }
  }
  return answers;
}

function onAnswer() {
  collectInto(DRAFT.answers);
  saveDraft();
}

function isAnswered(q, v) {
  if (q.type === "matching") return v && Object.values(v).every(Boolean);
  return !!(v && String(v).trim());
}

function startTimer() {
  const timer = document.getElementById("timer");
  timer.classList.remove("hidden");
  const deadline = DRAFT.startedAt + TEST.time_limit * 60 * 1000;
  const tick = () => {
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    timer.textContent = `${t("time_left")}: ${fmtDuration(left)}`;
    timer.classList.toggle("low", left <= 60);
    if (left <= 0) { clearInterval(timerId); submitAnswers(true); }
  };
  tick();
  timerId = setInterval(tick, 1000);
}

function startQuestionTimer() {
  clearInterval(qTimerId);
  const limit = TEST.question_time * 1000;
  const tick = () => {
    if (submitting) return;
    const left = Math.max(0, DRAFT.qStartedAt + limit - Date.now());
    const bar = document.getElementById("q-bar");
    if (bar) {
      bar.style.width = `${(left / limit) * 100}%`;
      document.getElementById("q-left").textContent = `${Math.ceil(left / 1000)} ${t("sec")}`;
      document.getElementById("q-timer").classList.toggle("low", left <= 10000);
    }
    // Chain deadlines so time spent away (closed tab) is not given back.
    if (left <= 0) nextQuestion(DRAFT.qStartedAt + limit);
  };
  tick();
  qTimerId = setInterval(tick, 250);
}

function nextQuestion(startAt) {
  collectInto(DRAFT.answers);
  DRAFT.idx = (DRAFT.idx || 0) + 1;
  DRAFT.qStartedAt = startAt || Date.now();
  saveDraft();
  if (DRAFT.idx >= DRAFT.questions.length) { submitAnswers(false, true); return; }
  renderQuestions();
  window.scrollTo(0, 0);
}

function onMainButton() {
  if (stepMode()) nextQuestion();
  else submitAnswers(false);
}

// A camera violation (a phone, a covered lens, or the student gone from the frame): siren,
// a snapshot to the teacher, and the test ends with 0 points.
// Leaving the frame or covering the lens always ends the test — a student cannot keep taking a test off camera
// even when the teacher chose "alarm only" for phones, since that penalty was meant for phones alone.
function onCameraViolation(kind, image) {
  if (submitting || !quizOpen) return;
  hideFaceWarn();
  fetch(`/api/public/${encodeURIComponent(CODE)}/alert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ student_name: DRAFT.name, student_group: DRAFT.group || "", type: kind, image }),
  }).catch(() => {});
  Alarm.play(ALARM_SECONDS);
  showAlarm(kind);
  if (kind === "phone") { if (TEST.phone_penalty !== "alarm") endForCheating("phone"); return; }
  endForCheating("camera");  // no_face / covered — always end the test
}

// The student's face must stay in the frame: after a few seconds away a countdown starts.
let faceGoneSince = 0, faceWarnTimer = null;
function watchFace({ faces, covered, loading }) {
  if (submitting || !quizOpen || loading) return;
  document.getElementById("cam-box").classList.toggle("lost", faces === 0 || covered);
  if (faces > 0 || covered) { faceGoneSince = 0; hideFaceWarn(); return; }  // a covered lens has its own rule
  const now = Date.now();
  if (!faceGoneSince) faceGoneSince = now;
  if (now - faceGoneSince < FACE_WARN_AFTER || faceWarnTimer) return;
  const until = faceGoneSince + FACE_WARN_AFTER + FACE_LIMIT_SECONDS * 1000;
  const el = document.createElement("div");
  el.id = "face-warn"; el.className = "face-warn"; el.setAttribute("role", "alert");
  document.body.appendChild(el);
  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left <= 0) { const img = Proctor.snapshot(); hideFaceWarn(); faceGoneSince = 0; onCameraViolation("no_face", img); return; }
    el.innerHTML = `<div><h1>${escapeHtml(t("face_warn_title"))}</h1><p>${escapeHtml(t("face_warn_text"))}</p>
      <div class="phone-alarm-left">${left}</div></div>`;
  };
  tick();
  faceWarnTimer = setInterval(tick, 250);
}
function hideFaceWarn() {
  clearInterval(faceWarnTimer); faceWarnTimer = null;
  const el = document.getElementById("face-warn");
  if (el) el.remove();
}

const ALARM_ICON = { phone: "📵", covered: "🚫", no_face: "👤" };
function showAlarm(kind) {
  let el = document.getElementById("phone-alarm");
  if (!el) {
    el = document.createElement("div");
    el.id = "phone-alarm";
    el.className = "phone-alarm";
    document.body.appendChild(el);
  }
  const until = Date.now() + ALARM_SECONDS * 1000;
  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left <= 0) { clearInterval(el._timer); el.remove(); return; }
    el.innerHTML = `<div class="phone-alarm-box"><div class="phone-alarm-icon">${ALARM_ICON[kind]}</div>
      <h1>${escapeHtml(t("alarm_" + kind + "_title"))}</h1><p>${escapeHtml(t("alarm_" + kind + "_text"))}</p>
      <div class="phone-alarm-left">${left}</div></div>`;
  };
  clearInterval(el._timer);
  tick();
  el._timer = setInterval(tick, 250);
}

// Leaving for another tab or app (or a phone in the camera) ends the test with 0 points and locks it for a while.
function onLeavePage() {
  if (unloading || submitting || !TEST || !TEST.anti_cheat || !DRAFT || !quizOpen) return;
  endForCheating("left_page");
}

function endForCheating(reason) {
  submitting = true;
  hideFaceWarn();
  stopProctor();
  clearInterval(timerId);
  clearInterval(qTimerId);
  const answers = {};
  DRAFT.questions.forEach(q => { answers[String(q.id)] = DRAFT.answers[q.id] ?? ""; });
  fetch(`/api/public/${encodeURIComponent(CODE)}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    keepalive: reason === "left_page",  // the request must survive the tab being in the background
    body: JSON.stringify({
      student_name: DRAFT.name, student_group: DRAFT.group || "", answers,
      duration_sec: Math.round((Date.now() - DRAFT.startedAt) / 1000), violation: true,
      violation_reason: reason, proctor_events: DRAFT.proctorEvents || [],
    }),
  }).catch(() => {});
  clearDraft();
  const byCamera = reason === "phone" || reason === "camera";
  if (byCamera && TEST.phone_penalty === "ban") { setBanned(); showBanned(reason === "phone" ? "phone_caught" : "camera_caught"); return; }
  const minutes = byCamera ? TEST.phone_lock_minutes : TEST.lock_minutes;
  setLock(Date.now() + minutes * 60 * 1000);
  showLocked(lockUntil(), { left_page: "left_page", phone: "phone_caught", camera: "camera_caught" }[reason]);
}

document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") onLeavePage(); });
window.addEventListener("beforeunload", () => { unloading = true; });

async function submitAnswers(auto, noConfirm) {
  if (submitting) return;
  collectInto(DRAFT.answers);
  saveDraft();

  if (!auto && !noConfirm) {
    document.querySelectorAll(".question.missing").forEach(el => el.classList.remove("missing"));
    const missing = DRAFT.questions.map((q, i) => [q, i]).filter(([q]) => !isAnswered(q, DRAFT.answers[q.id]));
    missing.forEach(([q]) => document.getElementById("qb" + q.id).classList.add("missing"));
    const msg = missing.length
      ? `${t("unanswered")} ${missing.map(([, i]) => i + 1).join(", ")}\n\n${t("confirm_submit")}`
      : t("confirm_submit");
    if (!confirm(msg)) return;
  }

  submitting = true;
  const btn = document.getElementById("submit-btn");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>`;
  const answers = {};
  DRAFT.questions.forEach(q => { answers[String(q.id)] = DRAFT.answers[q.id] ?? ""; });
  try {
    const res = await apiCall("POST", `/api/public/${encodeURIComponent(CODE)}/submit`, {
      student_name: DRAFT.name,
      student_group: DRAFT.group || "",
      answers,
      duration_sec: Math.round((Date.now() - DRAFT.startedAt) / 1000),
      proctor_events: DRAFT.proctorEvents || [],
    });
    stopProctor();
    clearInterval(timerId);
    clearInterval(qTimerId);
    const order = DRAFT.questions.map(q => q.id);
    if (res.details) res.details.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    clearDraft();
    showResult(res, auto);
  } catch (e) {
    submitting = false;
    btn.disabled = false;
    btn.textContent = t("submit");
    document.getElementById("submit-status").textContent = e.message;
  }
}

function showResult(res, auto) {
  const g = res.grade;
  document.getElementById("score-hero").innerHTML = `
    ${auto ? `<p class="status err">${t("time_up")}</p>` : ""}
    <div class="muted">${t("your_result")}</div>
    <div class="letter">${escapeHtml(g.letter)}</div>
    <div class="pct">${Math.round(res.percent)}% · ${res.score} / ${res.total}</div>
    <div class="muted">${escapeHtml(gradeText(g.letter))} · GPA ${g.gpa}</div>`;

  const review = document.getElementById("review");
  if (!res.details) {
    review.innerHTML = `<div class="card center-msg muted">${t("answers_hidden")}</div>`;
  } else {
    review.innerHTML = res.details.map((d, i) => {
      const cls = d.points >= 1 ? "ok" : d.points > 0 ? "part" : "";
      return `<div class="review-item ${cls}">
        <div><strong>${i + 1}.</strong> ${escapeHtml(d.question)}</div>
        <div class="ua">${t("your_answer")}: ${escapeHtml(formatAnswer(d.user))}</div>
        ${d.points < 1 ? `<div class="ca">${t("right_answer")}: ${escapeHtml(formatAnswer(d.correct))}</div>` : ""}
      </div>`;
    }).join("");
  }
  showOnly("view-result");
  window.scrollTo(0, 0);
}

applyI18n();
TGBg.init();
init();
