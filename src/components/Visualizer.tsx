import { useEffect, useRef } from "react";
import { onSpectrum } from "../lib/engine";
import { isTauri } from "../lib/tauri";

const DEFAULT_BINS = 64;
/** Per-60 Hz-frame damping toward the newest analyser frame. */
const SMOOTHING = 0.22;

interface VisualizerProps {
  enabled: boolean;
  className?: string;
}

/**
 * Spectrum canvas.
 *
 * Mirrored bars growing from a centre line, in the accent red with a fade
 * toward the treble end. The analyser pushes frames at ~45 Hz while the canvas
 * repaints at display rate, so the displayed values are damped toward the
 * incoming ones every animation frame — that is what keeps it from looking
 * steppy.
 */
export function Visualizer({ enabled, className = "" }: VisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const targetRef = useRef(new Float32Array(DEFAULT_BINS));
  const shownRef = useRef(new Float32Array(DEFAULT_BINS));

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;

    onSpectrum((payload) => {
      const bins = payload.bins;
      if (targetRef.current.length !== bins.length) {
        targetRef.current = new Float32Array(bins.length);
        shownRef.current = new Float32Array(bins.length);
      }
      const target = targetRef.current;
      for (let i = 0; i < bins.length; i += 1) target[i] = bins[i];
    }).then((off) => {
      if (cancelled) off();
      else dispose = off;
    });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [enabled]);

  /* Browser-only fixture. Outside the Tauri shell there is no analyser thread,
     so the canvas would sit empty; this synthesises a plausible spectrum at the
     same ~45 Hz so the component stays reviewable in `npm run dev`. */
  useEffect(() => {
    if (!enabled || isTauri()) return;
    const started = performance.now();

    const timer = window.setInterval(() => {
      const elapsed = (performance.now() - started) / 1000;
      const target = targetRef.current;

      for (let i = 0; i < target.length; i += 1) {
        const position = i / target.length;
        const tilt = Math.pow(1 - position, 1.1); // bass-heavy, like real music
        const partial = 0.5 + 0.5 * Math.sin(elapsed * 1.7 + position * 9);
        const wobble = 0.5 + 0.5 * Math.sin(elapsed * 0.9 + position * 3.1);
        target[i] = Math.min(1, Math.max(0, tilt * partial * wobble * 1.6));
      }
    }, 22);

    return () => window.clearInterval(timer);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let handle = 0;
    let previous = performance.now();

    const render = (now: number) => {
      handle = requestAnimationFrame(render);
      const elapsed = Math.min(64, now - previous);
      previous = now;

      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.clearRect(0, 0, width, height);

      const target = targetRef.current;
      const shown = shownRef.current;
      // Frame-rate independent, so a 144 Hz display behaves like a 60 Hz one.
      const smoothing = 1 - Math.pow(1 - SMOOTHING, elapsed / 16.67);

      const count = shown.length;
      const gap = Math.max(1, width * 0.0025);
      const barWidth = Math.max(1, (width - gap * (count - 1)) / count);
      const mid = height / 2;
      const maxBar = Math.max(1, mid - 1);

      const gradient = context.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, "#ff4d5a");
      gradient.addColorStop(0.55, "#e63946");
      gradient.addColorStop(1, "rgba(230, 57, 70, 0.45)");
      context.fillStyle = gradient;

      for (let i = 0; i < count; i += 1) {
        shown[i] += (target[i] - shown[i]) * smoothing;
        const magnitude = Math.min(1, Math.max(0, shown[i]));
        const barHeight = Math.max(0.5, magnitude * maxBar);
        const x = i * (barWidth + gap);

        // Dim the quiet bars instead of hiding them, so the row reads as a
        // continuous strip rather than a scattering of ticks.
        context.globalAlpha = 0.3 + magnitude * 0.7;
        context.beginPath();
        context.roundRect(
          x,
          mid - barHeight,
          barWidth,
          barHeight * 2,
          Math.min(barWidth / 2, 2 * dpr),
        );
        context.fill();
      }

      context.globalAlpha = 1;
    };

    handle = requestAnimationFrame(render);
    return () => cancelAnimationFrame(handle);
  }, [enabled]);

  if (!enabled) return null;

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
