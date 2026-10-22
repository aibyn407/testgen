// Teacher app: sign in, upload files, generate/edit questions, share link, view results.

const S = {
  token: storageGet("token"),
  username: storageGet("username"),
  authMode: "login",
  testId: null,
  tab: "questions",
  data: null,      // {test, topics, questions}
  results: null,
  editing: null,   // question id being edited
};
let CHARTS = [];

function storageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function storageSet(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }

async function api(method, path, body, opts = {}) {
  try {
    return await apiCall(method, path, body, { ...opts, token: S.token });
  } catch (e) {
    if (e.status === 401 && e.code === "auth_required") { signOutLocal(); route(); }
    throw e;
  }
}

function show(id) {
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("hidden", v.id !== id));
}

// ---------- routing (#/test/12/results) ----------

function route() {
  const signedIn = !!S.token;
  document.getElementById("logout-btn").classList.toggle("hidden", !signedIn);
  const chip = document.getElementById("user-chip");
  chip.classList.toggle("hidden", !signedIn);
  chip.textContent = S.username || "";
  if (!signedIn) { renderAuth(); show("view-auth"); return; }

  const m = location.hash.match(/^#\/test\/(\d+)(?:\/(\w+))?/);
  if (m) openTest(Number(m[1]), m[2] || "questions");
  else { S.testId = null; S.data = null; show("view-home"); loadTests(); }
}
window.addEventListener("hashchange", route);

function goHome() { location.hash = ""; }

function onLangChange() {
  if (!document.getElementById("view-auth").classList.contains("hidden")) renderAuth();
  else if (S.testId && !document.getElementById("view-test").classList.contains("hidden")) renderTest();
  else if (S.token) loadTests();
}

// ---------- auth ----------

function renderAuth() {
  const login = S.authMode === "login";
  document.getElementById("auth-submit").textContent = t(login ? "login" : "register");
  document.getElementById("auth-toggle").textContent = t(login ? "no_account" : "have_account");
  document.getElementById("auth-pass").autocomplete = login ? "current-password" : "new-password";
}

function toggleAuthMode() {
  S.authMode = S.authMode === "login" ? "register" : "login";
  document.getElementById("auth-status").textContent = "";
  renderAuth();
}

async function submitAuth(e) {
  e.preventDefault();
  const status = document.getElementById("auth-status");
  const btn = document.getElementById("auth-submit");
  btn.disabled = true;
  status.className = "status";
  try {
    const res = await apiCall("POST", `/api/auth/${S.authMode}`, {
      username: document.getElementById("auth-user").value.trim(),
      password: document.getElementById("auth-pass").value,
    });
    S.token = res.token; S.username = res.username;
    storageSet("token", res.token); storageSet("username", res.username);
    document.getElementById("auth-pass").value = "";
    route();
  } catch (err) {
    status.className = "status err"; status.textContent = err.message;
  } finally { btn.disabled = false; }
}

function signOutLocal() {
  S.token = null; S.username = null;
  storageSet("token", null); storageSet("username", null);
}

async function logout() {
  try { await apiCall("POST", "/api/auth/logout", null, { token: S.token }); } catch {}
  signOutLocal();
  location.hash = "";
  route();
}

// ---------- home ----------

async function loadTests() {
  const list = document.getElementById("tests-list");
  list.innerHTML = `<div class="status"><span class="spinner"></span></div>`;
  try {
    const tests = await api("GET", "/api/tests");
    if (!tests.length) { list.innerHTML = `<div class="card muted">${t("no_tests")}</div>`; return; }
    list.innerHTML = tests.map(x => `
      <div class="list-item" onclick="location.hash='#/test/${x.id}'">
        <div style="flex:1;min-width:0">
          <div class="title">${escapeHtml(x.title)}</div>
          <div class="meta">${x.questions_count} ${t("questions_n")} · ${x.attempts_count} ${t("attempts_n")} · ${new Date(x.created_at).toLocaleDateString()}</div>
        </div>
        <span class="pill ${x.is_open ? "ok" : "off"}">${t(x.is_open ? "open" : "closed")}</span>
      </div>`).join("");
  } catch (e) { list.innerHTML = `<div class="status err">${escapeHtml(e.message)}</div>`; }
}

function onFilePicked() {
  const f = document.getElementById("file-input").files[0];
  const label = document.getElementById("file-name");
  label.textContent = f ? f.name : t("choose_file");
  if (f) label.removeAttribute("data-i18n"); else label.dataset.i18n = "choose_file";
}

(function setupDropzone() {
  const dz = document.getElementById("dropzone");
  ["dragenter", "dragover"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", e => {
    if (e.dataTransfer.files.length) {
      document.getElementById("file-input").files = e.dataTransfer.files;
      onFilePicked();
    }
  });
})();

async function uploadFile() {
  const fileEl = document.getElementById("file-input");
  const status = document.getElementById("upload-status");
  const btn = document.getElementById("upload-btn");
  if (!fileEl.files[0]) { status.className = "status err"; status.textContent = t("choose_file"); return; }

  const fd = new FormData();
  fd.append("file", fileEl.files[0]);
  fd.append("title", document.getElementById("title-input").value);
  fd.append("language", document.getElementById("lang-select").value);

  btn.disabled = true;
  status.className = "status";
  status.innerHTML = `<span class="spinner"></span> ${t("uploading")}`;
  try {
    const res = await api("POST", "/api/upload", fd, { isForm: true });
    status.textContent = "";
    fileEl.value = ""; document.getElementById("title-input").value = ""; onFilePicked();
    location.hash = `#/test/${res.test_id}`;
  } catch (e) {
    status.className = "status err"; status.textContent = e.message;
  } finally { btn.disabled = false; }
}

// ---------- test page ----------

async function openTest(id, tab) {
  show("view-test");
  if (S.testId !== id || !S.data) {
    S.testId = id; S.data = null; S.results = null;
    document.getElementById("test-title").textContent = "…";
    try { S.data = await api("GET", `/api/tests/${id}`); }
    catch (e) { alert(e.message); goHome(); return; }
  }
  S.tab = ["questions", "settings", "results"].includes(tab) ? tab : "questions";
  renderTest();
}

async function reloadTest() {
  S.data = await api("GET", `/api/tests/${S.testId}`);
  renderTest();
}

function showTab(tab) { location.hash = `#/test/${S.testId}/${tab}`; }

function shareUrl() { return `${location.origin}/t/${S.data.test.share_code}`; }

function renderTest() {
  const { test, questions } = S.data;
  document.getElementById("test-title").textContent = test.title;
  document.getElementById("test-meta").innerHTML =
    `<span class="pill ${test.is_open ? "ok" : "off"}">${t(test.is_open ? "open" : "closed")}</span>
     &nbsp;${questions.length} ${t("questions_n")} · ${escapeHtml(test.filename || "")}`;
  document.getElementById("share-link").value = shareUrl();
  document.getElementById("share-open").href = shareUrl();
  document.getElementById("share-hint").textContent = questions.length ? t("share_hint") : t("share_need_questions");

  document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === S.tab));
  document.querySelectorAll(".tab").forEach(el => el.classList.toggle("hidden", el.id !== "tab-" + S.tab));

  if (S.tab === "questions") renderQuestionsTab();
  if (S.tab === "settings") renderSettings();
  if (S.tab === "results") loadResults();
}

async function copyLink(btn) {
  const url = shareUrl();
  try { await navigator.clipboard.writeText(url); }
  catch { document.getElementById("share-link").select(); document.execCommand("copy"); }
  btn.textContent = t("copied");
  setTimeout(() => { btn.textContent = t("copy"); }, 1500);
}

function qrCanvas(text, cell = 12, margin = 4) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount(), size = (n + margin * 2) * cell;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#1c1830";
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (qr.isDark(r, c)) ctx.fillRect((c + margin) * cell, (r + margin) * cell, cell, cell);
  return canvas;
}

function showQr() {
  if (!window.qrcode) return;
  const url = shareUrl();
  openModal(`
    <div class="row"><h2 style="margin:0">${escapeHtml(S.data.test.title)}</h2><span class="spacer"></span>
      <button class="small" onclick="closeModal()">✕</button></div>
    <div class="qr-box" id="qr-box"></div>
    <p class="qr-url">${escapeHtml(url)}</p>
    <p class="small muted" style="text-align:center">${t("qr_hint")}</p>
    <div class="row" style="justify-content:center">
      <a class="btn primary" id="qr-download" download="testgen-qr.png">${t("qr_download")}</a>
    </div>`);
  const canvas = qrCanvas(url);
  document.getElementById("qr-box").appendChild(canvas);
  document.getElementById("qr-download").href = canvas.toDataURL("image/png");
}

// ---------- questions tab ----------

function renderQuestionsTab() {
  const { topics, questions } = S.data;
  document.getElementById("topics-list").innerHTML = topics.map(tp => `
    <div class="topic-row">
      <div class="name">
        <div>${escapeHtml(tp.name)}</div>
        <div class="meta">${tp.questions_count} ${t("questions_n")}</div>
      </div>
      <button class="small ${tp.questions_count ? "" : "primary"}" id="gen-${tp.id}"
        onclick="generateTopic(${tp.id})">${t(tp.questions_count ? "regenerate" : "generate")}</button>
    </div>`).join("");

  const box = document.getElementById("questions-list");
  if (!questions.length) { box.innerHTML = `<div class="card muted">${t("no_questions")}</div>`; return; }

  let html = "", lastTopic = null, n = 0;
  for (const q of questions) {
    if (q.topic_name !== lastTopic) {
      html += `<div class="topic-label">${escapeHtml(q.topic_name)}</div>`;
      lastTopic = q.topic_name;
    }
    n++;
    html += S.editing === q.id ? renderEditor(q) : renderQuestionCard(q, n);
  }
  box.innerHTML = html;
}

function typePill(type) { return `<span class="pill type">${t("type_" + type)}</span>`; }

function renderQuestionCard(q, n) {
  let body = "";
  if (q.type === "multiple_choice") {
    body = `<ul class="opt-list">${q.options.map(o =>
      `<li class="${o === q.correct ? "correct" : ""}">${escapeHtml(o)}</li>`).join("")}</ul>`;
  } else if (q.type === "open") {
    body = `<ul class="opt-list"><li class="correct">${escapeHtml(q.correct)}</li></ul>`;
  } else if (q.type === "matching") {
    body = `<ul class="opt-list">${Object.entries(q.correct).map(([k, v]) =>
      `<li class="correct">${escapeHtml(k)} → ${escapeHtml(v)}</li>`).join("")}</ul>`;
  }
  return `<div class="q-card">
    <div class="q-head"><span class="meta">#${n}</span>${typePill(q.type)}<span class="spacer"></span>
      <button class="small" onclick="startEdit(${q.id})">${t("edit")}</button>
      <button class="small danger" onclick="deleteQuestion(${q.id})">${t("delete")}</button>
    </div>
    <div class="q-text">${escapeHtml(q.question)}</div>
    ${body}
  </div>`;
}

function renderEditor(q) {
  let fields = "";
  if (q.type === "multiple_choice") {
    fields = `
      <label class="field"><span>${t("options_one_per_line")}</span>
        <textarea id="e-options" rows="4">${escapeHtml(q.options.join("\n"))}</textarea></label>
      <label class="field"><span>${t("correct_answer")}</span>
        <input type="text" id="e-correct" value="${escapeHtml(q.correct)}" /></label>`;
  } else if (q.type === "open") {
    fields = `<label class="field"><span>${t("correct_answer")}</span>
      <input type="text" id="e-correct" value="${escapeHtml(q.correct)}" /></label>`;
  } else {
    const lines = Object.entries(q.correct).map(([k, v]) => `${k} = ${v}`).join("\n");
    fields = `<label class="field"><span>${t("pairs_hint")}</span>
      <textarea id="e-pairs" rows="5">${escapeHtml(lines)}</textarea></label>`;
  }
  return `<div class="q-card" style="border-color:var(--accent)">
    <div class="q-head">${typePill(q.type)}</div>
    <label class="field"><span>${t("question_text")}</span>
      <textarea id="e-question" rows="3">${escapeHtml(q.question)}</textarea></label>
    ${fields}
    <div class="row end">
      <span class="status err" id="e-status" style="margin:0"></span>
      <button onclick="cancelEdit()">${t("cancel")}</button>
      <button class="primary" onclick="saveEdit(${q.id})">${t("save")}</button>
    </div>
  </div>`;
}

function startEdit(id) { S.editing = id; renderQuestionsTab(); }
function cancelEdit() { S.editing = null; renderQuestionsTab(); }

async function saveEdit(id) {
  const q = S.data.questions.find(x => x.id === id);
  const body = { type: q.type, question: document.getElementById("e-question").value.trim() };
  if (q.type === "multiple_choice") {
    body.options = document.getElementById("e-options").value.split("\n").map(s => s.trim()).filter(Boolean);
    body.correct = document.getElementById("e-correct").value.trim();
  } else if (q.type === "open") {
    body.correct = document.getElementById("e-correct").value.trim();
  } else {
    const pairs = {};
    document.getElementById("e-pairs").value.split("\n").forEach(line => {
      const i = line.indexOf("=");
      if (i > 0) pairs[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    });
    body.correct = pairs;
    body.options = { left: Object.keys(pairs), right: Object.values(pairs) };
  }
  try {
    await api("PUT", `/api/questions/${id}`, body);
    S.editing = null;
    await reloadTest();
  } catch (e) { document.getElementById("e-status").textContent = e.message; }
}

async function deleteQuestion(id) {
  if (!confirm(t("confirm_delete_q"))) return;
  try { await api("DELETE", `/api/questions/${id}`); await reloadTest(); }
  catch (e) { alert(e.message); }
}

async function generateTopic(topicId, { silent = false } = {}) {
  const topic = S.data.topics.find(x => x.id === topicId);
  if (!silent && topic.questions_count && !confirm(t("confirm_regenerate"))) return;
  const btn = document.getElementById("gen-" + topicId);
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> ${t("generating")}`; }
  try {
    await api("POST", `/api/topics/${topicId}/generate`, { count: Number(document.getElementById("gen-count").value) });
    await reloadTest();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = t("generate"); }
    if (!silent) alert(e.message);
    throw e;
  }
}

async function generateAll() {
  const btn = document.getElementById("gen-all-btn");
  btn.disabled = true;
  const todo = S.data.topics.filter(tp => !tp.questions_count);
  const targets = todo.length ? todo : S.data.topics;
  if (!todo.length && !confirm(t("confirm_regenerate"))) { btn.disabled = false; return; }
  let failed = 0;
  for (const tp of targets) {
    try { await generateTopic(tp.id, { silent: true }); } catch { failed++; }
  }
  btn.disabled = false;
  if (failed) alert(`${t("err_ai_empty")} (${failed})`);
}

// ---------- settings tab ----------

function renderSettings() {
  const x = S.data.test;
  document.getElementById("s-title").value = x.title;
  document.getElementById("s-open").checked = !!x.is_open;
  document.getElementById("s-time").value = x.time_limit;
  document.getElementById("s-limit").value = x.question_limit;
  document.getElementById("s-shuffle").checked = !!x.shuffle;
  document.getElementById("s-show").checked = !!x.show_answers;
  document.getElementById("settings-status").textContent = "";
}

async function saveSettings(e) {
  e.preventDefault();
  const status = document.getElementById("settings-status");
  try {
    await api("PATCH", `/api/tests/${S.testId}`, {
      title: document.getElementById("s-title").value.trim(),
      is_open: document.getElementById("s-open").checked,
      time_limit: Number(document.getElementById("s-time").value) || 0,
      question_limit: Number(document.getElementById("s-limit").value) || 0,
      shuffle: document.getElementById("s-shuffle").checked,
      show_answers: document.getElementById("s-show").checked,
    });
    await reloadTest();
    status.className = "status ok"; status.textContent = t("saved");
  } catch (err) { status.className = "status err"; status.textContent = err.message; }
}

async function download(kind) {
  try {
    const r = await api("GET", `/api/tests/${S.testId}/export/${kind}`, null, { raw: true });
    const blob = await r.blob();
    const cd = r.headers.get("Content-Disposition") || "";
    const m = cd.match(/filename\*=UTF-8''(.+)$/);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = m ? decodeURIComponent(m[1]) : `export-${kind}`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch (e) { alert(e.message); }
}

async function deleteTest() {
  if (!confirm(t("confirm_delete"))) return;
  try { await api("DELETE", `/api/tests/${S.testId}`); S.testId = null; S.data = null; goHome(); }
  catch (e) { alert(e.message); }
}

// ---------- results tab ----------

async function loadResults() {
  const box = document.getElementById("results-body");
  box.innerHTML = `<div class="status"><span class="spinner"></span></div>`;
  try {
    S.results = await api("GET", `/api/tests/${S.testId}/results`);
    renderResults();
  } catch (e) { box.innerHTML = `<div class="status err">${escapeHtml(e.message)}</div>`; }
}

const GRADE_ORDER = ["A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "F"];

function gradeFromPercent(p) {
  const cut = [95, 90, 85, 80, 75, 70, 65, 60, 55, 50, 0];
  return GRADE_ORDER[cut.findIndex(c => p >= c)];
}

function renderResults() {
  CHARTS.forEach(c => c.destroy()); CHARTS = [];
  const box = document.getElementById("results-body");
  const { attempts, question_stats } = S.results;
  if (!attempts.length) { box.innerHTML = `<div class="card muted">${t("no_results")}</div>`; return; }

  const avg = attempts.reduce((s, a) => s + a.percent, 0) / attempts.length;
  const avgGrade = gradeFromPercent(avg);
  box.innerHTML = `
    <div class="stats">
      <div class="stat"><div class="v">${attempts.length}</div><div class="l">${t("stat_attempts")}</div></div>
      <div class="stat"><div class="v">${Math.round(avg)}%</div><div class="l">${t("stat_avg")}</div></div>
      <div class="stat"><div class="v">${avgGrade}</div><div class="l">${t("stat_avg_grade")} · ${gradeText(avgGrade)}</div></div>
    </div>
    <div class="charts">
      <div class="card"><h3>${t("chart_grades")}</h3><div class="chart-box"><canvas id="chart-grades"></canvas></div></div>
      <div class="card"><h3>${t("chart_hard")}</h3><div class="chart-box"><canvas id="chart-hard"></canvas></div></div>
    </div>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>${t("col_name")}</th><th>${t("col_group")}</th><th>${t("col_score")}</th><th>%</th>
          <th>${t("col_grade")}</th><th>${t("col_time")}</th><th>${t("col_date")}</th><th></th></tr></thead>
        <tbody>${attempts.map(a => `<tr>
          <td>${escapeHtml(a.student_name)}</td>
          <td>${escapeHtml(a.student_group || "—")}</td>
          <td>${a.score}/${a.total}</td>
          <td>${Math.round(a.percent)}%</td>
          <td><span class="grade g-${a.grade[0]}">${a.grade}</span></td>
          <td>${fmtDuration(a.duration_sec)}</td>
          <td>${new Date(a.taken_at).toLocaleString()}</td>
          <td><button class="small" onclick="viewAttempt(${a.id})">${t("view")}</button>
              <button class="small danger" onclick="deleteAttempt(${a.id})">×</button></td>
        </tr>`).join("")}</tbody>
      </table>
    </div>`;
  if (window.Chart) drawCharts(attempts, question_stats);
}

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function drawCharts(attempts, stats) {
  const accent = cssVar("--accent"), muted = cssVar("--muted"), grid = cssVar("--border");
  const axis = { ticks: { color: muted }, grid: { color: grid }, border: { display: false } };
  const base = { maintainAspectRatio: false, plugins: { legend: { display: false } } };

  const counts = GRADE_ORDER.map(g => attempts.filter(a => a.grade === g).length);
  CHARTS.push(new Chart(document.getElementById("chart-grades"), {
    type: "bar",
    data: { labels: GRADE_ORDER, datasets: [{ label: t("students"), data: counts, backgroundColor: accent,
      borderRadius: 8, maxBarThickness: 32 }] },
    options: { ...base, scales: { x: { ...axis, grid: { display: false } },
      y: { ...axis, beginAtZero: true, ticks: { color: muted, precision: 0 } } } },
  }));

  const hard = stats.slice(0, 8);
  CHARTS.push(new Chart(document.getElementById("chart-hard"), {
    type: "bar",
    data: { labels: hard.map(s => s.question.length > 26 ? s.question.slice(0, 26) + "…" : s.question),
      datasets: [{ label: "%", data: hard.map(s => s.percent), backgroundColor: accent,
        borderRadius: 8, maxBarThickness: 18 }] },
    options: { ...base, indexAxis: "y",
      plugins: { legend: { display: false },
        tooltip: { callbacks: { title: items => hard[items[0].dataIndex].question, label: c => ` ${c.parsed.x}%` } } },
      scales: { x: { ...axis, min: 0, max: 100 }, y: { ...axis, grid: { display: false } } } },
  }));
}

async function viewAttempt(id) {
  try {
    const a = await api("GET", `/api/attempts/${id}`);
    const items = a.details.map((d, i) => {
      const cls = d.points >= 1 ? "ok" : d.points > 0 ? "part" : "";
      return `<div class="review-item ${cls}">
        <div><strong>${i + 1}.</strong> ${escapeHtml(d.question)}</div>
        <div class="ua">${t("your_answer")}: ${escapeHtml(formatAnswer(d.user))}</div>
        ${d.points < 1 ? `<div class="ca">✓ ${escapeHtml(formatAnswer(d.correct))}</div>` : ""}
      </div>`;
    }).join("");
    openModal(`
      <div class="row"><h2 style="margin:0">${escapeHtml(a.student_name)}</h2><span class="spacer"></span>
        <button class="small" onclick="closeModal()">✕</button></div>
      <p class="meta">${escapeHtml(a.student_group || "")} · ${a.score}/${a.total} · ${Math.round(a.percent)}% ·
        <span class="grade g-${a.grade[0]}">${a.grade}</span> (${gradeText(a.grade)})</p>
      ${items}`);
  } catch (e) { alert(e.message); }
}

async function deleteAttempt(id) {
  if (!confirm(t("confirm_delete_attempt"))) return;
  try { await api("DELETE", `/api/attempts/${id}`); loadResults(); }
  catch (e) { alert(e.message); }
}

function openModal(html) {
  document.getElementById("modal-root").innerHTML =
    `<div class="modal-bg" onclick="if(event.target===this)closeModal()"><div class="modal">${html}</div></div>`;
}
function closeModal() { document.getElementById("modal-root").innerHTML = ""; }
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

applyI18n();
route();
