// Sound events, voiced like an old-school terminal: key clicks, relay clunks,
// speaker beeps and static, all played through a small-speaker filter chain
// over a quiet CRT hum. Samples are CC0 (Kenney.nl, see sfx/LICENSE.txt);
// anything without a sample, or whose sample failed to load, falls back to a
// synthesised square-wave beep or noise burst. Event names and minimum gaps
// match the reference SOUNDS table.

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

// [files in sfx/ (one picked at random), gain, options]. Options: repeat/every
// play a run of hits (teletype chatter), cut fades the sample out early.
const SAMPLE = {
  ui_hover: [["tick_001", "tick_002"], 0.35], ui_select: [["click2", "click4", "click5"], 0.6],
  ui_back: [["back_002"], 0.5], ui_deploy_ok: [["confirmation_001"], 0.45], ui_deny: [["error_004"], 0.5],
  ui_tool_locked: [["error_001"], 0.5], ui_unlock: [["threeTone1"], 0.35], ui_pause: [["toggle_001"], 0.45],
  ui_resume: [["toggle_002"], 0.45], ui_speed: [["select_002"], 0.4], ui_undo: [["scratch_001"], 0.35],
  ui_alert: [["twoTone1"], 0.3], ui_briefing: [["click2", "click4", "click5"], 0.45, { repeat: 16, every: 0.055 }],
  infantry_fire: [["glitch_001", "glitch_002", "glitch_004"], 0.4, { repeat: 3, every: 0.07 }],
  pistol_shot: [["glitch_003"], 0.35], sniper_shot: [["switch_003"], 0.6],
  minigun: [["glitch_001", "glitch_002", "glitch_004"], 0.35, { repeat: 8, every: 0.04 }],
  mine_arm: [["select_001"], 0.4], paradrop_land: [["click_005"], 0.5], barricade_place: [["switch_002"], 0.7],
  barricade_breach: [["impactMetal_000"], 0.7], car_crash: [["scratch_002"], 0.5], artillery_launch: [["bong_001"], 0.6],
  explosion_large: [["explosionCrunch_001", "explosionCrunch_003"], 0.8], explosion_small: [["explosionCrunch_000"], 0.6],
  drone_detonate: [["explosionCrunch_000", "explosionCrunch_002"], 0.6], car_cookoff: [["explosionCrunch_002"], 0.5],
  mine_ignite: [["explosionCrunch_000"], 0.5], unit_destroyed: [["explosionCrunch_002"], 0.6],
  bomb_chain: [["explosionCrunch_004"], 0.8], building_collapse: [["lowFrequency_explosion_000"], 0.9, { cut: 1.4 }],
  trojan_crash: [["lowFrequency_explosion_001"], 1.0],
  zombie_turn: [["lowDown"], 0.25], civilian_scream: [["highUp"], 0.12],
  victory: [["powerUp1"], 0.4], defeat: [["zapThreeToneDown"], 0.35], campaign_complete: [["powerUp3"], 0.45],
  threat_up: [["zapThreeToneUp"], 0.3], threat_down: [["lowThreeTone"], 0.3],
};

// Fallbacks / PC-speaker voices. [kind, freq, duration, gain, extra]: "noise" bursts
// (low-passed at freq) or square "tone" sweeps (freq -> extra).
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
const HUM_LEVEL = 0.05;   // CRT hum + fan at full music volume

export class Audio {
  constructor(volume) {
    this.volume = volume;          // channel name -> 0..1
    this.ctx = null;
    this.last = {};
    this.noise = null;
    this.out = null;               // input of the terminal-speaker chain
    this.hum = null;
    this.buffers = {};             // sfx file name -> AudioBuffer once decoded
  }

  /** Browsers only allow audio after a user gesture. */
  unlock() {
    if (this.ctx) { if (this.ctx.state === "suspended") this.ctx.resume(); return; }
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const n = this.ctx.sampleRate * 1.5, buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      this.noise = buf;
      this.out = this.speaker();
      this.hum = this.startHum();
      this.load();
    } catch { this.ctx = null; }
  }

  /** Small boxy speaker: no lows, no highs, a honky midrange and soft clipping. */
  speaker() {
    const c = this.ctx;
    const hp = c.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 220;
    const mid = c.createBiquadFilter(); mid.type = "peaking"; mid.frequency.value = 1800; mid.Q.value = 1; mid.gain.value = 5;
    const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 4800;
    const clip = c.createWaveShaper(), curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(1.6 * (i / 511.5 - 1)) / Math.tanh(1.6);
    clip.curve = curve;
    const comp = c.createDynamicsCompressor();
    hp.connect(mid); mid.connect(lp); lp.connect(clip); clip.connect(comp); comp.connect(c.destination);
    return hp;
  }

  /** Mains hum and a cooling fan, bypassing the speaker chain so the low end survives. */
  startHum() {
    const c = this.ctx, g = c.createGain();
    g.gain.value = 0;
    g.connect(c.destination);
    for (const [f, a] of [[60, 0.5], [120, 0.3], [180, 0.12]]) {
      const o = c.createOscillator(), og = c.createGain();
      o.frequency.value = f; og.gain.value = a;
      o.connect(og); og.connect(g); o.start();
    }
    const fan = c.createBufferSource(), bp = c.createBiquadFilter(), fg = c.createGain();
    fan.buffer = this.noise; fan.loop = true;
    bp.type = "bandpass"; bp.frequency.value = 500; bp.Q.value = 0.7; fg.gain.value = 0.35;
    fan.connect(bp); bp.connect(fg); fg.connect(g); fan.start();
    return g;
  }

  load() {
    const names = new Set(Object.values(SAMPLE).flatMap(s => s[0]));
    for (const name of names) {
      fetch(new URL(`../sfx/${name}.ogg`, import.meta.url))
        .then(r => r.ok ? r.arrayBuffer() : Promise.reject(r.status))
        .then(b => this.ctx.decodeAudioData(b))
        .then(buf => { this.buffers[name] = buf; })
        .catch(() => {});   // keep the synth fallback
    }
  }

  /** Follow the music slider; call once per frame. */
  update() {
    if (!this.hum) return;
    this.hum.gain.setTargetAtTime(HUM_LEVEL * this.volume("music"), this.ctx.currentTime, 0.1);
  }

  play(event) {
    if (!this.ctx || this.ctx.state !== "running" || !(SAMPLE[event] || VOICE[event])) return;
    const now = this.ctx.currentTime;
    if (now - (this.last[event] ?? -1e9) < (GAP[event] ?? 0.1)) return;
    this.last[event] = now;
    const vol = this.volume(MUSIC_CHANNEL.has(event) ? "music" : "sfx");
    if (vol <= 0) return;
    const s = SAMPLE[event], bufs = s ? s[0].map(n => this.buffers[n]).filter(Boolean) : [];
    if (bufs.length) this.sample(bufs, s[1] * vol, s[2] ?? {}, now);
    else if (VOICE[event]) this.synth(VOICE[event], vol, now);
  }

  sample(bufs, gain, { repeat = 1, every = 0, cut = 0 }, now) {
    for (let i = 0; i < repeat; i++) {
      const t = now + i * every * (0.8 + 0.4 * Math.random());
      const src = this.ctx.createBufferSource(), g = this.ctx.createGain();
      src.buffer = bufs[Math.floor(Math.random() * bufs.length)];
      src.playbackRate.value = 0.94 + 0.12 * Math.random();
      g.gain.setValueAtTime(gain * (repeat > 1 ? 0.75 + 0.25 * Math.random() : 1), t);
      if (cut) g.gain.setTargetAtTime(0, t + cut, 0.1);
      src.connect(g); g.connect(this.out);
      src.start(t);
      if (cut) src.stop(t + cut + 0.6);
    }
  }

  synth([kind, freq, dur, gain, extra], vol, now) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain * vol, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    g.connect(this.out);
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
