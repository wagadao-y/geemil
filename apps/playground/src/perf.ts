import type { WebGLRenderer } from 'three';

type TimerQueryExt = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };

export interface RenderStats {
  /** Renders per second over the last window. */
  fps: number;
  /** Mean interval between renders, in milliseconds. */
  frameMs: number;
  /** Mean CPU time spent in renderer.render(). */
  cpuMs: number;
  /** Mean GPU time of the measured renders, or null when timer queries are unavailable. */
  gpuMs: number | null;
  drawCalls: number;
  points: number;
}

/**
 * Averages render timings over a window. GPU time comes from EXT_disjoint_timer_query_webgl2,
 * whose results arrive a few frames later and are discarded when the GPU reports a disjoint.
 */
export class RenderProfiler {
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: TimerQueryExt | null;
  private readonly pending: WebGLQuery[] = [];
  private windowStart = performance.now();
  private lastRenderAt: number | null = null;
  private renders = 0;
  private intervalSum = 0;
  private intervals = 0;
  private cpuSum = 0;
  private gpuSum = 0;
  private gpuSamples = 0;
  private drawCalls = 0;
  private points = 0;

  private readonly renderer: WebGLRenderer;

  constructor(renderer: WebGLRenderer) {
    this.renderer = renderer;
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null;
  }

  get gpuTimerAvailable(): boolean {
    return this.ext !== null;
  }

  /** Run one render and record its cost. Only one timer query may be active, so do not nest. */
  measure(render: () => void): void {
    const { gl, ext } = this;
    let query: WebGLQuery | null = null;
    // Bound the backlog if results stop arriving, e.g. while the tab is hidden.
    if (ext && this.pending.length < 8) {
      query = gl.createQuery();
      if (query) gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    }
    // One frame may call renderer.render several times (EDL does), so sum them all.
    const info = this.renderer.info;
    const autoReset = info.autoReset;
    info.autoReset = false;
    info.reset();
    const startedAt = performance.now();
    try {
      render();
    } finally {
      info.autoReset = autoReset;
    }
    const endedAt = performance.now();
    if (query) {
      gl.endQuery(ext!.TIME_ELAPSED_EXT);
      this.pending.push(query);
    }
    // renderer.info is reset by every later render, so read it before a pick renders.
    this.drawCalls = this.renderer.info.render.calls;
    this.points = this.renderer.info.render.points;
    this.cpuSum += endedAt - startedAt;
    this.renders++;
    if (this.lastRenderAt !== null) {
      this.intervalSum += startedAt - this.lastRenderAt;
      this.intervals++;
    }
    this.lastRenderAt = startedAt;
  }

  /** Collect finished GPU queries; returns the window's averages once `windowMs` has passed. */
  poll(windowMs = 500): RenderStats | null {
    this.collectQueries();
    const now = performance.now();
    const elapsed = now - this.windowStart;
    if (elapsed < windowMs) return null;
    const stats: RenderStats = {
      fps: (this.renders * 1000) / elapsed,
      frameMs: this.intervals ? this.intervalSum / this.intervals : 0,
      cpuMs: this.renders ? this.cpuSum / this.renders : 0,
      gpuMs: this.gpuSamples ? this.gpuSum / this.gpuSamples : null,
      drawCalls: this.drawCalls,
      points: this.points,
    };
    this.windowStart = now;
    this.renders = this.intervals = this.gpuSamples = 0;
    this.intervalSum = this.cpuSum = this.gpuSum = 0;
    return stats;
  }

  /** Forget the interval to the previous render, e.g. after rendering was paused. */
  resetInterval(): void {
    this.lastRenderAt = null;
  }

  private collectQueries(): void {
    const { gl, ext } = this;
    if (!ext) return;
    while (this.pending.length > 0) {
      const query = this.pending[0]!;
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
      if (!disjoint) {
        this.gpuSum += (gl.getQueryParameter(query, gl.QUERY_RESULT) as number) / 1e6;
        this.gpuSamples++;
      }
      gl.deleteQuery(query);
    }
  }

  dispose(): void {
    for (const query of this.pending.splice(0)) this.gl.deleteQuery(query);
  }
}
