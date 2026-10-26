// Sound events. The reference build's audio files are placeholders that
// aren't shipped, so the web port synthesises short effects with WebAudio.
// Event names and minimum gaps match the reference SOUNDS table.

const GAP = {
  lz_lift: 3.0, paradrop: 0.3, paradrop_land: 0.3, infantry_fire: 0.25, sniper_shot: 0.3, minigun: 0.4,
  pistol_shot: 0.2, artillery_launch: 0.5, shell_whistle: 0.5, explosion_large: 0.15, explosion_small: 0.15,
  airstrike_jet: 0.5, bomber_flyby: 0.5, bomb_chain: 1.0, building_collapse: 0.6, barricade_place: 0.2,
  barricade_breach: 0.5, mine_arm: 0.2, mine_ignite: 0.3, drone_launch: 0.3, drone_detonate: 0.3, car_alarm: 1.0,
  car_cookoff: 0.2, unit_destroyed: 0.5, trojan_crash: 0, zombie_turn: 1.5, civilian_scream: 2.5, splash: 1.0,
  drown: 1.0, tire_screech: 0.5, car_crash: 0.3, car_horn: 1.0, train_horn: 2.0, ui_hover: 0.03, ui_select: 0.03,
  ui_back: 0.05, ui_deploy_ok: 0.05, ui_deny: 0.15, ui_tool_locked: 0.2, ui_unlock: 0, ui_pause: 0.05,
  ui_resume: 0.05, ui_speed: 0.05, ui_undo: 0.05, ui_alert: 0.6, ui_briefing: 0, victory: 0, defeat: 0,
  campaign_complete: 0, threat_up: 0, threat_down: 0,
};

// [kind, freq, duration, gain, extra]: "noise" bursts (low-passed at freq) or "tone" sweeps (freq -> extra).
const VOICE = {
  infantry_fire: ["noise", 2500, 0.08, 0.25], sniper_shot: ["noise", 3500, 0.12, 0.35], pistol_shot: ["noise", 3000, 0.05, 0.2],
  minigun: ["noise", 2200, 0.25, 0.22], explosion_large: ["noise", 300, 0.9, 0.7], explosion_small: ["noise", 600, 0.4, 0.45],
  drone_detonate: ["noise", 400, 0.7, 0.6], car_cookoff: ["noise", 500, 0.5, 0.45], building_collapse: ["noise", 180, 1.2, 0.5],
  artillery_launch: ["noise", 800, 0.3, 0.4], shell_whistle: ["tone", 1800, 0.8, 0.08, 500], airstrike_jet: ["noise", 1200, 1.2, 0.25],
  bomber_flyby: ["noise", 900, 1.5, 0.25], bomb_chain: ["noise", 250, 1.2, 0.5], barricade_place: ["tone", 220, 0.12, 0.2, 180],
  barricade_breach: ["noise", 350, 0.6, 0.5], mine_arm: ["tone", 1200, 0.08, 0.12, 1500], mine_ignite: ["noise", 900, 0.6, 0.4],
  drone_launch: ["tone", 600, 0.25, 0.12, 1200], unit_destroyed: ["noise", 400, 0.5, 0.45], trojan_crash: ["noise", 200, 1.4, 0.7],
  zombie_turn: ["tone", 140, 0.5, 0.15, 70], civilian_scream: ["tone", 1100, 0.35, 0.06, 1500], splash: ["noise", 1500, 0.3, 0.15],
  drown: ["noise", 700, 0.4, 0.12], tire_screech: ["tone", 1800, 0.35, 0.05, 1500], car_crash: ["noise", 700, 0.35, 0.35],
  car_horn: ["tone", 420, 0.3, 0.06, 420], train_horn: ["tone", 300, 1.0, 0.1, 290], car_alarm: ["tone", 900, 0.4, 0.05, 1300],
  lz_lift: ["noise", 160, 1.2, 0.2], paradrop: ["noise", 1800, 0.5, 0.12], paradrop_land: ["noise", 300, 0.2, 0.25],
  ui_hover: ["tone", 1200, 0.03, 0.04, 1200], ui_select: ["tone", 900, 0.06, 0.08, 1300], ui_back: ["tone", 700, 0.06, 0.08, 450],
  ui_deploy_ok: ["tone", 700, 0.08, 0.1, 1100], ui_deny: ["tone", 220, 0.15, 0.12, 160], ui_tool_locked: ["tone", 300, 0.12, 0.1, 250],
  ui_unlock: ["tone", 600, 0.3, 0.12, 1400], ui_pause: ["tone", 500, 0.06, 0.08, 400], ui_resume: ["tone", 400, 0.06, 0.08, 600],
  ui_speed: ["tone", 800, 0.05, 0.06, 1000], ui_undo: ["tone", 900, 0.08, 0.08, 500], ui_alert: ["tone", 1000, 0.1, 0.06, 1000],
  ui_briefing: ["tone", 1400, 0.05, 0.05, 1400],
  victory: ["tone", 440, 1.0, 0.15, 880], defeat: ["tone", 300, 1.2, 0.15, 110], campaign_complete: ["tone", 523, 1.5, 0.15, 1046],
  threat_up: ["tone", 300, 0.6, 0.12, 600], threat_down: ["tone", 600, 0.6, 0.12, 300],
};
const MUSIC_CHANNEL = new Set(["victory", "defeat", "campaign_complete", "threat_up", "threat_down"]);

export class Audio {
  constructor(volume) {
    this.volume = volume;          // channel name -> 0..1
    this.ctx = null;
    this.last = {};
    this.noise = null;
  }

  /** Browsers only allow audio after a user gesture. */
  unlock() {
    if (this.ctx) { if (this.ctx.state === "suspended") this.ctx.resume(); return; }
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const n = this.ctx.sampleRate * 1.5, buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      this.noise = buf;
    } catch { this.ctx = null; }
  }

  play(event) {
    const v = VOICE[event];
    if (!this.ctx || !v || this.ctx.state !== "running") return;
    const now = this.ctx.currentTime;
    if (now - (this.last[event] ?? -1e9) < (GAP[event] ?? 0.1)) return;
    this.last[event] = now;
    const vol = this.volume(MUSIC_CHANNEL.has(event) ? "music" : "sfx");
    if (vol <= 0) return;
    const [kind, freq, dur, gain, extra] = v;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain * vol, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    g.connect(this.ctx.destination);
    let src;
    if (kind === "noise") {
      src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      const f = this.ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.setValueAtTime(freq, now);
      src.connect(f);
      f.connect(g);
    } else {
      src = this.ctx.createOscillator();
      src.type = "square";
      src.frequency.setValueAtTime(freq, now);
      src.frequency.exponentialRampToValueAtTime(Math.max(20, extra), now + dur);
      src.connect(g);
    }
    src.start(now);
    src.stop(now + dur + 0.05);
  }
}
