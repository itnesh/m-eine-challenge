import { createStore } from "./store.js";

const PEOPLE = ["Ueli", "Pirmin", "Eric", "Terry", "Markus", "Sinthu", "Matthias", "Gui", "Fabio", "Elias"];
const GAMES = ["ABCD-Jagd", "Stadt–Land–Fluss", "Stiller Held"];
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVW".split("");
const SESSION_KEY = "m-eine-challenge-user-v5";
const TEAM_KEY = "m-eine-challenge-team-v5";

const app = document.querySelector("#app");
const loginScreen = document.querySelector("#login-screen");
let state = freshState();
let store = null;
let connected = false;
let unsubscribe = null;
let teamCode = readTeamCode();
const userStorage = new URLSearchParams(location.search).has("mock") ? sessionStorage : localStorage;
let currentUser = safeGet(userStorage, SESSION_KEY) || "";
let activeView = "home";
let inGame = false;
let localTerms = {};
let localTermTimes = {};
let localAbcdTerms = {};
let localAbcdTimes = {};
let localRoundId = "";
let timerHandle = null;
let lastRenderedKey = "";
let draftTimer = null;
const remoteMode = true;

function safeGet(storage, key) {
  try { return storage.getItem(key); } catch { return null; }
}

function safeSet(storage, key, value) {
  try { value === null ? storage.removeItem(key) : storage.setItem(key, value); } catch { /* ignore */ }
}

function readTeamCode() {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get("team");
  if (fromUrl) {
    safeSet(localStorage, TEAM_KEY, fromUrl.trim());
    params.delete("team");
    const query = params.toString();
    history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
  }
  return safeGet(localStorage, TEAM_KEY) || "";
}

function freshState() {
  return {
    version: 1,
    members: {},
    history: [],
    current: {
      id: `week-${Date.now()}`,
      date: today(),
      game: "ABCD-Jagd",
      host: "Ueli",
      phase: "lobby",
      letters: [],
      letter: null,
      categories: ["Stadt", "Land", "Fluss"],
      startedAt: null,
      endedAt: null,
      finisher: null,
      drafts: {},
      reviews: {},
      votes: {},
      tieCandidates: [],
      results: null,
      draw: { game: null, host: null }
    }
  };
}

function normalizeState(data) {
  const base = freshState();
  const next = { ...base, ...(data || {}) };
  next.members = next.members || {};
  next.history = Array.isArray(next.history) ? next.history : [];
  next.current = { ...base.current, ...(next.current || {}) };
  ["drafts", "reviews", "votes"].forEach(key => { next.current[key] = next.current[key] || {}; });
  next.current.draw = next.current.draw || { game: null, host: null };
  return next;
}

function deepMerge(target, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key])) target[key] = {};
      deepMerge(target[key], value);
    } else target[key] = value;
  }
  return target;
}

function reportError(error) {
  console.error(error);
  if (error?.code === "permission-denied") {
    showToast("Teamcode ungültig");
    resetTeam();
    return;
  }
  showToast("Verbindungsproblem – bitte Seite neu laden");
}

// Ganze Zustandsänderung als Transaktion (Spielleitung, Phasenwechsel)
function mutate(mutator) {
  if (!store) return;
  store.transact(raw => {
    const next = normalizeState(raw);
    if (mutator(next) === false) return false;
    Object.keys(raw).forEach(key => delete raw[key]);
    Object.assign(raw, next);
  }).catch(reportError);
}

// Kleine Feld-Updates (Eingaben, Stimmen, Präsenz)
function syncPatch(patch, { rerender = true } = {}) {
  if (!store) return;
  state = normalizeState(deepMerge(structuredClone(state), patch));
  if (rerender) render();
  store.patch(patch).catch(reportError);
}

function renderKey() {
  return `${state.current.id}|${state.current.phase}|${state.current.game}|${state.current.letter}|${(state.current.letters || []).join("")}`;
}

function onRemoteState(data) {
  state = normalizeState(data);
  connected = true;
  const typing = document.activeElement?.matches("[data-term-cat],[data-abcd-term],#new-category");
  if (typing && renderKey() === lastRenderedKey) return;
  render();
}

async function connect() {
  unsubscribe?.();
  connected = false;
  if (!teamCode) return renderLogin();
  try {
    store = await createStore(teamCode, freshState);
    unsubscribe = store.subscribe(onRemoteState, reportError);
    if (currentUser) markPresent(currentUser);
  } catch (error) {
    reportError(error);
  }
}

function resetTeam() {
  unsubscribe?.();
  unsubscribe = null;
  store = null;
  connected = false;
  teamCode = "";
  safeSet(localStorage, TEAM_KEY, null);
  render();
}

setInterval(() => { if (currentUser && store) markPresent(currentUser); }, 5 * 60 * 1000);


function today() {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(value) {
  return new Intl.DateTimeFormat("de-CH", { day: "2-digit", month: "long", year: "numeric" }).format(new Date(`${value}T12:00:00`));
}

function formatWeekRange(value = today()) {
  const date = new Date(`${value}T12:00:00`);
  const monday = new Date(date);
  monday.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const shortYear = String(sunday.getFullYear()).slice(-2);
  const start = monday.getMonth() === sunday.getMonth()
    ? `${monday.getDate()}.`
    : `${monday.getDate()}.${monday.getMonth() + 1}.`;
  return `${start}–${sunday.getDate()}.${sunday.getMonth() + 1}.${shortYear}`;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function initials(name) {
  return name.slice(0, 2).toUpperCase();
}

function playerNames() {
  return PEOPLE;
}

function isHost() {
  return currentUser === state.current.host;
}

function phaseLabel() {
  return ({ lobby: "Warteraum", play: "Läuft gerade", review: "Auswertung", results: "Resultate", draw: "Auslosung" })[state.current.phase] || "Diese Woche";
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2400);
}

function markPresent(name) {
  syncPatch({ members: { [name]: { lastSeen: Date.now() } } }, { rerender: false });
}

function activePeople() {
  const cutoff = Date.now() - 1000 * 60 * 60;
  return PEOPLE.filter(person => (state.members[person]?.lastSeen || 0) > cutoff);
}

function login(name) {
  currentUser = name;
  safeSet(userStorage, SESSION_KEY, name);
  markPresent(name);
  loginScreen.classList.add("hidden");
  render();
}

function logout() {
  currentUser = "";
  safeSet(userStorage, SESSION_KEY, null);
  inGame = false;
  render();
}

function renderLogin() {
  const grid = document.querySelector("#login-grid");
  const title = document.querySelector("#login-title");
  const intro = document.querySelector("#login-intro");
  if (!teamCode) {
    title.textContent = "Teamcode";
    intro.textContent = "Gib den Teamcode ein, den du von der Spielleitung erhalten hast.";
    grid.innerHTML = `<form class="team-form" id="team-form"><input id="team-input" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Teamcode" required><button class="button primary" type="submit">Weiter</button></form>`;
    return;
  }
  title.textContent = "Wer bist du?";
  intro.textContent = "Wähle deinen Namen. So weiss die Challenge, wer spielt und wer diese Woche leitet.";
  grid.innerHTML = connected ? PEOPLE.map(person => `
    <button class="login-person ${person === state.current.host ? "host" : ""}" type="button" data-login="${esc(person)}">
      <span class="avatar">${initials(person)}</span><span>${esc(person)}</span>
    </button>`).join("") + `<button class="login-reset" type="button" data-team-reset>Anderen Teamcode verwenden</button>` : `<p class="login-wait">Verbinde mit dem Team …</p>`;
}

document.querySelector("#login-grid").addEventListener("click", event => {
  const button = event.target.closest("[data-login]");
  if (button) login(button.dataset.login);
  if (event.target.closest("[data-team-reset]")) resetTeam();
});

document.querySelector("#login-grid").addEventListener("submit", event => {
  event.preventDefault();
  const value = document.querySelector("#team-input")?.value.trim();
  if (!value) return;
  teamCode = value;
  safeSet(localStorage, TEAM_KEY, value);
  render();
  connect();
});

document.querySelectorAll("[data-nav]").forEach(button => {
  button.addEventListener("click", () => {
    activeView = button.dataset.nav;
    inGame = false;
    render();
  });
});

document.querySelector("#user-area").addEventListener("click", event => {
  if (event.target.closest("[data-logout]")) logout();
});

function renderHeader() {
  document.querySelectorAll(".nav-link").forEach(link => link.classList.toggle("active", link.dataset.nav === activeView));
  document.querySelector("#user-area").innerHTML = currentUser ? `
    <button class="user-pill" type="button" data-logout title="Abmelden">
      <span class="avatar">${initials(currentUser)}</span><span>${esc(currentUser)}</span><i class="online-dot"></i>
    </button>` : "";
}

function render() {
  clearInterval(timerHandle);
  renderHeader();
  lastRenderedKey = renderKey();
  if (!currentUser || !teamCode || !connected) {
    renderLogin();
    loginScreen.classList.remove("hidden");
    app.innerHTML = "";
    return;
  }
  loginScreen.classList.add("hidden");
  if (activeView === "leaderboard") renderLeaderboardPage();
  else if (activeView === "history") renderHistoryPage();
  else if (activeView === "rules") renderRulesPage();
  else if (inGame) renderGame();
  else renderHome();
  startVisibleTimer();
}

function renderHome() {
  const online = activePeople();
  const phase = state.current.phase;
  const actionLabel = phase === "lobby" ? (isHost() ? "Challenge als Spielleitung öffnen" : "Warteraum öffnen") : "Zur laufenden Challenge";
  app.innerHTML = `
    <section class="hero-week panel">
      <div>
        <p class="eyebrow">DIESE WOCHE · ${formatWeekRange(state.current.date)}</p>
        <h1 class="week-line"><span class="game-name">${esc(state.current.game)}</span><small>von ${esc(state.current.host)}</small></h1>
        <p class="lead">${phase === "lobby" ? "Alle loggen sich ein. Sobald das Team bereit ist, startet die Spielleitung die Challenge für alle gleichzeitig." : "Die Challenge ist bereits geöffnet. Steig direkt wieder ein."}</p>
        <div class="button-row"><button class="button primary large" type="button" data-action="enter-game">${actionLabel}</button></div>
        <div class="status-strip">
          <span class="status-chip ${phase === "play" ? "live" : "wait"}">${phaseLabel()}</span>
          <span class="status-chip"><i class="online-dot"></i>${online.length} von ${PEOPLE.length} eingeloggt</span>
          <span class="status-chip ${connected ? "live" : ""}">${connected ? (store?.mode === "mock" ? "Testmodus (lokal)" : "Live verbunden") : "Verbinde …"}</span>
          <span class="status-chip">Eine Challenge pro Woche</span>
        </div>
      </div>
      <aside class="host-card">
        <div class="host-avatar">${initials(state.current.host)}</div>
        <span>Spielleitung</span><strong>${esc(state.current.host)}</strong>
        <p>Nur die Spielleitung kann starten, bewerten und die Resultate abschliessen.</p>
      </aside>
    </section>
    <div class="section-heading"><div><p class="eyebrow">TEAM</p><h2>Wer ist schon da?</h2></div><p>Jede Person spielt mit dem eigenen Login. Über den Team-Server werden alle Geräte sofort synchronisiert.</p></div>
    ${renderPeopleGrid(online)}
    ${phase === "lobby" && state.history.length === 0 ? renderFirstWeekSetup() : ""}`;
}

function renderPeopleGrid(online = activePeople()) {
  return `<div class="people-grid">${PEOPLE.map(person => `
    <div class="person-tile ${online.includes(person) ? "online" : "offline"}">
      <span class="avatar">${initials(person)}</span><span>${esc(person)}${person === state.current.host ? " · Leitung" : ""}</span><i class="presence"></i>
    </div>`).join("")}</div>`;
}

function renderFirstWeekSetup() {
  return `<div class="section-heading"><div><p class="eyebrow">ERSTE WOCHE</p><h2>Startkonfiguration</h2></div><div class="setup-fields"><label>Spiel dieser Woche
    <select data-action="change-current-game">${GAMES.map(game => `<option ${game === state.current.game ? "selected" : ""}>${game}</option>`).join("")}</select>
  </label><label>Spielleitung
    <select data-action="change-current-host">${PEOPLE.map(person => `<option ${person === state.current.host ? "selected" : ""}>${person}</option>`).join("")}</select>
  </label></div></div>`;
}

app.addEventListener("click", event => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!action) return;
  if (action === "enter-game") { inGame = true; render(); }
  if (action === "back-home") { inGame = false; render(); }
  if (action === "start-abcd") startAbcd();
  if (action === "add-category") addCategory();
  if (action === "remove-category") removeCategory(event.target.closest("[data-index]").dataset.index);
  if (action === "draw-letter") drawSlfLetter();
  if (action === "start-slf") startSlf();
  if (action === "start-hero") startHero();
  if (action === "vote-hero") voteHero(event.target.closest("[data-person]").dataset.person);
  if (action === "close-hero") closeHeroVote();
  if (action === "tie-winner") finishHero(event.target.closest("[data-person]").dataset.person);
  if (action === "review-score") updateMatrixScore(event.target.closest("[data-review-game]"));
  if (action === "confirm-round") confirmCompletedRound();
  if (action === "calculate-results") calculateResults();
  if (action === "open-draw") mutate(next => { next.current.phase = "draw"; });
  if (action === "draw-game") drawNext("game");
  if (action === "draw-host") drawNext("host");
  if (action === "save-next-week") saveNextWeek();
});

app.addEventListener("change", event => {
  if (event.target.matches("[data-action='change-current-game']")) {
    mutate(next => {
      next.current.game = event.target.value;
      next.current.categories = ["Stadt", "Land", "Fluss"];
      next.current.letter = null;
    });
  }
  if (event.target.matches("[data-action='change-current-host']")) {
    mutate(next => {
      if (next.history.length || next.current.phase !== "lobby") return false;
      next.current.host = event.target.value;
    });
  }
  if (event.target.matches("[data-next-host]")) {
    const person = event.target.dataset.nextHost;
    mutate(next => {
      const fallback = PEOPLE.filter(name => name !== next.current.host);
      const pool = Array.isArray(next.current.draw.hostPool) ? [...next.current.draw.hostPool] : fallback;
      next.current.draw.hostPool = event.target.checked ? [...new Set([...pool, person])] : pool.filter(name => name !== person);
      if (!next.current.draw.hostPool.includes(next.current.draw.host)) next.current.draw.host = null;
    });
  }
});

app.addEventListener("input", event => {
  if (event.target.matches("[data-abcd-term]")) {
    const letter = event.target.dataset.abcdTerm;
    localAbcdTerms[letter] = event.target.value;
    if (event.target.value.trim() && !localAbcdTimes[letter]) localAbcdTimes[letter] = Date.now();
    if (!event.target.value.trim()) delete localAbcdTimes[letter];
    saveAbcdDraft(false);
    updateRoundConfirmButton();
    return;
  }
  if (!event.target.matches("[data-term-cat]")) return;
  const category = event.target.dataset.termCat;
  localTerms[category] = event.target.value;
  if (event.target.value.trim() && !localTermTimes[category]) localTermTimes[category] = Date.now();
  if (!event.target.value.trim()) delete localTermTimes[category];
  saveSlfDraft(false);
  updateRoundConfirmButton();
});

app.addEventListener("keydown", event => {
  if (event.key === "Enter" && event.target.id === "new-category") {
    event.preventDefault();
    addCategory();
  }
  if ((event.key === "Enter" || event.key === "Tab") && event.target.matches("[data-abcd-term],[data-term-cat]")) {
    if (roundInputsComplete()) {
      event.preventDefault();
      confirmCompletedRound();
    }
  }
});

function roundInputsComplete() {
  if (state.current.game === "ABCD-Jagd") return state.current.letters.every(letter => localAbcdTerms[letter]?.trim());
  if (state.current.game === "Stadt–Land–Fluss") return state.current.categories.every(category => localTerms[category]?.trim());
  return false;
}

function updateRoundConfirmButton() {
  const button = document.querySelector("[data-action='confirm-round']");
  if (button) button.disabled = !roundInputsComplete();
}

function confirmCompletedRound() {
  if (state.current.phase !== "play" || !roundInputsComplete()) return;
  if (state.current.game === "ABCD-Jagd") saveAbcdDraft(true);
  if (state.current.game === "Stadt–Land–Fluss") saveSlfDraft(true);
}

function renderGame() {
  const phase = state.current.phase;
  if (phase === "lobby") renderLobby();
  else if (phase === "play") renderPlay();
  else if (phase === "review") renderReview();
  else if (phase === "results") renderResults();
  else renderDraw();
}

function gameTop(label, title) {
  return `<div class="game-top"><div><p class="eyebrow">${label}</p><h2>${title}</h2><span class="role-badge">${isHost() ? "Du bist die Spielleitung" : `Spielleitung: ${esc(state.current.host)}`}</span></div><button class="button ghost" type="button" data-action="back-home">Zur Startseite</button></div>`;
}

function renderLobby() {
  if (state.current.game === "Stadt–Land–Fluss") renderSlfLobby();
  else if (state.current.game === "Stiller Held") renderHeroLobby();
  else renderAbcdLobby();
}

function renderAbcdLobby() {
  const onlinePlayers = playerNames().filter(person => activePeople().includes(person));
  app.innerHTML = `<section class="panel game-shell">
    ${gameTop("ABCD-JAGD · WARTERAUM", "Drei Buchstaben. Drei Gegenstände. Los!")}
    <p class="rule-note">Alle schreiben je einen passenden Gegenstand zu den drei Buchstaben auf. Tastaturtasten zählen nicht. Sobald die erste Person alle drei Begriffe hat, endet die Sammelzeit.</p>
    <div class="section-heading"><div><h3>${onlinePlayers.length} von ${playerNames().length} Spielenden bereit</h3></div><p>Auch die Spielleitung spielt mit. Die Buchstaben erscheinen beim Start gleichzeitig auf allen Geräten.</p></div>
    ${renderPeopleGrid(activePeople())}
    <div class="section-heading"><div><p class="eyebrow">START</p><h2>${isHost() ? "Bereit, wenn ihr es seid" : `Warte auf ${esc(state.current.host)}`}</h2></div>
      ${isHost() ? `<button class="button primary large" type="button" data-action="start-abcd">3 Buchstaben anzeigen & starten</button>` : ""}
    </div>
  </section>`;
}

function startAbcd() {
  if (!isHost()) return;
  mutate(next => {
    next.current.letters = shuffle("ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")).slice(0, 3);
    next.current.startedAt = Date.now();
    next.current.endedAt = null;
    next.current.phase = "play";
    next.current.drafts = {};
    next.current.reviews = {};
  });
}

function renderPlay() {
  if (state.current.game === "Stadt–Land–Fluss") renderSlfPlay();
  else if (state.current.game === "Stiller Held") renderHeroPlay();
  else renderAbcdPlay();
}

function renderAbcdPlay() {
  if (localRoundId !== state.current.id) {
    localRoundId = state.current.id;
    localAbcdTerms = {};
    localAbcdTimes = {};
  }
  const draft = state.current.drafts[currentUser] || {};
  localAbcdTerms = { ...(draft.terms || {}), ...localAbcdTerms };
  localAbcdTimes = { ...(draft.termTimes || {}), ...localAbcdTimes };
  app.innerHTML = `<section class="panel game-shell">
    ${gameTop("ABCD-JAGD · LIVE", "Finde drei Gegenstände")}
    <div class="letter-row">${state.current.letters.map(letter => `<div class="big-letter">${letter}</div>`).join("")}</div>
    <div class="game-clock"><strong class="clock-value" data-clock>00:00.0</strong><span class="clock-label">seit dem Start</span></div>
    <p class="rule-note">Schreibe die drei Gegenstände auf. Erst mit Enter, Tab oder dem Fertig-Button stoppst du die Runde für alle.</p>
    <div class="word-grid">${state.current.letters.map(letter => `<label class="word-card"><span class="capture-letter">${letter}</span><input autocomplete="off" data-abcd-term="${letter}" value="${esc(localAbcdTerms[letter] || "")}" placeholder="Gegenstand mit ${letter}"><small>Ein konkreter Gegenstand, keine Tastaturtaste.</small></label>`).join("")}</div>
    <div class="button-row finish-row"><button class="button primary large" type="button" data-action="confirm-round" ${roundInputsComplete() ? "" : "disabled"}>Fertig – Runde stoppen</button></div>
  </section>`;
}

function saveAbcdDraft(finish) {
  clearTimeout(draftTimer);
  if (!finish) { draftTimer = setTimeout(() => saveAbcdDraftNow(false), 250); return; }
  saveAbcdDraftNow(true);
}

function saveAbcdDraftNow(finish) {
  if (state.current.phase !== "play") return;
  const draft = { terms: { ...localAbcdTerms }, termTimes: { ...localAbcdTimes }, updatedAt: Date.now() };
  if (finish) draft.completedAt = Date.now();
  const currentPatch = { drafts: { [currentUser]: draft } };
  if (finish) Object.assign(currentPatch, { endedAt: Date.now(), finisher: currentUser, phase: "review" });
  syncPatch({ current: currentPatch }, { rerender: finish });
}

function renderReview() {
  if (state.current.game === "Stadt–Land–Fluss") renderSlfReview();
  else if (state.current.game === "Stiller Held") renderHeroTie();
  else renderAbcdReview();
}

function renderAbcdReview() {
  if (!isHost()) {
    app.innerHTML = `<section class="panel game-shell">${gameTop("ABCD-JAGD · AUSWERTUNG", "Die Begriffe werden verglichen")}<div class="waiting-stage"><div><div class="waiting-pulse"></div><h3>${esc(state.current.host)} prüft die Matrix</h3><p>Danach berechnet das System die Punkte nach Wertung und Geschwindigkeit.</p></div></div></section>`;
    return;
  }
  app.innerHTML = `<section class="panel game-shell">
    ${gameTop("ABCD-JAGD · AUSWERTUNG", "Kompakte Begriffsmatrix")}
    <p class="rule-note">Leere oder falsche Begriffe erhalten ×. Ein eigener korrekter Begriff erhält ✓, ein geteilter korrekter Begriff ½.</p>
    ${renderMatrixLegend()}
    <div class="review-table-wrap"><table><thead><tr><th>Person</th>${state.current.letters.map(letter => `<th>${letter}</th>`).join("")}</tr></thead><tbody>${playerNames().map(person => `<tr><td><strong>${esc(person)}</strong></td>${state.current.letters.map(letter => renderMatrixCell("abcd",person,letter)).join("")}</tr>`).join("")}</tbody></table></div>
    <div class="review-footer"><span></span><button class="button primary large" type="button" data-action="calculate-results">Punkte berechnen</button></div>
  </section>`;
}

function renderMatrixLegend() {
  return `<div class="matrix-legend"><span><i class="mini-score full">✓</i> voll / einzigartig</span><span><i class="mini-score shared">½</i> geteilt</span><span><i class="mini-score invalid">×</i> nein oder leer</span></div>`;
}

function matrixTerm(game, person, key) {
  return state.current.drafts[person]?.terms?.[key] || "";
}

function defaultMatrixStatus(game, person, key) {
  const term = normalizedTerm(matrixTerm(game,person,key));
  if (!term) return "invalid";
  if (game === "abcd" && !term.toLocaleUpperCase("de-CH").startsWith(key)) return "invalid";
  const matches = playerNames().filter(name => normalizedTerm(matrixTerm(game,name,key)) === term).length;
  return matches > 1 ? "shared" : "full";
}

function renderMatrixCell(game, person, key) {
  const term = matrixTerm(game,person,key) || "–";
  const status = state.current.reviews[person]?.terms?.[key] || defaultMatrixStatus(game,person,key);
  return `<td class="term-cell"><span class="term-value" title="${esc(term)}">${esc(term)}</span><div class="score-buttons">
    ${[["full","✓"],["shared","½"],["invalid","×"]].map(([value,label]) => `<button class="score-button ${value} ${status === value ? "active" : ""}" type="button" data-action="review-score" data-review-game="${game}" data-person="${esc(person)}" data-key="${esc(key)}" data-status="${value}" aria-label="${esc(person)} ${esc(key)}: ${value}">${label}</button>`).join("")}
  </div></td>`;
}

function updateMatrixScore(button) {
  if (!isHost()) return;
  syncPatch({ current: { reviews: { [button.dataset.person]: { terms: { [button.dataset.key]: button.dataset.status } } } } });
}

function renderSlfLobby() {
  app.innerHTML = `<section class="panel game-shell">
    ${gameTop("STADT–LAND–FLUSS · VORBEREITUNG", "Kategorien und Buchstabe")}
    <p class="rule-note">Stadt, Land und Fluss sind fix. Die Spielleitung ergänzt weitere Spalten und dreht den Buchstaben. X, Y und Z werden nicht verwendet.</p>
    ${isHost() ? `
      <div class="category-builder"><div><span class="field-label">Kategorien</span><div class="category-list">${state.current.categories.map((category,index) => `<span class="category-chip ${index < 3 ? "locked" : ""}">${esc(category)}${index >= 3 ? `<button type="button" data-action="remove-category" data-index="${index}" aria-label="${esc(category)} entfernen">×</button>` : ""}</span>`).join("")}</div></div>
      <div><label for="new-category">Weitere Kategorie</label><div class="input-action"><input id="new-category" maxlength="30" placeholder="z. B. Beruf"><button class="button secondary" type="button" data-action="add-category">Hinzufügen</button></div></div></div>
      <div class="letter-draw"><div class="letter-orb">${state.current.letter || "?"}</div><div><h3>Buchstabenrad</h3><p>Der Buchstabe wird für alle erst beim GO sichtbar.</p><div class="button-row"><button class="button secondary" type="button" data-action="draw-letter">Buchstaben drehen</button><button class="button primary large" type="button" data-action="start-slf" ${state.current.letter ? "" : "disabled"}>GO für alle</button></div></div></div>` : `
      <div class="waiting-stage"><div><div class="waiting-pulse"></div><h3>${esc(state.current.host)} bereitet die Runde vor</h3><p>Kategorien und Buchstabe erscheinen für alle gleichzeitig, sobald es losgeht.</p></div></div>`}
  </section>`;
}

function addCategory() {
  if (!isHost()) return;
  const input = document.querySelector("#new-category");
  const value = input?.value.trim();
  if (!value) return;
  mutate(next => {
    if (!next.current.categories.some(category => category.toLowerCase() === value.toLowerCase())) next.current.categories.push(value);
  });
}

function removeCategory(index) {
  if (!isHost() || Number(index) < 3) return;
  mutate(next => next.current.categories.splice(Number(index),1));
}

function drawSlfLetter() {
  if (!isHost()) return;
  mutate(next => { next.current.letter = randomItem(LETTERS); });
}

function startSlf() {
  if (!isHost() || !state.current.letter) return;
  mutate(next => {
    next.current.phase = "play";
    next.current.startedAt = Date.now();
    next.current.endedAt = null;
    next.current.drafts = {};
    next.current.reviews = {};
  });
}

function renderHeroLobby() {
  app.innerHTML = `<section class="panel game-shell">
    ${gameTop("STILLER HELD · WARTERAUM", "Wer war diese Woche euer stiller Held?")}
    <p class="rule-note">Jede Person gibt genau eine geheime Stimme ab. Auch die Spielleitung stimmt mit. Die Person mit den meisten Stimmen erhält 6 Punkte, alle anderen 0.</p>
    <div class="section-heading"><div><h3>${activePeople().length} von ${PEOPLE.length} eingeloggt</h3></div><p>Bei einem Gleichstand entscheidet die Spielleitung zwischen den Personen mit den meisten Stimmen.</p></div>
    ${renderPeopleGrid(activePeople())}
    <div class="section-heading"><div><p class="eyebrow">START</p><h2>${isHost() ? "Abstimmung eröffnen" : `Warte auf ${esc(state.current.host)}`}</h2></div>${isHost() ? `<button class="button primary large" type="button" data-action="start-hero">Abstimmung starten</button>` : ""}</div>
  </section>`;
}

function startHero() {
  if (!isHost()) return;
  mutate(next => {
    next.current.phase = "play";
    next.current.startedAt = Date.now();
    next.current.votes = {};
    next.current.tieCandidates = [];
    next.current.results = null;
  });
}

function renderHeroPlay() {
  const selected = state.current.votes?.[currentUser] || "";
  const voteCount = Object.keys(state.current.votes || {}).length;
  app.innerHTML = `<section class="panel game-shell">
    ${gameTop("STILLER HELD · ABSTIMMUNG", "Deine Stimme zählt")}
    <p class="rule-note">Wähle genau eine Person – auch dich selbst, wenn du findest, dass du der stille Held warst. Du kannst deine Stimme bis zum Abschluss ändern.</p>
    <div class="vote-grid">${PEOPLE.map(person => `<button class="vote-card ${selected === person ? "selected" : ""}" type="button" data-action="vote-hero" data-person="${esc(person)}"><span class="avatar">${initials(person)}</span><span>${esc(person)}${person === currentUser ? " · ich" : ""}</span>${selected === person ? `<span class="check">✓</span>` : ""}</button>`).join("")}</div>
    <div class="section-heading"><div><p class="eyebrow">STATUS</p><h3>${voteCount} von ${PEOPLE.length} Stimmen abgegeben</h3></div>${isHost() ? `<button class="button primary" type="button" data-action="close-hero" ${voteCount ? "" : "disabled"}>Abstimmung schliessen</button>` : `<p>Die Resultate bleiben bis zum Abschluss geheim.</p>`}</div>
  </section>`;
}

function voteHero(person) {
  if (state.current.phase !== "play") return;
  syncPatch({ current: { votes: { [currentUser]: person } } });
}

function closeHeroVote() {
  if (!isHost()) return;
  const totals = PEOPLE.reduce((result,person) => ({ ...result, [person]: 0 }),{});
  Object.values(state.current.votes || {}).forEach(person => { if (person in totals) totals[person] += 1; });
  const max = Math.max(...Object.values(totals));
  const candidates = PEOPLE.filter(person => totals[person] === max && max > 0);
  if (candidates.length === 1) finishHero(candidates[0]);
  else mutate(next => {
    next.current.phase = "review";
    next.current.endedAt = Date.now();
    next.current.tieCandidates = candidates;
  });
}

function renderHeroTie() {
  const totals = PEOPLE.reduce((result,person) => ({ ...result, [person]: 0 }),{});
  Object.values(state.current.votes || {}).forEach(person => { if (person in totals) totals[person] += 1; });
  if (!isHost()) {
    app.innerHTML = `<section class="panel game-shell">${gameTop("STILLER HELD · STECHEN", "Gleichstand")}<div class="waiting-stage"><div><div class="waiting-pulse"></div><h3>${esc(state.current.host)} entscheidet</h3><p>Mehrere Personen haben gleich viele Stimmen erhalten.</p></div></div></section>`;
    return;
  }
  app.innerHTML = `<section class="panel game-shell">${gameTop("STILLER HELD · STECHEN", "Die Spielleitung entscheidet")}<p class="rule-note">Diese Personen haben gleich viele Stimmen. Wähle den stillen Helden dieser Woche.</p><div class="vote-grid">${state.current.tieCandidates.map(person => `<button class="vote-card" type="button" data-action="tie-winner" data-person="${esc(person)}"><span class="avatar">${initials(person)}</span><span>${esc(person)}</span><strong>${totals[person]} Stimmen</strong></button>`).join("")}</div></section>`;
}

function finishHero(winner) {
  if (!isHost()) return;
  mutate(next => {
    const totals = PEOPLE.reduce((result,person) => ({ ...result, [person]: 0 }),{});
    Object.values(next.current.votes || {}).forEach(person => { if (person in totals) totals[person] += 1; });
    next.current.results = PEOPLE.map(person => ({ person, points: person === winner ? 6 : 0, raw: totals[person], rank: person === winner ? 1 : 2, detail: `${totals[person]} ${totals[person] === 1 ? "Stimme" : "Stimmen"}` })).sort((a,b) => b.points-a.points || b.raw-a.raw || a.person.localeCompare(b.person));
    next.current.endedAt = Date.now();
    next.current.phase = "results";
  });
}

function renderSlfPlay() {
  const draft = state.current.drafts[currentUser]?.terms || {};
  if (localRoundId !== state.current.id) {
    localRoundId = state.current.id;
    localTerms = {};
    localTermTimes = {};
  }
  localTerms = { ...draft, ...localTerms };
  localTermTimes = { ...(state.current.drafts[currentUser]?.termTimes || {}), ...localTermTimes };
  app.innerHTML = `<section class="panel game-shell">
    ${gameTop("STADT–LAND–FLUSS · LIVE", `Buchstabe ${state.current.letter}`)}
    <div class="letter-draw"><div class="letter-orb">${state.current.letter}</div><div class="game-clock"><strong class="clock-value" data-clock>00:00.0</strong><span class="clock-label">seit dem Start</span></div></div>
    <p class="rule-note">Auch die Spielleitung spielt mit. Erst mit Enter, Tab oder dem Fertig-Button bestätigst du den letzten Begriff und stoppst die Runde.</p><div class="terms-form">${state.current.categories.map(category => `<label>${esc(category)}<input autocomplete="off" data-term-cat="${esc(category)}" value="${esc(localTerms[category] || "")}" placeholder="Begriff mit ${state.current.letter}"></label>`).join("")}</div>
    <div class="button-row finish-row"><button class="button primary large" type="button" data-action="confirm-round" ${roundInputsComplete() ? "" : "disabled"}>Fertig – Runde stoppen</button></div>
  </section>`;
}

function saveSlfDraft(finish) {
  clearTimeout(draftTimer);
  if (!finish) { draftTimer = setTimeout(() => saveSlfDraftNow(false), 250); return; }
  saveSlfDraftNow(true);
}

function saveSlfDraftNow(finish) {
  if (state.current.phase !== "play") return;
  const draft = { terms: { ...localTerms }, termTimes: { ...localTermTimes }, updatedAt: Date.now() };
  if (finish) draft.completedAt = Date.now();
  const currentPatch = { drafts: { [currentUser]: draft } };
  if (finish) Object.assign(currentPatch, { endedAt: Date.now(), finisher: currentUser, phase: "review" });
  syncPatch({ current: currentPatch }, { rerender: finish });
}

function renderSlfReview() {
  if (!isHost()) {
    app.innerHTML = `<section class="panel game-shell">${gameTop("STADT–LAND–FLUSS · AUSWERTUNG", "Begriffe werden verglichen")}<div class="waiting-stage"><div><div class="waiting-pulse"></div><h3>${esc(state.current.host)} prüft die Matrix</h3><p>Einzigartige und geteilte Begriffe werden erkannt. Die Spielleitung kann jede Wertung korrigieren.</p></div></div></section>`;
    return;
  }
  app.innerHTML = `<section class="panel game-shell">
    ${gameTop("STADT–LAND–FLUSS · AUSWERTUNG", "Die gemeinsame Begriffsmatrix")}
    <p class="rule-note">Das System markiert gleiche Begriffe automatisch. Die Spielleitung korrigiert kompakt mit ✓, ½ oder ×.</p>
    ${renderMatrixLegend()}
    <div class="review-table-wrap"><table><thead><tr><th>Person</th>${state.current.categories.map(category => `<th>${esc(category)}</th>`).join("")}</tr></thead><tbody>${playerNames().map(person => `<tr><td><strong>${esc(person)}</strong></td>${state.current.categories.map(category => renderMatrixCell("slf",person,category)).join("")}</tr>`).join("")}</tbody></table></div>
    <div class="review-footer"><span></span><button class="button primary large" type="button" data-action="calculate-results">Punkte berechnen</button></div>
  </section>`;
}

function normalizedTerm(value) {
  return String(value || "").trim().toLocaleLowerCase("de-CH").replace(/[.!?,;:]+$/g, "");
}

function defaultTermStatus(person, category) {
  const term = normalizedTerm(state.current.drafts[person]?.terms?.[category]);
  if (!term) return "invalid";
  const matches = playerNames().filter(name => normalizedTerm(state.current.drafts[name]?.terms?.[category]) === term).length;
  return matches > 1 ? "shared" : "full";
}

function calculateResults() {
  if (!isHost()) return;
  mutate(next => {
    const round = next.current;
    const entries = round.game === "Stadt–Land–Fluss" ? scoreSlf(round) : scoreAbcd(round);
    round.results = rankEntries(entries);
    round.phase = "results";
  });
}

function scoreAbcd(round) {
  const duration = Math.max((round.endedAt - round.startedAt) / 1000, 1);
  return PEOPLE.map(person => {
    let full = 0, shared = 0, speed = 0;
    round.letters.forEach(letter => {
      const status = round.reviews[person]?.terms?.[letter] || defaultMatrixStatusForRound(round,"abcd",person,letter);
      if (status === "full") full += 1;
      if (status === "shared") shared += 1;
      if (status !== "invalid") {
        const termTime = round.drafts[person]?.termTimes?.[letter];
        if (termTime) speed += Math.max(0, 1 - (termTime-round.startedAt)/1000/duration) * .25;
      }
    });
    const elapsed = round.drafts[person]?.completedAt ? (round.drafts[person].completedAt - round.startedAt) / 1000 : duration + 999;
    return { person, raw: full + shared*.5 + speed, elapsed, detail: `${full} voll · ${shared} geteilt${elapsed < duration+999 ? ` · ${formatSeconds(elapsed)}` : ""}` };
  });
}

function scoreSlf(round) {
  const duration = Math.max((round.endedAt - round.startedAt) / 1000, 1);
  return PEOPLE.map(person => {
    let full = 0, shared = 0, speed = 0;
    round.categories.forEach(category => {
      const status = round.reviews[person]?.terms?.[category] || defaultTermStatusForRound(round,person,category);
      if (status === "full") full += 1;
      if (status === "shared") shared += 1;
      if (status !== "invalid") {
        const termTime = round.drafts[person]?.termTimes?.[category];
        if (termTime) speed += Math.max(0, 1 - (termTime - round.startedAt) / 1000 / duration) * .5;
      }
    });
    const completedAt = round.drafts[person]?.completedAt;
    const elapsed = completedAt ? (completedAt - round.startedAt) / 1000 : duration + 999;
    return { person, raw: full + shared*.5 + speed, elapsed, detail: `${full} voll · ${shared} geteilt${completedAt ? ` · ${formatSeconds(elapsed)}` : ""}` };
  });
}

function defaultTermStatusForRound(round, person, category) {
  const term = normalizedTerm(round.drafts[person]?.terms?.[category]);
  if (!term) return "invalid";
  const matches = PEOPLE.filter(name => normalizedTerm(round.drafts[name]?.terms?.[category]) === term).length;
  return matches > 1 ? "shared" : "full";
}

function defaultMatrixStatusForRound(round, game, person, key) {
  const term = normalizedTerm(round.drafts[person]?.terms?.[key]);
  if (!term) return "invalid";
  if (game === "abcd" && !term.toLocaleUpperCase("de-CH").startsWith(key)) return "invalid";
  const matches = PEOPLE.filter(name => normalizedTerm(round.drafts[name]?.terms?.[key]) === term).length;
  return matches > 1 ? "shared" : "full";
}

function rankEntries(entries) {
  const sorted = [...entries].sort((a,b) => b.raw - a.raw || a.elapsed - b.elapsed || a.person.localeCompare(b.person));
  let priorRaw = null;
  let priorPoints = 0;
  return sorted.map((entry,index) => {
    let points = entry.raw <= 0 ? 0 : Math.max(6-index,0);
    if (priorRaw !== null && Math.abs(entry.raw-priorRaw) < .001) points = priorPoints;
    priorRaw = entry.raw;
    priorPoints = points;
    return { ...entry, points, rank: index+1 };
  });
}

function renderResults() {
  const results = state.current.results || [];
  const top = results.filter(entry => entry.points > 0).slice(0,3);
  app.innerHTML = `<section class="panel results-hero">
    ${gameTop("RESULTAT VON HEUTE", state.current.game)}
    <div class="podium">${top.map((entry,index) => `<div class="podium-item ${["first","second","third"][index]}"><span class="podium-rank">PLATZ ${index+1}</span><span class="podium-name">${esc(entry.person)}</span><span class="podium-points">${entry.points} Punkte</span></div>`).join("")}</div>
    ${renderScoreList(results)}
    ${isHost() ? `<div class="review-footer"><span></span><button class="button primary large" type="button" data-action="open-draw">Auslosung für nächste Woche</button></div>` : `<p class="rule-note">Die Spielleitung startet gleich die Auslosung für nächste Woche.</p>`}
  </section>
  <section class="evergreen"><div class="section-heading"><div><p class="eyebrow">EVERGREEN</p><h2>Gesamtrangliste</h2></div><p>Heute ist bereits eingerechnet.</p></div>${renderScoreList(evergreenScores(true))}</section>`;
}

function renderScoreList(scores) {
  return `<div class="score-list">${scores.map((entry,index) => `<div class="score-row"><span class="rank">${String(index+1).padStart(2,"0")}</span><strong>${esc(entry.person)}<small>${esc(entry.detail || `${entry.games || 0} Spiele`)}</small></strong><span class="points">${entry.points} Pkt.</span></div>`).join("")}</div>`;
}

function evergreenScores(includeCurrent = false) {
  const totals = PEOPLE.map(person => ({ person, points: 0, games: 0 }));
  state.history.forEach(week => (week.scores || []).forEach(score => {
    const item = totals.find(total => total.person === score.person);
    item.points += Number(score.points || 0);
    item.games += 1;
  }));
  if (includeCurrent && state.current.results) state.current.results.forEach(score => {
    const item = totals.find(total => total.person === score.person);
    item.points += Number(score.points || 0);
    item.games += 1;
  });
  return totals.sort((a,b) => b.points-a.points || a.person.localeCompare(b.person)).map((item,index) => ({ ...item, rank:index+1, detail:`${item.games} ${item.games === 1 ? "Spiel" : "Spiele"}` }));
}

function renderDraw() {
  const draw = state.current.draw || { game:null, host:null };
  const gameChoices = GAMES.filter(game => game !== state.current.game);
  const hostPool = Array.isArray(draw.hostPool) ? draw.hostPool : PEOPLE.filter(person => person !== state.current.host);
  app.innerHTML = `<section>
    <div class="section-heading"><div><p class="eyebrow">KOMMENDE WOCHE</p><h1>Das Rad entscheidet</h1></div><p>Spiel und Spielleitung werden separat gezogen. Das aktuelle Spiel und die aktuelle Leitung pausieren eine Woche.</p></div>
    <div class="draw-grid">
      <article class="panel draw-card"><h3>Welches Spiel?</h3><div class="wheel" id="game-wheel"><span>${draw.game ? esc(draw.game.charAt(0)) : "?"}</span></div><p class="draw-result">${esc(draw.game || "Noch nicht ausgelost")}</p><p class="draw-options">Zur Auswahl: ${gameChoices.map(esc).join(" · ")}</p>${isHost() ? `<button class="button secondary" type="button" data-action="draw-game">Spiel auslosen</button>` : ""}</article>
      <article class="panel draw-card"><h3>Wer leitet?</h3><div class="wheel" id="host-wheel"><span>${draw.host ? esc(draw.host.charAt(0)) : "?"}</span></div><p class="draw-result">${esc(draw.host || "Noch nicht ausgelost")}</p>${isHost() ? `<button class="button secondary" type="button" data-action="draw-host">Spielleitung auslosen</button>` : ""}</article>
    </div>
    ${isHost() ? `<section class="panel host-pool"><p class="eyebrow">ANWESENHEIT NÄCHSTE WOCHE</p><h3>Wer darf ausgelost werden?</h3><p>Ferien oder Abwesenheiten einfach abwählen.</p><div class="host-pool-grid">${PEOPLE.filter(person => person !== state.current.host).map(person => `<label><input type="checkbox" data-next-host="${esc(person)}" ${hostPool.includes(person) ? "checked" : ""}><span class="avatar">${initials(person)}</span>${esc(person)}</label>`).join("")}</div></section><div class="button-row"><button class="button primary large" type="button" data-action="save-next-week" ${draw.game && draw.host && draw.game !== state.current.game ? "" : "disabled"}>Nächste Woche festlegen</button></div>` : `<p class="rule-note">${esc(state.current.host)} dreht die beiden Räder.</p>`}
  </section>`;
}

function drawNext(type) {
  if (!isHost()) return;
  const wheel = document.querySelector(`#${type === "game" ? "game" : "host"}-wheel`);
  wheel?.classList.add("spin");
  setTimeout(() => mutate(next => {
    const choices = type === "game"
      ? GAMES.filter(game => game !== next.current.game)
      : (Array.isArray(next.current.draw.hostPool) ? next.current.draw.hostPool : PEOPLE.filter(person => person !== next.current.host));
    if (!choices.length) {
      showToast("Bitte mindestens eine Person auswählen");
      return;
    }
    next.current.draw[type] = randomItem(choices);
  }), 850);
}

function saveNextWeek() {
  if (!isHost() || !state.current.draw.game || !state.current.draw.host || state.current.draw.game === state.current.game) return;
  inGame = false;
  mutate(next => {
    const old = next.current;
    next.history.unshift({ id: old.id, date: today(), game: old.game, host: old.host, scores: old.results, nextGame: old.draw.game, nextHost: old.draw.host });
    next.current = {
      id: `week-${Date.now()}`, date: today(), game: old.draw.game, host: old.draw.host, phase: "lobby", letters: [], letter: null,
      categories: ["Stadt", "Land", "Fluss"], startedAt: null, endedAt: null, finisher: null, drafts: {}, reviews: {}, votes: {}, tieCandidates: [], results: null, draw: { game:null, host:null }
    };
  });
  showToast("Nächste Woche ist festgelegt");
}

function renderLeaderboardPage() {
  const scores = evergreenScores(Boolean(state.current.results));
  app.innerHTML = `<section><p class="eyebrow">EVERGREEN</p><h1>Die ewige Rangliste</h1><p class="lead">Alle Challenge-Punkte aus den gespeicherten Wochen.</p><div style="margin-top:32px">${renderScoreList(scores)}</div></section>`;
}

const RULES = [
  {
    game: "ABCD-Jagd",
    tagline: "Drei Buchstaben. Drei Gegenstände. Wer ist am schnellsten?",
    steps: [
      "Die Spielleitung startet die Runde. Drei zufällige Buchstaben erscheinen gleichzeitig bei allen.",
      "Schreibe zu jedem Buchstaben einen konkreten Gegenstand auf, der mit diesem Buchstaben beginnt.",
      "Tastaturtasten zählen nicht als Gegenstand.",
      "Wer alle drei Begriffe hat, stoppt die Runde mit Enter, Tab oder „Fertig – Runde stoppen“. Die Runde endet dann für alle."
    ],
    scoring: [
      "Die Spielleitung bewertet jeden Begriff: ✓ eigener korrekter Begriff (1), ½ von mehreren genannt (0,5), × falsch oder leer (0).",
      "Schnell eingegebene gültige Begriffe geben einen kleinen Zeitbonus.",
      "Rangpunkte: Platz 1 = 6, Platz 2 = 5 … bis 0. Gleichstand = gleiche Punkte."
    ]
  },
  {
    game: "Stadt–Land–Fluss",
    tagline: "Der Klassiker – mit Zusatzkategorien der Spielleitung.",
    steps: [
      "Stadt, Land und Fluss sind fix. Die Spielleitung kann weitere Kategorien ergänzen (z. B. Beruf, Tier).",
      "Die Spielleitung dreht den Buchstaben (ohne X, Y, Z) und gibt das GO für alle.",
      "Fülle zu jeder Kategorie einen Begriff mit dem Buchstaben aus.",
      "Wer alle Felder hat, stoppt die Runde mit Enter, Tab oder „Fertig – Runde stoppen“."
    ],
    scoring: [
      "Bewertung pro Begriff wie bei der ABCD-Jagd: ✓ = 1, ½ = 0,5, × = 0. Gleiche Begriffe werden automatisch als ½ vorgeschlagen.",
      "Schnelle gültige Begriffe geben einen Zeitbonus.",
      "Rangpunkte: Platz 1 = 6, Platz 2 = 5 … bis 0."
    ]
  },
  {
    game: "Stiller Held",
    tagline: "Wer hat diese Woche im Hintergrund am meisten bewegt?",
    steps: [
      "Die Spielleitung eröffnet die Abstimmung.",
      "Jede Person gibt geheim genau eine Stimme ab – auch für sich selbst, wenn sie will.",
      "Die Stimme kann bis zum Abschluss geändert werden.",
      "Die Spielleitung schliesst die Abstimmung."
    ],
    scoring: [
      "Die Person mit den meisten Stimmen erhält 6 Punkte, alle anderen 0.",
      "Bei Gleichstand entscheidet die Spielleitung zwischen den Bestplatzierten."
    ]
  }
];

function renderRulesPage() {
  const list = items => `<ul class="rules-list">${items.map(item => `<li>${esc(item)}</li>`).join("")}</ul>`;
  app.innerHTML = `<section><p class="eyebrow">SPIELÜBERSICHT</p><h1>Spiele & Regeln</h1><p class="lead">Jede Woche ein Spiel, eine Spielleitung. Die Spielleitung spielt immer mit.</p>
    <div class="rules-grid">${RULES.map(rule => `
      <article class="rules-card ${rule.game === state.current.game ? "current" : ""}">
        ${rule.game === state.current.game ? `<span class="rules-badge">Diese Woche</span>` : ""}
        <h2>${esc(rule.game)}</h2><p class="rules-tagline">${esc(rule.tagline)}</p>
        <h3>Ablauf</h3>${list(rule.steps)}
        <h3>Punkte</h3>${list(rule.scoring)}
      </article>`).join("")}</div>
    <article class="rules-card rules-general"><h2>Wochenablauf</h2>${list([
      "Alle öffnen den Link und wählen ihren Namen. Die Startseite zeigt Spiel und Spielleitung der Woche.",
      "Nur die Spielleitung startet, bewertet und schliesst ab – spielt aber selbst mit.",
      "Nach dem Spiel: Tagesrangliste und ewige Rangliste (Summe aller Wochen).",
      "Danach werden Spiel und Spielleitung für nächste Woche separat ausgelost. Das aktuelle Spiel und die aktuelle Leitung pausieren eine Woche.",
      "Abwesende (Ferien etc.) kann die Spielleitung vor der Auslosung abwählen."
    ])}</article>
  </section>`;
}

function renderHistoryPage() {
  app.innerHTML = `<section><p class="eyebrow">ARCHIV</p><h1>Vergangene Wochen</h1><p class="lead">Spiele, Spielleitungen und Resultate bleiben erhalten.</p><div class="history-list">${state.history.length ? state.history.map(week => `
    <article class="history-card"><div class="history-top"><div><p class="eyebrow">${esc(week.game)}</p><h3>Spielleitung: ${esc(week.host)}</h3></div><span class="history-date">${formatDate(week.date)}</span></div>
    <div class="history-tags"><span class="tag">Danach: ${esc(week.nextGame)}</span><span class="tag">Nächste Leitung: ${esc(week.nextHost)}</span></div>
    <div>${(week.scores || []).slice(0,3).map(score => `<span class="tag">${esc(score.person)} ${score.points} Pkt.</span>`).join(" ")}</div></article>`).join("") : `<div class="empty-state"><strong>Noch keine abgeschlossene Woche.</strong><br>Nach der ersten Auslosung erscheint hier die Geschichte.</div>`}</div></section>`;
}

function startVisibleTimer() {
  const clock = document.querySelector("[data-clock]");
  if (!clock || !state.current.startedAt) return;
  const update = () => {
    const end = state.current.endedAt || Date.now();
    clock.textContent = formatSeconds((end - state.current.startedAt) / 1000);
  };
  update();
  timerHandle = setInterval(update,100);
}

function formatSeconds(seconds) {
  const safe = Math.max(0,seconds || 0);
  const minutes = Math.floor(safe/60);
  const remainder = (safe%60).toFixed(1).padStart(4,"0");
  return `${String(minutes).padStart(2,"0")}:${remainder}`;
}


render();
connect();
