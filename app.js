import { createStore } from "./store.js";

const PEOPLE = ["Ueli", "Pirmin", "Eric", "Terry", "Markus", "Sinthu", "Matthias", "Gui", "Fabio", "Elias"];
const GAMES = ["ABCD-Jagd", "Stadt–Land–Fluss", "Stiller Held", "Live-Cooking", "Dümmste Erfindung", "Draw the Picture", "Podcast", "Dingsbums"];
const CUSTOM_GAMES = ["Live-Cooking", "Dümmste Erfindung", "Draw the Picture", "Podcast", "Dingsbums"];
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
      entries: {},
      verdict: {},
      pick: null,
      participants: null,
      secret: { sentence: "", variant: "" },
      drawings: {},
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
  ["drafts", "reviews", "votes", "entries", "verdict", "drawings"].forEach(key => { next.current[key] = next.current[key] || {}; });
  next.current.draw = next.current.draw || { game: null, host: null };
  next.current.secret = next.current.secret || { sentence: "", variant: "" };
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

// Fehler beim Lesen (Verbindungsaufbau): falscher Teamcode -> zurück zum Login
function reportError(error) {
  console.error(error);
  if (error?.code === "permission-denied") {
    showToast("Teamcode ungültig");
    resetTeam();
    return;
  }
  showToast("Verbindungsproblem – bitte Seite neu laden");
}

// Fehler beim Schreiben: nie ausloggen, nur melden
function reportWriteError(error) {
  console.error(error);
  showToast(error?.code === "permission-denied" ? "Speichern abgelehnt – bitte Spielleitung informieren" : "Speichern fehlgeschlagen – bitte nochmals versuchen");
}

// Ganze Zustandsänderung als Transaktion (Spielleitung, Phasenwechsel)
function mutate(mutator) {
  if (!store) return;
  store.transact(raw => {
    const next = normalizeState(raw);
    if (mutator(next) === false) return false;
    Object.keys(raw).forEach(key => delete raw[key]);
    Object.assign(raw, next);
  }).catch(reportWriteError);
}

// Kleine Feld-Updates (Eingaben, Stimmen, Präsenz)
function syncPatch(patch, { rerender = true } = {}) {
  if (!store) return;
  state = normalizeState(deepMerge(structuredClone(state), patch));
  if (rerender) render();
  store.patch(patch).catch(reportWriteError);
}

function renderKey() {
  return `${state.current.id}|${state.current.phase}|${state.current.game}|${state.current.letter}|${(state.current.letters || []).join("")}`;
}

function onRemoteState(data) {
  if (document.querySelector("#draw-canvas") && state.current.phase === "play") storeLocalCanvas();
  state = normalizeState(data);
  connected = true;
  trackPhase();
  const typing = document.activeElement?.matches("[data-term-cat],[data-abcd-term],#new-category,[data-keep-focus]");
  const drawingNow = state.current.game === "Draw the Picture" && state.current.phase === "play" && document.querySelector("#draw-canvas");
  if ((typing || canvasBusy() || drawingNow) && renderKey() === lastRenderedKey) return;
  render();
}

async function connect() {
  unsubscribe?.();
  connected = false;
  if (!teamCode) return renderLogin();
  try {
    store = await createStore(teamCode, freshState);
    const offState = store.subscribe(onRemoteState, reportError);
    unsubscribe = () => { offState?.(); };
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

// Wer in der laufenden Runde (ABCD/SLF) etwas eingegeben hat
function roundPlayers() {
  return PEOPLE.filter(person => Object.values(state.current.drafts[person]?.terms || {}).some(value => String(value || "").trim()));
}

function playerNames() {
  return PEOPLE;
}

function isHost() {
  return currentUser === state.current.host;
}

function phaseLabel() {
  return ({ lobby: "Warteraum", play: "Läuft gerade", vote: "Abstimmung", review: "Auswertung", results: "Resultate", draw: "Auslosung" })[state.current.phase] || "Diese Woche";
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
  safeSet(userStorage, "m-eine-challenge-last-activity", String(Date.now()));
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
  mountCanvas();
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
  handleCustomAction(action, event);
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
  if (CUSTOM_GAMES.includes(state.current.game) && phase !== "results" && phase !== "draw") return renderCustomGame();
  if (phase === "lobby") renderLobby();
  else if (phase === "play") renderPlay();
  else if (phase === "review") renderReview();
  else if (phase === "results") renderResults();
  else renderDraw();
}

function shareHint() {
  if (!isHost() || !["review", "results", "draw"].includes(state.current.phase)) return "";
  return `<div class="share-hint"><strong>📺 Jetzt Bildschirm teilen</strong><span>Zeige dem Team ab hier ${state.current.phase === "draw" ? "die Auslosung für nächste Woche" : state.current.phase === "review" ? "die Auswertung bzw. den Vergleich" : "das Resultat"}.</span></div>`;
}

function gameTop(label, title) {
  return `${shareHint()}<div class="game-top"><div><p class="eyebrow">${label}</p><h2>${title}</h2><span class="role-badge">${isHost() ? "Du bist die Spielleitung" : `Spielleitung: ${esc(state.current.host)}`}</span></div><button class="button ghost" type="button" data-action="back-home">Zur Startseite</button></div>`;
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
    <div class="review-table-wrap"><table><thead><tr><th>Person</th>${state.current.letters.map(letter => `<th>${letter}</th>`).join("")}</tr></thead><tbody>${roundPlayers().map(person => `<tr><td><strong>${esc(person)}</strong></td>${state.current.letters.map(letter => renderMatrixCell("abcd",person,letter)).join("")}</tr>`).join("")}</tbody></table></div>
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
    <div class="section-heading"><div><p class="eyebrow">STATUS</p><h3>${voteCount} von ${Math.max(activePeople().length, voteCount)} Stimmen abgegeben</h3></div>${isHost() ? `<button class="button primary" type="button" data-action="close-hero" ${voteCount ? "" : "disabled"}>Abstimmung schliessen</button>` : `<p>Die Resultate bleiben bis zum Abschluss geheim.</p>`}</div>
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
    // Resultat: alle mit mindestens 1 Stimme (eingeloggt oder nicht), absteigend nach Stimmen
    next.current.results = PEOPLE.filter(person => totals[person] > 0 || person === winner).map(person => ({ person, points: person === winner ? 6 : 0, raw: totals[person], rank: person === winner ? 1 : 2, detail: `${totals[person]} ${totals[person] === 1 ? "Stimme" : "Stimmen"}` })).sort((a,b) => b.points-a.points || b.raw-a.raw || a.person.localeCompare(b.person));
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
    <div class="review-table-wrap"><table><thead><tr><th>Person</th>${state.current.categories.map(category => `<th>${esc(category)}</th>`).join("")}</tr></thead><tbody>${roundPlayers().map(person => `<tr><td><strong>${esc(person)}</strong></td>${state.current.categories.map(category => renderMatrixCell("slf",person,category)).join("")}</tr>`).join("")}</tbody></table></div>
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
    const played = person => Object.values(round.drafts[person]?.terms || {}).some(value => String(value || "").trim());
    const entries = (round.game === "Stadt–Land–Fluss" ? scoreSlf(round) : scoreAbcd(round)).filter(entry => played(entry.person));
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
  app.innerHTML = `${shareHint()}<section>
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
    next.history.unshift({ id: old.id, date: today(), game: old.game, host: old.host, scores: old.results, nextGame: old.draw.game, nextHost: old.draw.host, ...(old.inventions ? { inventions: old.inventions } : {}) });
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
  { game: "ABCD-Jagd", tagline: "Drei Buchstaben. Drei Gegenstände. Wer ist am schnellsten?",
    steps: ["Die Spielleitung startet die Runde. Drei zufällige Buchstaben erscheinen gleichzeitig bei allen.", "Schreibe zu jedem Buchstaben einen konkreten Gegenstand auf, der mit diesem Buchstaben beginnt.", "Tastaturtasten zählen nicht als Gegenstand.", "Wer alle drei Begriffe hat, stoppt die Runde mit Enter, Tab oder „Fertig – Runde stoppen“. Die Runde endet dann für alle."],
    scoring: ["Die Spielleitung bewertet jeden Begriff: ✓ eigener korrekter Begriff (1), ½ von mehreren genannt (0,5), × falsch oder leer (0).", "Schnell eingegebene gültige Begriffe geben einen kleinen Zeitbonus.", "Rangpunkte: Platz 1 = 6, Platz 2 = 5 … bis 0. Gleichstand = gleiche Punkte."] },
  { game: "Stadt–Land–Fluss", tagline: "Der Klassiker – mit Zusatzkategorien der Spielleitung.",
    steps: ["Stadt, Land und Fluss sind fix. Die Spielleitung kann weitere Kategorien ergänzen (z. B. Beruf, Tier).", "Die Spielleitung dreht den Buchstaben (ohne X, Y, Z) und gibt das GO für alle.", "Fülle zu jeder Kategorie einen Begriff mit dem Buchstaben aus.", "Wer alle Felder hat, stoppt die Runde mit Enter, Tab oder „Fertig – Runde stoppen“."],
    scoring: ["Bewertung pro Begriff wie bei der ABCD-Jagd: ✓ = 1, ½ = 0,5, × = 0. Gleiche Begriffe werden automatisch als ½ vorgeschlagen.", "Schnelle gültige Begriffe geben einen Zeitbonus.", "Rangpunkte: Platz 1 = 6, Platz 2 = 5 … bis 0."] },
  { game: "Stiller Held", tagline: "Wer hat diese Woche im Hintergrund am meisten bewegt?",
    steps: ["Die Spielleitung eröffnet die Abstimmung.", "Jede Person gibt geheim genau eine Stimme ab – auch für sich selbst, wenn sie will.", "Die Stimme kann bis zum Abschluss geändert werden.", "Die Spielleitung schliesst die Abstimmung."],
    scoring: ["Die Person mit den meisten Stimmen erhält 6 Punkte, alle anderen 0.", "Bei Gleichstand entscheidet die Spielleitung zwischen den Bestplatzierten."] },
  { game: "Live-Cooking", tagline: "Wer es zieht, kocht nächste Woche für alle.",
    steps: ["Die ausgeloste Spielleitung bereitet für die nächste Woche ein Live-Cooking vor.", "Sie teilt mit, was eingekauft werden muss. Alle anderen kaufen ein.", "Im Termin wird gemeinsam gekocht.", "Die Spielleitung erfasst in der App, ob das Cooking stattgefunden hat und wer mitgekocht hat."],
    scoring: ["Durchgeführt: Spielleitung 6 Punkte, alle Teilnehmenden 3 Punkte.", "Nicht durchgeführt (verhängt): alle anderen 6 Punkte, Spielleitung 0."] },
  { game: "Dümmste Erfindung", tagline: "Das beste Plädoyer für die sinnloseste Erfindung.",
    steps: ["Jede Person bereitet ein kurzes Plädoyer vor, warum ihre Erfindung die dümmste ist. Hilfsmittel (Video, PPTX …) sind erlaubt.", "Die Spielleitung gibt die Erfassung frei. Danach erfassen alle ihr Stichwort in der App. So wächst die Liste der Erfindungen.", "Bereits in früheren Sessions vorgestellte Erfindungen sind gesperrt.", "Nach allen Plädoyers startet die Spielleitung die geheime Abstimmung. Die eigene Erfindung kann nicht gewählt werden."],
    scoring: ["Wer die meisten Stimmen erhält, bekommt 6 Punkte. Bei Gleichstand erhalten alle Bestplatzierten 6 Punkte."] },
  { game: "Draw the Picture", tagline: "Beschreiben, nachmalen, vergleichen.",
    steps: ["Im Warteraum kann jede Person auf einer Übungsfläche ausprobieren, wie das Malen funktioniert.", "Die Spielleitung startet das Malen. Alle malen gleichzeitig im Browser – mit Stift, Füllen und Radierer. Malzeit: 2 Minuten.", "Die Spielleitung malt das Original und beschreibt dabei laut, was sie malt. Die anderen malen nur nach der Beschreibung nach.", "Nach 2 Minuten (oder früher, wenn die Spielleitung stoppt) werden alle Bilder automatisch eingereicht.", "Die Spielleitung sieht alle Bilder neben ihrem Original und wählt das passendste. Danach stimmen alle ab, die ein Bild eingereicht haben: passt oder passt nicht."],
    scoring: ["Passt (Mehrheit oder Gleichstand): Spielleitung und gewählte Person je 6 Punkte.", "Passt nicht (Mehrheit): Spielleitung 6 Punkte Abzug – schlecht beschrieben."] },
  { game: "Podcast", tagline: "Die Spielleitung liefert einen Podcast.",
    steps: ["Die ausgeloste Spielleitung produziert bis zum Termin einen Podcast.", "Im Termin erfasst sie in der App, ob der Podcast geliefert wurde."],
    scoring: ["Geliefert: Spielleitung 6 Punkte.", "Nicht geliefert: alle anderen 6 Punkte, Spielleitung 0."] },
  { game: "Dingsbums", tagline: "Welche Variante stammt von der Spielleitung?",
    steps: ["Die Spielleitung erfasst vor dem Termin einen Satz mit dem Platzhalter „Dingsbums“, z. B. „Ich bin Fan von DINGSBUMS“, und ihre eigene Variante.", "Im Termin erscheint der Satz bei allen. Jede Person schickt geheim eine eigene Variante für Dingsbums.", "Die Spielleitung startet die Umfrage: Alle Varianten erscheinen gemischt und anonym.", "Alle raten, welche Variante von der Spielleitung stammt. Das Resultat ist erst nach dem Auflösen sichtbar."],
    scoring: ["Wer die Spielleitung entlarvt, erhält 6 Punkte.", "Entlarvt niemand die Spielleitung, erhält sie 6 Punkte.", "Wessen Variante (ausser der Spielleitung) am meisten Stimmen erhält, bekommt ebenfalls 6 Punkte.", "Maximal 6 Punkte pro Person – auch wenn beides zutrifft."] }
];

function renderRulesPage() {
  const list = items => `<ul class="rules-list">${items.map(item => `<li>${esc(item)}</li>`).join("")}</ul>`;
  app.innerHTML = `<section><p class="eyebrow">SPIELÜBERSICHT</p><h1>Spiele & Regeln</h1><p class="lead">Jede Woche ein Spiel, eine Spielleitung. Tippe auf ein Spiel für Ablauf und Punkte.</p>
    <div class="rules-accordion">${RULES.map(rule => `
      <details class="rules-item ${rule.game === state.current.game ? "current" : ""}">
        <summary><span class="rules-title">${esc(rule.game)}${rule.game === state.current.game ? `<span class="rules-badge">Diese Woche</span>` : ""}</span><span class="rules-tagline">${esc(rule.tagline)}</span></summary>
        <div class="rules-body"><div><h3>Ablauf</h3>${list(rule.steps)}</div><div><h3>Punkte</h3>${list(rule.scoring)}</div></div>
      </details>`).join("")}
      <details class="rules-item">
        <summary><span class="rules-title">Wochenablauf</span><span class="rules-tagline">Login, Spielleitung, Ranglisten und Auslosung</span></summary>
        <div class="rules-body"><div>${list([
          "Alle öffnen den Link und wählen ihren Namen. Die Startseite zeigt Spiel und Spielleitung der Woche.",
          "Nur die Spielleitung startet, bewertet und schliesst ab – spielt aber selbst mit.",
          "Für Auswertung, Resultat und Auslosung teilt die Spielleitung ihren Bildschirm.",
          "Nach dem Spiel: Tagesrangliste und ewige Rangliste (Summe aller Wochen).",
          "Danach werden Spiel und Spielleitung für nächste Woche separat ausgelost. Das aktuelle Spiel und die aktuelle Leitung pausieren eine Woche.",
          "Abwesende (Ferien etc.) kann die Spielleitung vor der Auslosung abwählen."
        ])}</div></div>
      </details>
    </div>
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

// ===================== Neue Spiele =====================
let pointerDown = false;
let localDrawing = { roundId: "", dataUrl: "" };
let lastPhaseSeen = "";
const CANVAS_W = 640;
const CANVAS_H = 480;
const PEN_COLORS = ["#26221d", "#e4572e", "#2e86de", "#2a9d5c", "#f3a712", "#8e44ad"];
let penColor = PEN_COLORS[0];
let penSize = 6;
let penTool = "pen";

function canvasBusy() {
  return pointerDown;
}

function hostName() { return state.current.host; }
function others() { return PEOPLE.filter(person => person !== hostName()); }
// Resultate nur für aktive Teilnehmende; alle anderen werden nicht berücksichtigt
function finishWith(points, details, participants = PEOPLE) {
  if (!isHost()) return;
  const included = PEOPLE.filter(person => participants.includes(person));
  mutate(next => {
    next.current.results = included.map(person => ({ person, points: Math.min(6, points[person] || 0), raw: points[person] || 0, detail: details[person] || "–" }))
      .sort((a, b) => b.points - a.points || a.person.localeCompare(b.person));
    next.current.endedAt = Date.now();
    next.current.phase = "results";
  });
}

function setPhase(phase, extra) {
  if (!isHost()) return;
  mutate(next => {
    next.current.phase = phase;
    if (phase === "play") next.current.startedAt = Date.now();
    if (extra) extra(next);
  });
}

function renderCustomGame() {
  const game = state.current.game;
  if (game === "Live-Cooking" || game === "Podcast") return renderAssignment();
  if (game === "Dümmste Erfindung") return renderInvention();
  if (game === "Dingsbums") return renderDingsbums();
  if (game === "Draw the Picture") return renderPicture();
}

function waitingBox(title, text) {
  return `<div class="waiting-stage"><div><div class="waiting-pulse"></div><h3>${title}</h3><p>${text}</p></div></div>`;
}

function statusLine(done, total, label) {
  return `<div class="section-heading"><div><p class="eyebrow">STATUS</p><h3>${done} von ${total} ${label}</h3></div></div>`;
}

// ---------- Live-Cooking & Podcast ----------
function renderAssignment() {
  const cooking = state.current.game === "Live-Cooking";
  const host = esc(hostName());
  const participants = Array.isArray(state.current.participants) ? state.current.participants : others();
  const intro = cooking
    ? `${host} hat das Live-Cooking vorbereitet: Einkaufsliste verteilt, alle haben eingekauft, jetzt wird gemeinsam gekocht.`
    : `${host} muss diese Woche einen Podcast liefern.`;
  const rules = cooking
    ? "Durchgeführt: Spielleitung 6 Punkte, alle Teilnehmenden 3 Punkte. Nicht durchgeführt: alle anderen 6 Punkte, Spielleitung 0."
    : "Geliefert: Spielleitung 6 Punkte. Nicht geliefert: alle anderen 6 Punkte, Spielleitung 0.";
  app.innerHTML = `<section class="panel game-shell">
    ${gameTop(`${cooking ? "LIVE-COOKING" : "PODCAST"} · ABSCHLUSS`, cooking ? "Wird heute gekocht?" : "Ist der Podcast da?")}
    <p class="rule-note">${intro}<br>${rules}</p>
    ${isHost() ? `
      ${cooking ? `<div class="section-heading"><div><p class="eyebrow">TEILNEHMENDE</p><h3>Wer hat mitgekocht?</h3></div><p>Nur bei „Durchgeführt“ relevant: Teilnehmende erhalten 3 Punkte.</p></div>
        <div class="host-pool-grid">${others().map(person => `<label><input type="checkbox" data-participant="${esc(person)}" ${participants.includes(person) ? "checked" : ""}><span class="avatar">${initials(person)}</span>${esc(person)}</label>`).join("")}</div>` : ""}
      <div class="button-row outcome-row">
        <button class="button primary large" type="button" data-action="outcome-done">${cooking ? "✓ Durchgeführt" : "✓ Podcast geliefert"}</button>
        <button class="button secondary large" type="button" data-action="outcome-failed">${cooking ? "✗ Nicht durchgeführt" : "✗ Nicht geliefert"}</button>
      </div>` : waitingBox(`${host} schliesst ab`, "Sobald die Spielleitung das Resultat erfasst, erscheinen die Punkte.")}
  </section>`;
}

function finishAssignment(done) {
  const cooking = state.current.game === "Live-Cooking";
  const host = hostName();
  const points = {}, details = {};
  if (done) {
    points[host] = 6; details[host] = cooking ? "hat gekocht" : "Podcast geliefert";
    if (cooking) {
      const participants = Array.isArray(state.current.participants) ? state.current.participants : others();
      participants.forEach(person => { points[person] = 3; details[person] = "hat mitgekocht"; });
    }
  } else {
    others().forEach(person => { points[person] = 6; details[person] = cooking ? "Cooking verhängt" : "Podcast nicht geliefert"; });
    points[host] = 0; details[host] = cooking ? "nicht gekocht" : "nicht geliefert";
    return finishWith(points, details, PEOPLE);
  }
  const participants = cooking
    ? [host, ...(Array.isArray(state.current.participants) ? state.current.participants : others())]
    : [host, ...activePeople()];
  finishWith(points, details, participants);
}

// ---------- Dümmste Erfindung ----------
// Liste aller vorgestellten Erfindungen: aus der Wochenhistorie + abgeschlossener aktueller Runde
function allInventions() {
  const fromHistory = state.history.flatMap(week => Array.isArray(week.inventions) ? week.inventions : []);
  const current = Array.isArray(state.current.inventions) ? state.current.inventions : [];
  return [...fromHistory, ...current];
}
function inventionTaken(name, except) {
  const term = normalizedTerm(name);
  if (!term) return false;
  if (allInventions().some(item => normalizedTerm(item.name) === term)) return "bereits in einer früheren Session vorgestellt";
  if (Object.entries(state.current.entries).some(([person, value]) => person !== except && normalizedTerm(value) === term)) return "diese Woche schon gewählt";
  return false;
}

function renderInventionArchive() {
  const list = allInventions();
  return `<details class="archive"><summary>Bereits vorgestellte Erfindungen (${list.length})</summary>${list.length ? `<ul>${list.map(item => `<li><strong>${esc(item.name)}</strong> – ${esc(item.person)}, ${esc(item.date || "")}</li>`).join("")}</ul>` : "<p>Noch keine.</p>"}</details>`;
}

function renderInvention() {
  const phase = state.current.phase;
  const entries = state.current.entries;
  const mine = entries[currentUser] || "";
  if (phase === "lobby" && !state.current.open) {
    app.innerHTML = `<section class="panel game-shell">
      ${gameTop("DÜMMSTE ERFINDUNG · WARTERAUM", "Welche Erfindung ist die dümmste?")}
      <p class="rule-note">Jede Person hält ein kurzes Plädoyer, warum ihre Erfindung die dümmste ist. Hilfsmittel (Video, PPTX …) sind erlaubt. Bereits vorgestellte Erfindungen sind tabu.</p>
      ${renderInventionArchive()}
      ${isHost() ? `<div class="review-footer"><span>Erst nach Freigabe können alle ihr Stichwort erfassen.</span><button class="button primary large" type="button" data-action="invention-open">Erfassung freigeben</button></div>` : waitingBox(`Warte auf ${esc(hostName())}`, "Sobald die Spielleitung freigibt, kannst du deine Erfindung erfassen.")}
    </section>`;
    return;
  }
  if (phase === "lobby") {
    app.innerHTML = `<section class="panel game-shell">
      ${gameTop("DÜMMSTE ERFINDUNG · ERFASSUNG", "Welche Erfindung ist die dümmste?")}
      <p class="rule-note">Jede Person hält ein kurzes Plädoyer, warum ihre Erfindung die dümmste ist. Hilfsmittel (Video, PPTX …) sind erlaubt. Bereits vorgestellte Erfindungen sind tabu. Erfasse hier dein Stichwort.</p>
      <form class="entry-form" data-form="invention"><input data-keep-focus name="entry" maxlength="60" placeholder="Deine Erfindung, z. B. Selfie-Stick" value="${esc(mine)}"><button class="button primary" type="submit">${mine ? "Ändern" : "Erfassen"}</button></form>
      ${mine ? `<p class="entry-ok">✓ Erfasst: <strong>${esc(mine)}</strong></p>` : ""}
      ${statusLine(Object.keys(entries).length, PEOPLE.length, "Stichworten erfasst")}
      <div class="entry-list">${PEOPLE.map(person => `<div class="entry-row ${entries[person] ? "done" : ""}"><span class="avatar">${initials(person)}</span><strong>${esc(person)}</strong><span>${entries[person] ? (person === currentUser ? esc(entries[person]) : "✓ erfasst (geheim)") : "–"}</span></div>`).join("")}</div>
      <p class="canvas-note">Die Erfindungen der anderen bleiben bis zur Abstimmung geheim – auch für die Spielleitung.</p>
      ${renderInventionArchive()}
      ${isHost() ? `<div class="review-footer"><span>Nach allen Plädoyers:</span><button class="button primary large" type="button" data-action="invention-vote" ${Object.keys(entries).length >= 2 ? "" : "disabled"}>Abstimmung starten</button></div>` : ""}
    </section>`;
    return;
  }
  const authors = PEOPLE.filter(person => entries[person]);
  const canVote = authors.includes(currentUser);
  const myVote = state.current.votes[currentUser] || "";
  const voteCount = authors.filter(person => state.current.votes[person]).length;
  app.innerHTML = `<section class="panel game-shell">
    ${gameTop("DÜMMSTE ERFINDUNG · ABSTIMMUNG", "Welches Plädoyer hat überzeugt?")}
    <p class="rule-note">Gib geheim eine Stimme ab. Die eigene Erfindung kann nicht gewählt werden. Wer am meisten Stimmen erhält, bekommt 6 Punkte.</p>
    <div class="vote-grid">${authors.map(person => `<button class="vote-card ${myVote === person ? "selected" : ""}" type="button" data-action="vote-invention" data-person="${esc(person)}" ${!canVote || person === currentUser ? "disabled" : ""}><span class="avatar">${initials(person)}</span><span><strong>${esc(entries[person])}</strong><br><small>${esc(person)}${person === currentUser ? " · ich" : ""}</small></span>${myVote === person ? `<span class="check">✓</span>` : ""}</button>`).join("")}</div>
    ${canVote ? "" : `<p class="canvas-note">Abstimmen dürfen nur Personen, die ein Plädoyer gehalten haben.</p>`}
    <div class="section-heading"><div><p class="eyebrow">STATUS</p><h3>${voteCount} von ${authors.length} Stimmen abgegeben</h3><p class="canvas-note">Stimmberechtigt: ${authors.map(esc).join(", ")}</p></div>${isHost() ? `<button class="button primary" type="button" data-action="invention-close" ${voteCount ? "" : "disabled"}>Abstimmung schliessen</button>` : "<p>Resultat bleibt bis zum Abschluss geheim.</p>"}</div>
  </section>`;
}

function closeInvention() {
  if (!isHost()) return;
  const entries = state.current.entries;
  const authors = PEOPLE.filter(person => entries[person]);
  const totals = {};
  Object.entries(state.current.votes).forEach(([voter, person]) => { if (authors.includes(voter)) totals[person] = (totals[person] || 0) + 1; });
  const max = Math.max(0, ...Object.values(totals));
  const points = {}, details = {};
  PEOPLE.forEach(person => {
    const votes = totals[person] || 0;
    points[person] = max > 0 && votes === max ? 6 : 0;
    details[person] = entries[person] ? `${entries[person]} · ${votes} ${votes === 1 ? "Stimme" : "Stimmen"}` : "kein Plädoyer";
  });
  const date = today();
  mutate(next => {
    next.current.inventions = Object.entries(next.current.entries).map(([person, name]) => ({ name, person, date }));
    next.current.results = authors.map(person => ({ person, points: points[person], raw: points[person], detail: details[person] }))
      .sort((a, b) => b.points - a.points || a.person.localeCompare(b.person));
    next.current.endedAt = Date.now();
    next.current.phase = "results";
  });
}

// ---------- Dingsbums ----------
// Teilnehmende: alle ausser Spielleitung, die eine Variante abgegeben haben
function dingsVoters() {
  return others().filter(person => state.current.entries[person]);
}
function dingsbumsSentence(variant) {
  const sentence = esc(state.current.secret.sentence || "");
  return sentence.replace(/dingsbums/i, `<mark>${variant ? esc(variant) : "DINGSBUMS"}</mark>`);
}

function renderDingsbums() {
  const phase = state.current.phase;
  const host = hostName();
  const entries = state.current.entries;
  if (phase === "lobby") {
    const secret = state.current.secret;
    const valid = /dingsbums/i.test(secret.sentence || "") && (secret.variant || "").trim();
    app.innerHTML = `<section class="panel game-shell">
      ${gameTop("DINGSBUMS · VORBEREITUNG", "Ein Satz mit Lücke")}
      <p class="rule-note">Die Spielleitung nennt einen Satz mit „Dingsbums“ als Platzhalter, z. B. „Ich bin Fan von DINGSBUMS“. Alle erfinden geheim eine Variante. Danach wird geraten, welche Variante von der Spielleitung stammt.</p>
      ${isHost() ? `<form class="secret-form" data-form="dingsbums-secret">
          <label>Dein Satz (muss „Dingsbums“ enthalten)<input data-keep-focus name="sentence" maxlength="140" value="${esc(secret.sentence || "")}" placeholder="Ich bin Fan von Dingsbums"></label>
          <label>Deine eigene Variante für Dingsbums (geheim)<input data-keep-focus name="variant" maxlength="60" value="${esc(secret.variant || "")}" placeholder="z. B. Gummibärchen"></label>
          <button class="button secondary" type="submit">Speichern</button>
        </form>
        <div class="review-footer"><span>${valid ? "✓ Bereit" : "Satz mit „Dingsbums“ und eigene Variante speichern"}</span><button class="button primary large" type="button" data-action="dings-start" ${valid ? "" : "disabled"}>Satz zeigen & starten</button></div>`
        : waitingBox(`${esc(host)} bereitet den Satz vor`, "Sobald es losgeht, erscheint der Satz hier.")}
    </section>`;
    return;
  }
  if (phase === "play") {
    const mine = entries[currentUser] || "";
    const count = others().filter(person => entries[person]).length;
    app.innerHTML = `<section class="panel game-shell">
      ${gameTop("DINGSBUMS · VARIANTEN", "Was ist Dingsbums?")}
      <p class="dings-sentence">${dingsbumsSentence()}</p>
      ${isHost() ? `
        <div class="entry-list">${others().map(person => `<div class="entry-row ${entries[person] ? "done" : ""}"><span class="avatar">${initials(person)}</span><strong>${esc(person)}</strong><span>${entries[person] ? esc(entries[person]) : "–"}</span></div>`).join("")}</div>
        <div class="review-footer"><span>${count} von ${others().length} Varianten da</span><button class="button primary large" type="button" data-action="dings-vote" ${count ? "" : "disabled"}>Umfrage starten</button></div>`
      : `<p class="rule-note">Erfinde eine glaubwürdige Variante. Nur die Spielleitung sieht sie.</p>
        <form class="entry-form" data-form="dingsbums-entry"><input data-keep-focus name="entry" maxlength="60" placeholder="Deine Variante" value="${esc(mine)}"><button class="button primary" type="submit">${mine ? "Ändern" : "Abschicken"}</button></form>
        ${mine ? `<p class="entry-ok">✓ Abgeschickt: <strong>${esc(mine)}</strong></p>` : ""}
        ${statusLine(count, others().length, "Varianten abgegeben")}`}
    </section>`;
    return;
  }
  // vote
  const order = Array.isArray(state.current.order) ? state.current.order : [];
  const myVote = state.current.votes[currentUser] || "";
  const voters = dingsVoters();
  const canVote = voters.includes(currentUser);
  const voteCount = voters.filter(person => state.current.votes[person]).length;
  const variantOf = person => person === host ? state.current.secret.variant : entries[person];
  app.innerHTML = `<section class="panel game-shell">
    ${gameTop("DINGSBUMS · UMFRAGE", "Welche Variante stammt von der Spielleitung?")}
    <p class="dings-sentence">${dingsbumsSentence()}</p>
    ${canVote ? `<p class="rule-note">Tippe auf die Variante, die du ${esc(host)} zutraust. Deine eigene kannst du nicht wählen.</p>` : isHost() ? "" : `<p class="canvas-note">Abstimmen dürfen nur Personen, die eine Variante abgegeben haben.</p>`}
    <div class="vote-grid">${order.map((person, index) => `<button class="vote-card ${myVote === person ? "selected" : ""}" type="button" data-action="vote-dings" data-person="${esc(person)}" ${!canVote || person === currentUser ? "disabled" : ""}><span class="avatar">${String.fromCharCode(65 + index)}</span><span>${esc(variantOf(person))}${person === currentUser ? " · meine" : ""}</span>${myVote === person ? `<span class="check">✓</span>` : ""}</button>`).join("")}</div>
    <div class="section-heading"><div><p class="eyebrow">STATUS</p><h3>${voteCount} von ${voters.length} Stimmen abgegeben</h3><p class="canvas-note">Stimmberechtigt: ${voters.map(esc).join(", ") || "–"}</p></div>${isHost() ? `<button class="button primary" type="button" data-action="dings-close" ${voteCount ? "" : "disabled"}>Auflösen</button>` : "<p>Resultat erst nach Abschluss sichtbar.</p>"}</div>
  </section>`;
}

function closeDingsbums() {
  const host = hostName();
  const votes = { ...state.current.votes };
  const points = {}, details = {};
  PEOPLE.forEach(person => { points[person] = 0; details[person] = []; });
  const allowed = dingsVoters();
  Object.keys(votes).forEach(person => { if (!allowed.includes(person)) delete votes[person]; });
  const hunters = allowed.filter(person => votes[person] === host);
  hunters.forEach(person => { points[person] += 6; details[person].push("Spielleitung entlarvt"); });
  if (!hunters.length) { points[host] += 6; details[host].push("niemand hat dich entlarvt"); }
  const received = {};
  Object.values(votes).forEach(person => { if (person !== host) received[person] = (received[person] || 0) + 1; });
  const max = Math.max(0, ...Object.values(received));
  if (max > 0) Object.entries(received).forEach(([person, count]) => {
    if (count === max) { points[person] += 6; details[person].push(`beste Variante (${count} ${count === 1 ? "Stimme" : "Stimmen"})`); }
  });
  const flat = {};
  PEOPLE.forEach(person => { flat[person] = details[person].join(" · ") || (state.current.entries[person] ? esc(state.current.entries[person]) : "–"); });
  flat[host] = [...details[host], `Variante: ${state.current.secret.variant}`].join(" · ");
  finishWith(points, flat, [host, ...dingsVoters()]);
}

// ---------- Draw the Picture ----------
// Alle (inkl. Spielleitung) malen gleichzeitig. Bilder werden beim Stoppen in current.drawings gespeichert.
function canvasHtml(note) {
  return `<div class="canvas-wrap">
    <div class="canvas-tools">
      <div class="tool-group">${[["pen", "✏️ Stift"], ["fill", "🪣 Füllen"], ["eraser", "🧽 Radierer"]].map(([tool, label]) => `<button type="button" class="tool ${penTool === tool ? "active" : ""}" data-action="pen-tool" data-tool="${tool}">${label}</button>`).join("")}</div>
      <div class="tool-group">${PEN_COLORS.map(color => `<button type="button" class="pen ${color === penColor ? "active" : ""}" style="background:${color}" data-action="pen-color" data-color="${color}" aria-label="Farbe"></button>`).join("")}</div>
      <select data-pen-size aria-label="Strichstärke">${[3, 6, 12, 24].map(size => `<option value="${size}" ${size === penSize ? "selected" : ""}>${size}px</option>`).join("")}</select>
      <button type="button" class="button ghost small" data-action="canvas-undo">↶ Zurück</button>
      <button type="button" class="button ghost small" data-action="canvas-clear">Leeren</button>
      <label class="button ghost small upload">Bild hochladen<input type="file" accept="image/*" data-upload hidden></label>
    </div>
    <canvas id="draw-canvas" width="${CANVAS_W}" height="${CANVAS_H}"></canvas>
    <p class="canvas-note">${note}</p>
  </div>`;
}

const DRAW_SECONDS = Number(new URLSearchParams(location.search).get("drawsec")) || 120;
function drawSecondsLeft() {
  if (!state.current.startedAt) return DRAW_SECONDS;
  return Math.max(0, DRAW_SECONDS - Math.floor((Date.now() - state.current.startedAt) / 1000));
}
function isPractice() {
  return state.current.game === "Draw the Picture" && state.current.phase === "lobby";
}
function canvasEnabled() {
  if (state.current.game !== "Draw the Picture") return false;
  if (state.current.phase === "lobby") return true; // Übungsfläche
  return state.current.phase === "play" && drawSecondsLeft() > 0;
}
function formatCountdown(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
// Countdown anzeigen, bei 0 sperren; Spielleitung stoppt automatisch
let pictureTimerHandle = null;
let autoStopRound = "";
function tickPictureTimer() {
  if (state.current.game !== "Draw the Picture" || state.current.phase !== "play") return;
  const left = drawSecondsLeft();
  const label = document.querySelector("[data-countdown]");
  if (label) { label.textContent = formatCountdown(left); label.classList.toggle("urgent", left <= 15); }
  if (left <= 0) {
    pointerDown = false;
    document.querySelector("#draw-canvas")?.classList.add("locked");
    if (isHost() && autoStopRound !== state.current.id) {
      autoStopRound = state.current.id;
      submitDrawing();
      setTimeout(() => setPhase("review", next => { next.current.endedAt = Date.now(); }), 300);
      showToast("Zeit abgelaufen – Bilder werden eingesammelt");
    }
  }
}
pictureTimerHandle = setInterval(tickPictureTimer, 500);

function pictureOf(person) {
  return state.current.drawings?.[person]?.image || "";
}

function renderPicture() {
  const phase = state.current.phase;
  const host = hostName();
  if (phase === "lobby") {
    app.innerHTML = `<section class="panel game-shell">
      ${gameTop("DRAW THE PICTURE · WARTERAUM", "Malen nach Beschreibung")}
      <p class="rule-note">${esc(host)} malt live ein Bild und beschreibt dabei laut, was entsteht. Alle anderen malen gleichzeitig nach – nur nach der Beschreibung, ohne das Original zu sehen. Danach wählt ${esc(host)}, welches Bild am besten passt.</p>
      <p class="rule-note">Malzeit: ${formatCountdown(DRAW_SECONDS)} Min. Danach werden alle Bilder automatisch eingesammelt.</p>
      <div class="section-heading"><div><h3>${activePeople().length} von ${PEOPLE.length} eingeloggt</h3></div></div>
      ${renderPeopleGrid(activePeople())}
      <div class="section-heading"><div><p class="eyebrow">ÜBEN</p><h2>Übungsfläche</h2></div><p>Probier Stift, Füllen, Radierer und Farben aus. Die Übung wird nicht gespeichert und beim Start geleert.</p></div>
      ${canvasHtml("Übungsmodus – nur für dich sichtbar.")}
      <div class="section-heading"><div><p class="eyebrow">START</p><h2>${isHost() ? "Alle bereit?" : `Warte auf ${esc(host)}`}</h2></div>${isHost() ? `<button class="button primary large" type="button" data-action="picture-start">Malen starten (${formatCountdown(DRAW_SECONDS)} Min.)</button>` : ""}</div>
    </section>`;
    return;
  }
  if (phase === "play") {
    app.innerHTML = `<section class="panel game-shell">
      ${gameTop("DRAW THE PICTURE · MALEN", isHost() ? "Male und beschreibe laut" : `Hör ${esc(host)} zu und male nach`)}
      <div class="countdown-row"><span>Verbleibende Zeit</span><strong class="countdown ${drawSecondsLeft() <= 15 ? "urgent" : ""}" data-countdown>${formatCountdown(drawSecondsLeft())}</strong></div>
      ${canvasHtml(isHost() ? "Dein Bild ist das Original. Beschreibe laut, was du malst. Nach ${formatCountdown(DRAW_SECONDS)} Min. wird automatisch gestoppt – oder du stoppst früher." : "Male nach der Beschreibung. Nach Ablauf der Zeit oder beim Stoppen durch die Spielleitung wird dein Bild automatisch eingereicht.")}
      ${isHost() ? `<div class="review-footer"><span>Alle Bilder werden beim Stoppen eingesammelt.</span><button class="button primary large" type="button" data-action="picture-stop">Fertig – Malen stoppen</button></div>` : ""}
    </section>`;
    return;
  }
  const submitted = others().filter(person => pictureOf(person));
  if (phase === "review") {
    app.innerHTML = `<section class="panel game-shell">
      ${gameTop("DRAW THE PICTURE · VERGLEICH", "Welches Bild passt am besten?")}
      <div class="picture-ref"><span class="tag">Original von ${esc(host)}</span>${pictureOf(host) ? `<img src="${pictureOf(host)}" alt="Original">` : "<p>Original wird geladen …</p>"}</div>
      <div class="gallery">${submitted.map(person => `<figure class="gallery-item"><img src="${pictureOf(person)}" alt="Bild von ${esc(person)}"><figcaption>${esc(person)}${isHost() ? `<button class="button secondary small" type="button" data-action="picture-pick" data-person="${esc(person)}">Passt am besten</button>` : ""}</figcaption></figure>`).join("") || "<p>Noch keine Bilder eingetroffen …</p>"}</div>
      <p class="canvas-note">${submitted.length} ${submitted.length === 1 ? "Bild" : "Bilder"} eingereicht.</p>
      ${isHost() ? "" : `<p class="rule-note">${esc(host)} wählt das Bild, das am besten passt.</p>`}
    </section>`;
    return;
  }
  // vote: Gruppe beurteilt die Wahl
  const pick = state.current.pick;
  const voters = pictureVoters();
  const canVote = voters.includes(currentUser);
  const verdict = Object.fromEntries(Object.entries(state.current.verdict).filter(([person]) => voters.includes(person)));
  const mine = verdict[currentUser];
  const yes = Object.values(verdict).filter(value => value === "yes").length;
  const no = Object.values(verdict).filter(value => value === "no").length;
  app.innerHTML = `<section class="panel game-shell">
    ${gameTop("DRAW THE PICTURE · URTEIL", "Passt das wirklich?")}
    <div class="compare"><figure><img src="${pictureOf(host)}" alt="Original"><figcaption>Original · ${esc(host)}</figcaption></figure><figure><img src="${pictureOf(pick)}" alt="Bild von ${esc(pick)}"><figcaption>Gewählt · ${esc(pick)}</figcaption></figure></div>
    <p class="rule-note">Gute Übereinstimmung: ${esc(host)} und ${esc(pick)} erhalten je 6 Punkte. Mehrheit sagt „passt nicht“: ${esc(host)} erhält 6 Punkte Abzug.</p>
    ${canVote ? `<div class="button-row outcome-row"><button class="button ${mine === "yes" ? "primary" : "secondary"} large" type="button" data-action="verdict" data-value="yes">👍 Passt</button><button class="button ${mine === "no" ? "primary" : "secondary"} large" type="button" data-action="verdict" data-value="no">👎 Passt nicht</button></div>` : isHost() ? "" : `<p class="canvas-note">Abstimmen dürfen nur Personen, die ein Bild eingereicht haben.</p>`}
    <div class="section-heading"><div><p class="eyebrow">STATUS</p><h3>${yes + no} von ${voters.length} Stimmen</h3><p class="canvas-note">Stimmberechtigt: ${voters.map(esc).join(", ") || "–"}</p></div>${isHost() ? `<button class="button primary" type="button" data-action="verdict-close">Abschliessen</button>` : ""}</div>
  </section>`;
}

// Stimmberechtigt: alle ausser Spielleitung, die ein Bild eingereicht haben
function pictureVoters() {
  return others().filter(person => pictureOf(person));
}

function closePicture() {
  const host = hostName();
  const pick = state.current.pick;
  const voters = pictureVoters();
  const values = Object.entries(state.current.verdict).filter(([person]) => voters.includes(person)).map(([, value]) => value);
  const yes = values.filter(value => value === "yes").length;
  const no = values.filter(value => value === "no").length;
  const points = {}, details = {};
  if (yes >= no) {
    points[host] = 6; points[pick] = 6;
    details[host] = `Beschreibung passt (${yes}:${no})`; details[pick] = "bestes Bild";
  } else {
    points[host] = -6; details[host] = `schlecht beschrieben (${yes}:${no})`;
  }
  finishWith(points, details, [host, ...voters]);
}

let canvasCtx = null;
let undoStack = [];
let canvasMode = "";
let practiceDataUrl = "";
function mountCanvas() {
  const canvas = document.querySelector("#draw-canvas");
  canvasCtx = null;
  if (!canvas) return;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  canvasCtx = ctx;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  const mode = isPractice() ? "practice" : "round";
  if (mode !== canvasMode) { canvasMode = mode; undoStack = []; }
  if (localDrawing.roundId !== state.current.id) { localDrawing = { roundId: state.current.id, dataUrl: "" }; undoStack = []; }
  const restore = mode === "practice" ? practiceDataUrl : localDrawing.dataUrl;
  if (restore) {
    const image = new Image();
    image.onload = () => ctx.drawImage(image, 0, 0, CANVAS_W, CANVAS_H);
    image.src = restore;
  }
  canvas.classList.toggle("locked", !canvasEnabled());
  let last = null;
  const point = event => {
    const rect = canvas.getBoundingClientRect();
    return [Math.round((event.clientX - rect.left) * CANVAS_W / rect.width), Math.round((event.clientY - rect.top) * CANVAS_H / rect.height)];
  };
  const color = () => penTool === "eraser" ? "#ffffff" : penColor;
  canvas.addEventListener("pointerdown", event => {
    if (!canvasEnabled()) return;
    pushUndo();
    const start = point(event);
    if (penTool === "fill") { floodFill(ctx, start[0], start[1], penColor); storeLocalCanvas(); return; }
    pointerDown = true;
    canvas.setPointerCapture(event.pointerId);
    last = start;
    ctx.fillStyle = color();
    ctx.beginPath(); ctx.arc(last[0], last[1], penSize / 2, 0, Math.PI * 2); ctx.fill();
  });
  canvas.addEventListener("pointermove", event => {
    if (!pointerDown || !canvasEnabled()) return;
    const next = point(event);
    ctx.strokeStyle = color(); ctx.lineWidth = penSize; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(last[0], last[1]); ctx.lineTo(next[0], next[1]); ctx.stroke();
    last = next;
  });
  const end = () => {
    if (!pointerDown) return;
    pointerDown = false;
    storeLocalCanvas();
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
}

function pushUndo() {
  if (!canvasCtx) return;
  undoStack.push(canvasCtx.getImageData(0, 0, CANVAS_W, CANVAS_H));
  if (undoStack.length > 20) undoStack.shift();
}

function hexToRgb(hex) {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

// Füllwerkzeug: zusammenhängende, ähnlich gefärbte Fläche einfärben
function floodFill(ctx, x, y, hex) {
  const image = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H);
  const data = image.data;
  const start = (y * CANVAS_W + x) * 4;
  const target = [data[start], data[start + 1], data[start + 2]];
  const fill = hexToRgb(hex);
  if (Math.abs(target[0] - fill[0]) + Math.abs(target[1] - fill[1]) + Math.abs(target[2] - fill[2]) < 10) return;
  const tolerance = 90;
  const matches = index => Math.abs(data[index] - target[0]) + Math.abs(data[index + 1] - target[1]) + Math.abs(data[index + 2] - target[2]) <= tolerance;
  const seen = new Uint8Array(CANVAS_W * CANVAS_H);
  const stack = [[x, y]];
  while (stack.length) {
    const [px, py] = stack.pop();
    let cx = px;
    while (cx >= 0 && !seen[py * CANVAS_W + cx] && matches((py * CANVAS_W + cx) * 4)) cx -= 1;
    cx += 1;
    let up = false, down = false;
    while (cx < CANVAS_W && !seen[py * CANVAS_W + cx] && matches((py * CANVAS_W + cx) * 4)) {
      const pos = py * CANVAS_W + cx;
      seen[pos] = 1;
      data[pos * 4] = fill[0]; data[pos * 4 + 1] = fill[1]; data[pos * 4 + 2] = fill[2]; data[pos * 4 + 3] = 255;
      if (py > 0) {
        const upOk = !seen[pos - CANVAS_W] && matches((pos - CANVAS_W) * 4);
        if (upOk && !up) { stack.push([cx, py - 1]); up = true; } else if (!upOk) up = false;
      }
      if (py < CANVAS_H - 1) {
        const downOk = !seen[pos + CANVAS_W] && matches((pos + CANVAS_W) * 4);
        if (downOk && !down) { stack.push([cx, py + 1]); down = true; } else if (!downOk) down = false;
      }
      cx += 1;
    }
  }
  ctx.putImageData(image, 0, 0);
}

function storeLocalCanvas() {
  const canvas = document.querySelector("#draw-canvas");
  if (!canvas) return;
  if (isPractice()) { practiceDataUrl = canvas.toDataURL("image/jpeg", 0.6); return; }
  localDrawing = { roundId: state.current.id, dataUrl: canvas.toDataURL("image/jpeg", 0.6) };
}

// Bild einreichen (einmal beim Stoppen), Ziel < 120 KB pro Bild
let submittedRound = "";
function submitDrawing() {
  if (submittedRound === state.current.id) return;
  if (document.querySelector("#draw-canvas") && state.current.phase === "play") storeLocalCanvas();
  if (localDrawing.roundId !== state.current.id || !localDrawing.dataUrl) return;
  submittedRound = state.current.id;
  shrinkImage(localDrawing.dataUrl).then(image => {
    syncPatch({ current: { drawings: { [currentUser]: { image, at: Date.now() } } } }, { rerender: false });
  });
}

function shrinkImage(dataUrl) {
  return new Promise(resolve => {
    if (dataUrl.length < 70000) return resolve(dataUrl);
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = CANVAS_W / 2; canvas.height = CANVAS_H / 2;
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.6));
    };
    image.src = dataUrl;
  });
}

function uploadImage(file) {
  if (!file || !canvasCtx || !canvasEnabled()) return;
  const reader = new FileReader();
  reader.onload = () => {
    const image = new Image();
    image.onload = () => {
      pushUndo();
      const ctx = canvasCtx;
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
      const scale = Math.min(CANVAS_W / image.width, CANVAS_H / image.height);
      const w = image.width * scale, h = image.height * scale;
      ctx.drawImage(image, (CANVAS_W - w) / 2, (CANVAS_H - h) / 2, w, h);
      storeLocalCanvas();
      showToast("Bild übernommen");
    };
    image.src = reader.result;
  };
  reader.readAsDataURL(file);
}

// ---------- Aktionen ----------
function handleCustomAction(action, event) {
  const person = event.target.closest("[data-person]")?.dataset.person;
  if (action === "outcome-done") finishAssignment(true);
  if (action === "outcome-failed") finishAssignment(false);
  if (action === "invention-open") setPhase("lobby", next => { next.current.open = true; });
  if (action === "invention-vote") setPhase("vote", next => { next.current.votes = {}; });
  if (action === "vote-invention" && person && person !== currentUser && state.current.entries[currentUser] && state.current.phase === "vote") syncPatch({ current: { votes: { [currentUser]: person } } });
  if (action === "invention-close") closeInvention();
  if (action === "dings-start") setPhase("play", next => { next.current.entries = {}; });
  if (action === "dings-vote") setPhase("vote", next => {
    next.current.votes = {};
    next.current.order = shuffle([next.current.host, ...PEOPLE.filter(name => name !== next.current.host && next.current.entries[name])]);
  });
  if (action === "vote-dings" && person && person !== currentUser && dingsVoters().includes(currentUser) && state.current.phase === "vote") syncPatch({ current: { votes: { [currentUser]: person } } });
  if (action === "dings-close" && isHost()) closeDingsbums();
  if (action === "picture-start") setPhase("play", next => {
    next.current.startedAt = Date.now(); next.current.drawings = {}; next.current.pick = null; next.current.verdict = {}; });
  if (action === "picture-stop" && isHost()) { submitDrawing(); setTimeout(() => setPhase("review", next => { next.current.endedAt = Date.now(); }), 300); }
  if (action === "pen-tool") { penTool = event.target.closest("[data-tool]").dataset.tool; document.querySelectorAll(".tool").forEach(tool => tool.classList.toggle("active", tool.dataset.tool === penTool)); }
  if (action === "canvas-undo" && canvasCtx && canvasEnabled() && undoStack.length) { canvasCtx.putImageData(undoStack.pop(), 0, 0); storeLocalCanvas(); }
  if (action === "picture-pick" && person) setPhase("vote", next => { next.current.pick = person; next.current.verdict = {}; });
  if (action === "verdict" && pictureVoters().includes(currentUser) && state.current.phase === "vote") syncPatch({ current: { verdict: { [currentUser]: event.target.closest("[data-value]").dataset.value } } });
  if (action === "verdict-close" && isHost()) closePicture();
  if (action === "pen-color") {
    penColor = event.target.closest("[data-color]").dataset.color;
    if (penTool === "eraser") penTool = "pen";
    document.querySelectorAll(".pen").forEach(pen => pen.classList.toggle("active", pen.dataset.color === penColor));
    document.querySelectorAll(".tool").forEach(tool => tool.classList.toggle("active", tool.dataset.tool === penTool));
  }
  if (action === "canvas-clear" && canvasCtx && canvasEnabled()) {
    pushUndo();
    canvasCtx.fillStyle = "#fff"; canvasCtx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    storeLocalCanvas();
  }
}

app.addEventListener("submit", event => {
  const form = event.target.closest("[data-form]");
  if (!form) return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  if (form.dataset.form === "invention" && state.current.open && state.current.phase === "lobby") {
    const value = (data.entry || "").trim();
    if (!value) return;
    const taken = inventionTaken(value, currentUser);
    if (taken) return showToast(`„${value}“ ist ${taken}`);
    syncPatch({ current: { entries: { [currentUser]: value } } });
  }
  if (form.dataset.form === "dingsbums-entry" && state.current.phase === "play") {
    const value = (data.entry || "").trim();
    if (value) syncPatch({ current: { entries: { [currentUser]: value } } });
  }
  if (form.dataset.form === "dingsbums-secret" && isHost()) {
    const sentence = (data.sentence || "").trim();
    if (!/dingsbums/i.test(sentence)) return showToast("Der Satz muss „Dingsbums“ enthalten");
    syncPatch({ current: { secret: { sentence, variant: (data.variant || "").trim() } } });
  }
  document.activeElement?.blur();
});

app.addEventListener("change", event => {
  if (event.target.matches("[data-participant]") && isHost()) {
    const person = event.target.dataset.participant;
    const checked = event.target.checked;
    mutate(next => {
      const list = Array.isArray(next.current.participants) ? next.current.participants : PEOPLE.filter(name => name !== next.current.host);
      next.current.participants = checked ? [...new Set([...list, person])] : list.filter(name => name !== person);
    });
  }
  if (event.target.matches("[data-pen-size]")) penSize = Number(event.target.value);
  if (event.target.matches("[data-upload]")) uploadImage(event.target.files?.[0]);
});

// Beim Phasenwechsel letzte Zeichnung sofort sichern
function trackPhase() {
  const phase = `${state.current.id}|${state.current.phase}`;
  if (state.current.game === "Draw the Picture" && state.current.phase === "review" && lastPhaseSeen.endsWith("|play")) submitDrawing();
  lastPhaseSeen = phase;
}

// ---------- Automatisches Logout nach 30 Min Inaktivität ----------
const IDLE_KEY = "m-eine-challenge-last-activity";
const IDLE_LIMIT = 30 * 60 * 1000;
let lastActivityWrite = 0;
function touchActivity() {
  const now = Date.now();
  if (now - lastActivityWrite < 10000) return;
  lastActivityWrite = now;
  safeSet(userStorage, IDLE_KEY, String(now));
}
function checkIdle() {
  if (!currentUser) return;
  const last = Number(safeGet(userStorage, IDLE_KEY) || 0);
  if (last && Date.now() - last > IDLE_LIMIT) {
    logout();
    showToast("Nach 30 Minuten Inaktivität abgemeldet");
  }
}
["pointerdown", "keydown", "input", "touchstart"].forEach(type => document.addEventListener(type, touchActivity, { passive: true }));
checkIdle();
if (currentUser && !safeGet(userStorage, IDLE_KEY)) touchActivity();
setInterval(checkIdle, 30000);

render();
connect();
