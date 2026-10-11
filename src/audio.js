//=== Audio =================================================================
// Original sound manager: one sound object per Library.ini [Sounds] name
// (sub_432370, vtable 0x47415C: +28 play sub_432C01, +32 stop sub_432D0C).
// play() with mute on (byte_49AFCC) returns immediately (sub_432C01). A
// replay of a sound that is still playing restarts that single instance from
// the start: every [Sounds] entry is an .mp3, so sub_4324AE sets byte +96 and
// play goes to sub_43D206 (sub_43D400 stop + decoder reset, then Play), +32 to
// sub_43D400 and +36 to sub_43D5BE. Every sound plays at full gain except the four whose DirectSound
// buffer volume is set once at load (SFX_VOLUME_HDB below).
//
// Scene music (sub_41CE9A arg 4): menu scene MenuSound (IDA:13725), top-score
// scene TopScoreSound (IDA:17348); game (14819), help (17823), setup (17974),
// UFO/exit (18304) and reload (18749) scenes have none. Scene enter
// sub_41C9F8 loops it if not muted (IDA:12603); scene exit sub_41CAD4 stops it
// (IDA:12627). Top-score enter also loops BushSound (sub_427047 IDA:17722),
// exit stops it (sub_427125 IDA:17738).

// Library.ini [Sounds] name → file. JS keys in comments give the original name.
const AUDIO_MAP = {
  // Scene music (looped)
  menu:        'SvenTitle2.mp3',    // MenuSound
  topscore:    'Highscore.mp3',     // TopScoreSound
  bush:        'bush2.mp3',         // BushSound — top-score scene loop only
  // SFX
  game:        'chirp1.mp3',        // GameSound — bird chirp, see chirp hook
  start:       'start.mp3',         // StartSound
  points:      'Points.mp3',        // Points
  shag01:      'rammel1.mp3',       // Shag01
  shag02:      'rammel4.mp3',       // Shag02
  shag03:      'rammel5.mp3',       // Shag03
  shag04:      'rammel9.mp3',       // Shag04
  shag05:      'rammel10.mp3',      // Shag05
  shag06:      'rammel11.mp3',      // Shag06
  shag07:      'rammel12.mp3',      // Shag07
  shag08:      'rammel14.mp3',      // Shag08
  shag09:      'rammel15.mp3',      // Shag09
  shag10:      'rammel16.mp3',      // Shag10
  shag11:      'rammel18.mp3',      // Shag11
  shagSpecial: 'whip2.mp3',         // ShagSpecial
  kick:        'Hit1.mp3',          // Kick
  chew:        'chew2.mp3',         // Chew
  bleat1:      'bleat3.mp3',        // Mee1
  bleat2:      'bleat4.mp3',        // Mee2
  bleat3:      'bleat5.mp3',        // Mee3
  happy1:      'groan1.mp3',        // Happy1
  happy2:      'groan2.mp3',        // Happy2
  happy3:      'groan3.mp3',        // Happy3
  electro:     'Lightning.mp3',     // Lightning
  bark:        'bark.mp3',          // DogBark
  dogShag:     'shagAlf.mp3',       // DogShag (loaded by dog, IDA:838)
  devil:       'Devil1.mp3',        // Devil (IDA:20432)
  svenFight:   'Fight2.mp3',        // SvenFight (IDA:25285)
  sheepExplode:'ex_sheap.mp3',      // ExplodingSheep
  svenExplode: 'explode_sven.mp3',  // SvenExplodeSnd
  bomb:        'Bomb.mp3',          // Bomb (IDA:25412)
  beam:        'beam2.mp3',         // Beam (IDA:26990)
  beamLoop:    'beamloop.mp3',      // BeamLoop
  yell:        'rail5.mp3',         // ShepherdYell
  shepwalk1:   'Shepherdwalk_a.mp3',// ShepherdWalk1
  shepwalk2:   'Shepherdwalk_b.mp3',// ShepherdWalk2
  dogwalk1:    'Alf_c.mp3',         // DogWalk1
  dogwalk2:    'Alf_d.mp3',         // DogWalk2
  dogrun1:     'Alf_e.mp3',         // DogRun1
  dogrun2:     'Alf_f.mp3',         // DogRun2
  whistle:     'whistle.mp3',       // Whistle (IDA:25231)
  splash:      'water_splash1.mp3', // Splash (IDA:25209/25363)
  mushMode:    'Mush-mode.mp3',     // MushMode
  goodFlower:  'Mush_red.mp3',      // GoodFlower
  badFlower:   'Mush_grey.mp3',     // BadFlower
  saintSven:   'saintSven1.mp3',    // SvenSaint
  byebye:      'ByeBye.mp3',        // ByeBye (sub_4281D8 IDA:18315)
  ufo:         'UFO.mp3',           // UFO (IDA:26587)
  alienReturn: 'ground_touch.mp3',  // AlienReturn
  easteregg:   'EasterEgg.mp3',     // Cards (IDA:14194)
  time:        'time.mp3',          // Time (IDA:16123)
  gameover:    'game_over.mp3',     // GameOverSfx (IDA:16312)
  alarm:       'Alarm2.mp3',        // Alarm (IDA:16237)
};
// IDirectSoundBuffer::SetVolume (sub_43D4E5 → buffer vtable+60) in hundredths
// of a dB, applied once when the owner loads the sound: dog init sub_40248F
// (IDA:854, 866, 875), sheep scene init (IDA:21537). Gain = 10^(hdB/2000).
const SFX_VOLUME_HDB = { bark: -750, dogwalk1: -1000, dogwalk2: -1000, sheepExplode: -1000 };
// Looped scene tracks (streamed <audio>); everything else is a decoded SFX.
const MUSIC_KEYS = ['menu', 'topscore', 'bush'];
// Music per scene (sub_41CE9A callers); BushSound is added on top-score.
const SCENE_MUSIC = { menu: ['menu'], topscore: ['topscore', 'bush'] };

// Sheep sound table at 0x494718 {ShagSpecial, Shag01..11, Mee1-3, Happy1-3};
// the Shag part is played by sheep.js (SHEEP_SHAG_SFX, sub_42CD53).
const BLEAT_SFX_KEYS = ['bleat1', 'bleat2', 'bleat3'];   // Mee1..3
const HAPPY_SFX_KEYS = ['happy1', 'happy2', 'happy3'];   // Happy1..3

// Game-scene SFX stopped by sub_42038C (game scene vtable+56: scene exit
// sub_4202CA and mute-on, IDA:13305). Original names in order.
const GAME_SCENE_SFX = ['start', 'svenFight', 'saintSven', 'yell', 'kick', 'chew',
  'splash', 'mushMode', 'game', 'dogShag', 'bark', /* Electro: not in Library.ini */
  'sheepExplode', 'gameover', 'alarm', 'beam', 'beamLoop', 'bomb', 'devil',
  'electro', 'ufo', 'svenExplode', 'whistle'];

class AudioBank {
  constructor() {
    this.sfx = {};            // key → { buffer } | { fallback: <audio> }
    this.active = {};         // key → playing AudioBufferSourceNode (one per sound)
    this.music = {};          // key → looping <audio>
    this.scene = null;        // scene whose music is current ('menu'|'topscore'|'game'|null)
    this.enabled = false;
    this.muted = false;       // byte_49AFCC, toggled by 's' (IDA:13304)
    this.ctx = null;
    this.masterGain = null;
    // GameSound countdown, game scene +448: set to 200 once (ctor IDA:14407,
    // loader IDA:14933) and never reset on scene/level entry; decremented once
    // per game-scene tick (IDA:15614), on 0 play + reload rand()%50+200.
    this.chirpCounter = 200;
    // Global GetTickCount throttles: dword_49BA38 (chew), dword_49BA3C (Mee).
    this.lastChewMs = 0;
    this.lastMeeMs = 0;
  }
  // onReady(key): called once per AUDIO_MAP key when its object exists (music
  // <audio> at creation, SFX after decode / fallback) — drives the [Sounds]
  // part of the loading bar (sub_40E61E IDA:6853, game.js load).
  async load(onReady) {
    const ready = (k) => { if (typeof onReady === 'function') try { onReady(k); } catch {} };
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC && !this.ctx) {
      this.ctx = new AC();
      this.masterGain = this.ctx.createGain();
      this.masterGain.connect(this.ctx.destination);
    }
    const decodes = [];
    for (const [name, file] of Object.entries(AUDIO_MAP)) {
      if (MUSIC_KEYS.includes(name)) {
        const a = new Audio(ASSETS + file);
        a.preload = 'auto';
        a.loop = true;
        this.music[name] = a;
        ready(name);
        continue;
      }
      decodes.push((async () => {
        try {
          const res = await fetch(ASSETS + file);
          const arr = await res.arrayBuffer();
          const buffer = this.ctx ? await this.ctx.decodeAudioData(arr.slice(0)) : null;
          this.sfx[name] = buffer ? { buffer } : { fallback: new Audio(ASSETS + file) };
        } catch (e) {
          this.sfx[name] = { fallback: new Audio(ASSETS + file) };
        }
        ready(name);
      })());
    }
    await Promise.all(decodes);
  }
  enable() {
    const wasDisabled = !this.enabled;
    this.enabled = true;
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    // First user gesture: start the music of the scene requested so far
    // (none before the title enter; sub_41C9F8 IDA:12603 starts it there).
    if (wasDisabled) this._startSceneMusic(this.scene);
  }
  // 's' key (IDA:13304-13310): mute-on calls scene vtable+56 (stop music;
  // game scene: sub_42038C stops all game SFX), mute-off calls +52 (replay
  // the scene loops from the start: sub_41DADE / sub_4271B1).
  // menuOnce: help/setup +52 (sub_4274A2 / sub_428044) = sub_40F34C(MenuSound)
  // → sound vtable+28(0,0): MenuSound once from the start, not looped.
  toggleMute(menuOnce = false) {
    this.muted = !this.muted;
    if (this.muted) {
      this._stopMusic();
      if (this.scene === 'game') this.stopGameSfx();
      // Top Scores +56 = sub_4271F8 also stops GameSound this[39] (IDA:17760).
      if (this.scene === 'topscore') this.stop('game');
    } else if (menuOnce) {
      const a = this.music.menu;
      if (a && this.enabled) {
        try { a.loop = false; a.currentTime = 0; } catch {}
        a.play().catch(() => {});
      }
    } else {
      this._startSceneMusic(this.scene);
    }
    return this.muted;
  }
  // Scene change: exit stops the old scene's music (sub_41CAD4), enter loops
  // the new scene's music (sub_41C9F8). which: 'menu' | 'topscore' | 'game' |
  // null (help/setup/reload/UFO scenes — no music). Re-requesting the current
  // scene is a no-op.
  playAmbient(which) {
    which = which || null;
    if (this.scene === which) return;
    this.scene = which;
    this._stopMusic();
    if (this.enabled) this._startSceneMusic(which);
  }
  stopAmbient() { this.playAmbient(null); }
  // Base scene pause/resume (sub_41CB4E / sub_41CBB4, IDA:12640/12656) touch only
  // the scene sound this[8] (MenuSound / TopScoreSound). On the +68-only path
  // (focus loss, sub_4115B9) BushSound (top-score this[27]) keeps looping; the
  // boss key first calls +56 = sub_4271F8, which stops it (stopHighScoreSounds),
  // and +72 restarts only this[8]. +36 = sub_432D8A → sub_43D5BE (buffer Stop,
  // byte +96 MP3 path); +40 = sub_432DBB → sub_43D206(1): sub_43D400 (stop, free
  // the decoder) then play looped — the music restarts from the beginning.
  // Resume only if !byte_49AFCC.
  pauseMusic() {
    const key = (SCENE_MUSIC[this.scene] || [])[0];
    const a = key && this.music[key];
    if (a) try { a.pause(); } catch {}
  }
  resumeMusic() {
    if (!this.enabled || this.muted) return;    // !byte_49AFCC (IDA:12688)
    const key = (SCENE_MUSIC[this.scene] || [])[0];
    const a = key && this.music[key];
    if (!a) return;
    try { a.loop = true; a.currentTime = 0; } catch {}
    a.play().catch(() => {});
  }
  // Top Scores vtable+56 sub_4271F8 (IDA:17760): stop TopScoreSound this[8],
  // BushSound this[27] and GameSound this[39] (sound vtable+32 = sub_432D0C →
  // sub_43D400 on the MP3 path; every later play restarts from the start).
  // Boss key path (sub_41D8FC).
  stopHighScoreSounds() {
    for (const key of ['topscore', 'bush']) {
      const a = this.music[key];
      if (a) try { a.pause(); } catch {}
    }
    this.stop('game');
  }
  // App focus loss/gain (R4-r7-439000-01): every sound is a DirectSound buffer
  // with flags 65762 = 0x100E2 (sub_43C855 IDA:27770, no GLOBALFOCUS/
  // STICKYFOCUS) on a DSSCL_NORMAL device (sub_43C771 IDA:27684), so the music
  // is focus-muted like the SFX: it keeps playing inaudibly and is heard again
  // at its advanced position. Mute only — no pause, no rewind. Also covers the
  // <audio> fallbacks of SFX that could not be decoded (same buffer class).
  setMusicAudible(on) {
    for (const a of Object.values(this.music)) try { a.muted = !on; } catch {}
    for (const e of Object.values(this.sfx)) if (e && e.fallback) try { e.fallback.muted = !on; } catch {}
  }
  _stopMusic() {
    for (const a of Object.values(this.music)) {
      try { a.pause(); a.currentTime = 0; } catch {}
    }
  }
  _startSceneMusic(which) {
    this.scene = which;
    if (!this.enabled || this.muted) return;      // IDA:12603 `!byte_49AFCC`
    for (const key of SCENE_MUSIC[which] || []) {
      const a = this.music[key];
      if (!a) continue;
      try { a.loop = true; a.currentTime = 0; } catch {}   // sub_41C9F8: play(0,1) looped
      a.play().catch(() => {});
    }
  }
  // sub_432C01: one instance per sound; replay restarts it. loop = Play flag.
  play(name, loop = false) {
    if (!this.enabled || this.muted) return;
    const entry = this.sfx[name];
    if (!entry) return;
    this.stop(name);
    if (entry.buffer && this.ctx) {
      try {
        if (this.ctx.state === 'suspended') this.ctx.resume();
        const src = this.ctx.createBufferSource();
        src.buffer = entry.buffer;
        src.loop = !!loop;
        const hdb = SFX_VOLUME_HDB[name];
        if (hdb) {
          const gn = this.ctx.createGain();
          gn.gain.value = Math.pow(10, hdb / 2000);
          src.connect(gn); gn.connect(this.masterGain);
        } else src.connect(this.masterGain);
        src.onended = () => { if (this.active[name] === src) delete this.active[name]; };
        this.active[name] = src;
        src.start(0);
      } catch {}
      return;
    }
    if (entry.fallback) {
      try {
        entry.fallback.loop = !!loop;
        entry.fallback.volume = Math.pow(10, (SFX_VOLUME_HDB[name] || 0) / 2000);
        entry.fallback.currentTime = 0;
        entry.fallback.play().catch(() => {});
      } catch {}
    }
  }
  // sub_432D0C
  stop(name) {
    const src = this.active[name];
    if (src) {
      delete this.active[name];
      try { src.stop(); } catch {}
    }
    const entry = this.sfx[name];
    if (entry && entry.fallback) {
      try { entry.fallback.pause(); entry.fallback.currentTime = 0; } catch {}
    }
  }
  // sub_42038C: stop every game-scene SFX (game scene exit / mute-on).
  stopGameSfx() {
    for (const k of GAME_SCENE_SFX) this.stop(k);
  }
  // Game-scene tick part of the GameSound countdown (IDA:15614-15624).
  // Driven by the GAME_TICK_HOOKS entry below — one call per unpaused tick.
  chirpTick() {
    if (--this.chirpCounter === 0) {
      this.play('game');
      this.chirpCounter = 200 + Math.floor(Math.random() * 50);
    }
  }
  // sub_42C2C0 case 3 (IDA:20317-20322): chew on chew-state entry, global
  // 2000 ms GetTickCount throttle (dword_49BA38).
  playChewThrottled() {
    const now = getTickCount();
    if (now - this.lastChewMs > 2000) {
      this.play('chew');
      this.lastChewMs = now;
    }
  }
  // sub_42D08E cases 1/2 (IDA:20741-20768): random Mee (rand()%3), global
  // 3000 ms throttle (dword_49BA3C).
  playMeeThrottled() {
    const now = getTickCount();
    if (now - this.lastMeeMs > 3000) {
      this.play(BLEAT_SFX_KEYS[Math.floor(Math.random() * 3)]);
      this.lastMeeMs = now;
    }
  }
  // sub_42D08E cases 11/12 (IDA:20818-20826): random Happy (rand()%3).
  playHappy() {
    this.play(HAPPY_SFX_KEYS[Math.floor(Math.random() * 3)]);
  }
}

// GameSound countdown runs on every unpaused game-scene tick (IDA:15614 is
// skipped only by boss screen +452, help/pause +20/+24 and the +608 overlay).
// The +608 level-transition blink skips the whole tick (game.js returns
// before the hooks), as IDA:16184-16191 does.
GAME_TICK_HOOKS.push(function () { if (this.audio) this.audio.chirpTick(); });
