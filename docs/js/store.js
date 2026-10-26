// Saved progress: options, Endless threat level / history, Story campaign,
// finished training lessons.
// Always kept in localStorage; when signed in with Google it is also
// synced to Firestore (users/{uid}) so it follows the player anywhere.
// Signed-in players also pick a unique screen name (screenNames/{NAME} ->
// uid) and post their best Endless score to leaderboard/{uid}.
import { DEFAULT_OPTIONS, CAMPAIGN, SCREEN_NAME } from "./consts.js";
import { firebaseConfig } from "./firebase-config.js";

const LOCAL_KEY = "zombie-evac-save-v1";
const SDK = "https://www.gstatic.com/firebasejs/10.12.2";

function blank() {
  return { options: { ...DEFAULT_OPTIONS }, progress: { level: 0, history: [] }, campaign: null, tutorials: [] };
}

function validCampaign(c) {
  return c && Number.isInteger(c.mission) && c.mission >= 0 && c.mission < CAMPAIGN.length
    ? { mission: c.mission, completed: Array.isArray(c.completed) ? c.completed : [] } : null;
}

function clean(d) {
  const out = blank();
  if (d && typeof d === "object") {
    Object.assign(out.options, d.options || {});
    if (d.progress) out.progress = { level: d.progress.level | 0, history: Array.isArray(d.progress.history) ? d.progress.history.slice(-50) : [] };
    out.campaign = validCampaign(d.campaign);
    if (Array.isArray(d.tutorials)) out.tutorials = d.tutorials.filter(id => typeof id === "string").slice(0, 50);
  }
  return out;
}

export class Store {
  constructor() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(LOCAL_KEY)); } catch { /* private mode / bad data */ }
    this.data = clean(d);
    this.user = null;            // {uid, name, email}
    this.status = "";            // short line for the menu ("SYNCED", errors...)
    this.fb = null;
    this.ready = false;
    this.listeners = [];
    this._timer = null;
    this.screenName = null;      // signed-in player's leaderboard name
    this.profileLoaded = false;  // screenName / best have been read for this user
    this.best = 0;               // their score on the leaderboard
  }

  get options() { return this.data.options; }
  get progress() { return this.data.progress; }
  get campaign() { return this.data.campaign; }
  set campaign(c) { this.data.campaign = validCampaign(c); this.save(); }
  get tutorials() { return this.data.tutorials; }

  completeTutorial(id) {
    if (this.data.tutorials.includes(id)) return;
    this.data.tutorials.push(id);
    this.save();
  }

  onChange(fn) { this.listeners.push(fn); }
  emit() { for (const fn of this.listeners) fn(); }

  save() {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(this.data)); } catch { /* storage full / blocked */ }
    if (this.user) {
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this.push(), 800);
    }
  }

  async push() {
    if (!this.user || !this.fb) return;
    const { db, doc, setDoc, serverTimestamp } = this.fb;
    try {
      await setDoc(doc(db, "users", this.user.uid), { ...this.data, screenName: this.screenName, updated: serverTimestamp() });
      this.status = "PROGRESS SYNCED";
    } catch (e) {
      this.status = "SYNC FAILED - SAVED ON THIS DEVICE";
      console.warn("save failed", e);
    }
    this.emit();
  }

  /** Load the Firebase SDK and start listening for sign-in changes. */
  async init() {
    if (!firebaseConfig || !firebaseConfig.apiKey) {
      this.status = "CLOUD SAVE NOT CONFIGURED";
      return;
    }
    try {
      const [{ initializeApp }, auth, fs] = await Promise.all([
        import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`), import(`${SDK}/firebase-firestore.js`),
      ]);
      const app = initializeApp(firebaseConfig);
      this.fb = {
        auth: auth.getAuth(app), provider: new auth.GoogleAuthProvider(), signInWithPopup: auth.signInWithPopup,
        signInWithRedirect: auth.signInWithRedirect, signOut: auth.signOut,
        db: fs.getFirestore(app), doc: fs.doc, getDoc: fs.getDoc, setDoc: fs.setDoc, serverTimestamp: fs.serverTimestamp,
        collection: fs.collection, query: fs.query, orderBy: fs.orderBy, limit: fs.limit, where: fs.where,
        getDocs: fs.getDocs, getCountFromServer: fs.getCountFromServer, runTransaction: fs.runTransaction,
      };
      auth.getRedirectResult(this.fb.auth).catch(() => {});
      auth.onAuthStateChanged(this.fb.auth, user => this.authChanged(user));
      this.ready = true;
    } catch (e) {
      console.warn("firebase unavailable", e);
      this.status = "OFFLINE - PROGRESS SAVED ON THIS DEVICE";
    }
    this.emit();
  }

  async authChanged(user) {
    if (!user) {
      this.user = null;
      this.screenName = null; this.profileLoaded = false; this.best = 0;
      this.status = "";
      this.emit();
      return;
    }
    this.user = { uid: user.uid, name: user.displayName || user.email || "AGENT", email: user.email };
    this.status = "LOADING SAVE...";
    this.emit();
    const { db, doc, getDoc } = this.fb;
    try {
      const [snap, entry] = await Promise.all([getDoc(doc(db, "users", user.uid)), getDoc(doc(db, "leaderboard", user.uid))]);
      if (snap.exists()) this.data = merge(this.data, clean(snap.data()));
      const name = snap.exists() ? snap.data().screenName : null;
      this.screenName = typeof name === "string" && SCREEN_NAME.test(name) ? name : null;
      this.best = entry.exists() ? entry.data().score | 0 : 0;
      this.profileLoaded = true;
      try { localStorage.setItem(LOCAL_KEY, JSON.stringify(this.data)); } catch { /* ignore */ }
      await this.push();
    } catch (e) {
      console.warn("load failed", e);
      this.status = "CLOUD LOAD FAILED - USING THIS DEVICE";
    }
    this.emit();
  }

  async signIn() {
    if (!this.fb) return;
    try {
      await this.fb.signInWithPopup(this.fb.auth, this.fb.provider);
    } catch (e) {
      if (e && (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment")) {
        await this.fb.signInWithRedirect(this.fb.auth, this.fb.provider);
      } else if (e && e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
        this.status = "SIGN-IN FAILED: " + String(e.code || e.message || e).replace("auth/", "").toUpperCase();
        this.emit();
      }
    }
  }

  /** Take a screen name (or swap to a new one). Resolves to null, or an error line for the player. */
  async claimScreenName(raw) {
    const name = String(raw).trim().toUpperCase();
    if (!SCREEN_NAME.test(name)) return "3-16 LETTERS, DIGITS, . _ OR -";
    if (!this.user || !this.fb) return "SIGN IN FIRST";
    if (name === this.screenName) return null;
    const { db, doc, runTransaction } = this.fb, uid = this.user.uid, old = this.screenName;
    try {
      await runTransaction(db, async tx => {
        const claim = await tx.get(doc(db, "screenNames", name));
        const entry = await tx.get(doc(db, "leaderboard", uid));
        if (claim.exists() && claim.data().uid !== uid) throw new Error("taken");
        tx.set(doc(db, "users", uid), { screenName: name }, { merge: true });
        tx.set(doc(db, "screenNames", name), { uid });
        if (old) tx.delete(doc(db, "screenNames", old));
        if (entry.exists()) tx.update(doc(db, "leaderboard", uid), { name });
      });
    } catch (e) {
      if (e.message === "taken") return "THAT NAME IS TAKEN";
      console.warn("screen name failed", e);
      return "COULD NOT SAVE - TRY AGAIN";
    }
    this.screenName = name;
    this.emit();
    return null;
  }

  /** Post an Endless result if it beats the player's best. Resolves to a status line. */
  async submitScore({ score, level, difficulty, city }) {
    if (!this.user) return "SIGN IN WITH GOOGLE TO POST SCORES";
    if (!this.screenName) return "SET A SCREEN NAME TO POST SCORES";
    if (score <= this.best) return `YOUR BEST: ${this.best.toLocaleString("en-US")}`;
    const { db, doc, setDoc, serverTimestamp } = this.fb;
    try {
      await setDoc(doc(db, "leaderboard", this.user.uid), {
        name: this.screenName, score, level, difficulty, city: String(city).slice(0, 60),
        date: new Date().toISOString().slice(0, 10), updated: serverTimestamp(),
      });
      this.best = score;
      this.emit();
      return "NEW PERSONAL BEST - POSTED TO THE LEADERBOARD";
    } catch (e) {
      console.warn("score post failed", e);
      return "COULD NOT POST SCORE";
    }
  }

  /** Top scores, plus the signed-in player's own entry and rank. */
  async fetchLeaderboard(n = 15) {
    if (!this.fb) throw new Error("offline");
    const { db, doc, getDoc, collection, query, orderBy, limit, where, getDocs, getCountFromServer } = this.fb;
    const board = collection(db, "leaderboard");
    const top = await getDocs(query(board, orderBy("score", "desc"), limit(n)));
    const rows = top.docs.map(d => ({ uid: d.id, ...d.data() }));
    let mine = null;
    if (this.user) {
      const own = rows.findIndex(r => r.uid === this.user.uid);
      if (own >= 0) mine = { ...rows[own], rank: own + 1 };
      else {
        const snap = await getDoc(doc(db, "leaderboard", this.user.uid));
        if (snap.exists()) {
          const above = await getCountFromServer(query(board, where("score", ">", snap.data().score)));
          mine = { uid: this.user.uid, ...snap.data(), rank: above.data().count + 1 };
        }
      }
    }
    return { rows, mine };
  }

  async signOut() {
    if (this.fb) await this.fb.signOut(this.fb.auth);
  }
}

/** Combine this device's save with the cloud one: the furthest campaign
 *  progress wins, finished lessons add up, and the Endless record with more
 *  matches played. */
function merge(local, cloud) {
  const out = clean(cloud);
  const a = local.campaign, b = cloud.campaign;
  if (a || b) {
    out.campaign = {
      mission: Math.max(a ? a.mission : 0, b ? b.mission : 0),
      completed: [...new Set([...(a ? a.completed : []), ...(b ? b.completed : [])])],
    };
  }
  out.tutorials = [...new Set([...local.tutorials, ...out.tutorials])];
  if (local.progress.history.length > cloud.progress.history.length) out.progress = local.progress;
  return out;
}
