// Virtual-time task scheduler with adjustable speed (for fast tests / "skip" in solo).
// Reusable: any timer-driven game loop can run on it in browser or node.
export class Scheduler {
  constructor({ speed = 1, now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (h) => clearTimeout(h) } = {}) {
    this.speed = speed;
    this._now = now; this._set = setTimer; this._clear = clearTimer;
    this.realBase = now(); this.vBase = 0;
    this.tasks = []; // {at, fn, tag}
    this.handle = null;
    this.disposed = false;
  }
  vnow() { return this.vBase + (this._now() - this.realBase) * this.speed; }
  /** real milliseconds until virtual time `vt` */
  realUntil(vt) { return Math.max(0, (vt - this.vnow()) / this.speed); }
  after(ms, fn, tag = '') {
    const t = { at: this.vnow() + ms, fn, tag };
    this.tasks.push(t);
    this._arm();
    return t;
  }
  cancel(tagOrTask) {
    this.tasks = this.tasks.filter((t) => (typeof tagOrTask === 'string' ? t.tag !== tagOrTask : t !== tagOrTask));
    this._arm();
  }
  clear() { this.tasks = []; this._arm(); }
  setSpeed(s) {
    this.vBase = this.vnow(); this.realBase = this._now(); this.speed = s; this._arm();
  }
  dispose() { this.disposed = true; this.clear(); }
  _arm() {
    if (this.handle) { this._clear(this.handle); this.handle = null; }
    if (this.disposed || !this.tasks.length) return;
    let next = this.tasks[0];
    for (const t of this.tasks) if (t.at < next.at) next = t;
    this.handle = this._set(() => this._run(), Math.max(0, this.realUntil(next.at)) + 1);
  }
  _run() {
    this.handle = null;
    const now = this.vnow();
    // run all due tasks in order
    for (;;) {
      if (this.disposed) return;
      let next = null;
      for (const t of this.tasks) if (t.at <= now + 0.5 && (!next || t.at < next.at)) next = t;
      if (!next) break;
      this.tasks.splice(this.tasks.indexOf(next), 1);
      try { next.fn(); } catch (e) { console.error('[scheduler] task error', e); }
    }
    this._arm();
  }
}
