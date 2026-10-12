// Datenanbindung: Firestore (Produktion) oder Mock (lokaler Test mit ?mock)
const FIREBASE_SDK = "https://www.gstatic.com/firebasejs/10.14.1";

function clean(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

// Patch in einzelne Feldpfade zerlegen. Drafts einer Person werden als Ganzes ersetzt.
export function flattenPatch(patch, prefix = [], out = []) {
  for (const [key, value] of Object.entries(patch || {})) {
    const path = [...prefix, key];
    const replaceWhole = path.length === 3 && path[0] === "current" && path[1] === "drafts";
    if (isPlainObject(value) && !replaceWhole && Object.keys(value).length) flattenPatch(value, path, out);
    else out.push([path, value]);
  }
  return out;
}

async function firebaseStore(config, team, freshState) {
  const [{ initializeApp }, fs] = await Promise.all([
    import(`${FIREBASE_SDK}/firebase-app.js`),
    import(`${FIREBASE_SDK}/firebase-firestore.js`)
  ]);
  const app = initializeApp(config);
  const db = fs.getFirestore(app);
  const ref = fs.doc(db, "teams", team);

  return {
    mode: "firebase",
    subscribe(onState, onError) {
      let creating = false;
      return fs.onSnapshot(ref, async snap => {
        if (snap.exists()) return onState(snap.data());
        if (creating) return;
        creating = true;
        try {
          await fs.runTransaction(db, async tx => {
            const current = await tx.get(ref);
            if (!current.exists()) tx.set(ref, clean(freshState()));
          });
        } catch (error) { onError(error); }
      }, onError);
    },
    async transact(mutator) {
      await fs.runTransaction(db, async tx => {
        const snap = await tx.get(ref);
        const data = snap.exists() ? snap.data() : freshState();
        if (mutator(data) === false) return;
        tx.set(ref, clean(data));
      });
    },
    async patch(patch) {
      const pairs = flattenPatch(clean(patch));
      if (!pairs.length) return;
      const args = pairs.flatMap(([path, value]) => [new fs.FieldPath(...path), value]);
      await fs.updateDoc(ref, ...args);
    }
  };
}

// Mock für lokale Tests: localStorage + BroadcastChannel, gleiche Schnittstelle wie Firestore
function mockStore(team, freshState) {
  const key = `mock-team-${team}`;
  const channel = new BroadcastChannel(key);
  const read = () => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
  const write = data => { localStorage.setItem(key, JSON.stringify(data)); channel.postMessage(data); };
  let listener = null;
  channel.onmessage = event => listener?.(event.data);
  return {
    mode: "mock",
    subscribe(onState) {
      listener = onState;
      if (!read()) write(clean(freshState()));
      setTimeout(() => onState(read()), 0);
      return () => { listener = null; };
    },
    async transact(mutator) {
      const data = read() || freshState();
      if (mutator(data) === false) return;
      write(clean(data));
      listener?.(read());
    },
    async patch(patch) {
      const data = read() || freshState();
      for (const [path, value] of flattenPatch(clean(patch))) {
        let target = data;
        path.slice(0, -1).forEach(segment => {
          if (!isPlainObject(target[segment])) target[segment] = {};
          target = target[segment];
        });
        target[path[path.length - 1]] = value;
      }
      write(data);
      listener?.(read());
    }
  };
}

export async function createStore(team, freshState) {
  const useMock = new URLSearchParams(location.search).has("mock");
  if (useMock) return mockStore(team, freshState);
  const config = window.FIREBASE_CONFIG;
  if (!config?.apiKey) throw new Error("Firebase-Konfiguration fehlt (firebase-config.js).");
  return firebaseStore(config, team, freshState);
}
