// Saved progress: options, Endless threat level / history, Story campaign.
// Always kept in localStorage; when signed in with Google it is also
// synced to Firestore (users/{uid}) so it follows the player anywhere.
import { DEFAULT_OPTIONS, CAMPAIGN } from "./consts.js";
import { firebaseConfig } from "./firebase-config.js";

const LOCAL_KEY = "zombie-evac-save-v1";
const SDK = "https://www.gstatic.com/firebasejs/10.12.2";

function blank() {
  return { options: { ...DEFAULT_OPTIONS }, progress: { level: 0, history: [] }, campaign: null };
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
  }

  get options() { return this.data.options; }
  get progress() { return this.data.progress; }
  get campaign() { return this.data.campaign; }
  set campaign(c) { this.data.campaign = validCampaign(c); this.save(); }

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
      await setDoc(doc(db, "users", this.user.uid), { ...this.data, updated: serverTimestamp() });
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
      this.status = "";
      this.emit();
      return;
    }
    this.user = { uid: user.uid, name: user.displayName || user.email || "AGENT", email: user.email };
    this.status = "LOADING SAVE...";
    this.emit();
    const { db, doc, getDoc } = this.fb;
    try {
      const snap = await getDoc(doc(db, "users", user.uid));
      if (snap.exists()) this.data = merge(this.data, clean(snap.data()));
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

  async signOut() {
    if (this.fb) await this.fb.signOut(this.fb.auth);
  }
}

/** Combine this device's save with the cloud one: the furthest campaign
 *  progress wins, and the Endless record with more matches played. */
function merge(local, cloud) {
  const out = clean(cloud);
  const a = local.campaign, b = cloud.campaign;
  if (a || b) {
    out.campaign = {
      mission: Math.max(a ? a.mission : 0, b ? b.mission : 0),
      completed: [...new Set([...(a ? a.completed : []), ...(b ? b.completed : [])])],
    };
  }
  if (local.progress.history.length > cloud.progress.history.length) out.progress = local.progress;
  return out;
}
