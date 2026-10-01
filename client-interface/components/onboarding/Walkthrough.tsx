'use client';

import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ArrowLeft, ArrowRight, Check, Compass } from 'lucide-react';
import type { TourStep } from '@/lib/config/walkthroughs';

interface Rect { top: number; left: number; width: number; height: number }

const CARD_W = 400;

/**
 * Lightweight, dependency-free spotlight tour. Dims the screen, highlights the
 * current step's target element, and shows a positioned card with Back / Next /
 * Skip. Steps whose target isn't visible are skipped automatically, so it never
 * gets stuck. Centered cards (target: null) are used for the welcome/finish.
 */
export function Walkthrough({ steps, onClose }: { steps: TourStep[]; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  const step = steps[index];

  // Resolve the current target's on-screen rect (null if none/hidden).
  const measure = useCallback(() => {
    if (!step?.target) { setRect(null); return; }
    const el = document.querySelector(step.target) as HTMLElement | null;
    if (!el) { setRect(null); return; }
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) { setRect(null); return; }
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
  }, [step]);

  // On step change: scroll target into view, then measure.
  useLayoutEffect(() => {
    if (step?.target) {
      const el = document.querySelector(step.target) as HTMLElement | null;
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    const t = setTimeout(measure, 120);
    return () => clearTimeout(t);
  }, [index, step, measure]);

  // Keep the spotlight aligned on scroll/resize.
  useEffect(() => {
    const on = () => measure();
    window.addEventListener('resize', on);
    window.addEventListener('scroll', on, true);
    return () => { window.removeEventListener('resize', on); window.removeEventListener('scroll', on, true); };
  }, [measure]);

  const isLast = index >= steps.length - 1;
  const next = useCallback(() => (isLast ? onClose() : setIndex((i) => i + 1)), [isLast, onClose]);
  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') next();
      else if (e.key === 'ArrowLeft') back();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [next, back, onClose]);

  if (!mounted || !step) return null;

  // Card position: beside the target when there's room, else centered.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let cardStyle: React.CSSProperties;
  if (rect) {
    let left = rect.left + rect.width + 16;
    if (left + CARD_W > vw - 12) left = Math.max(12, rect.left - CARD_W - 16);
    const top = Math.min(Math.max(rect.top, 16), vh - 280);
    cardStyle = { position: 'fixed', top, left, width: CARD_W };
  } else {
    cardStyle = { position: 'fixed', top: '50%', left: '50%', width: CARD_W, transform: 'translate(-50%, -50%)' };
  }

  const PAD = 6;

  return createPortal(
    <div className="fixed inset-0 z-[100]">
      {/* Click-catcher (blocks the page; clicking does nothing) */}
      <div className="absolute inset-0" onClick={(e) => e.stopPropagation()} aria-hidden="true" />

      {/* Spotlight: dims everything except the target via a huge ring shadow */}
      {rect ? (
        <div
          className="absolute rounded-xl ring-2 ring-brand-400 transition-all duration-200 pointer-events-none"
          style={{
            top: rect.top - PAD, left: rect.left - PAD,
            width: rect.width + PAD * 2, height: rect.height + PAD * 2,
            boxShadow: '0 0 0 9999px rgba(2,6,23,0.62)',
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-[rgba(2,6,23,0.62)] pointer-events-none" />
      )}

      {/* Step card */}
      <div style={cardStyle} className="rounded-2xl glass shadow-xl dark:shadow-[0_8px_30px_rgba(0,0,0,0.6)] p-5 ">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex items-center gap-2">
            <span className="w-7 h-7 rounded-lg bg-brand-50 dark:bg-brand-500/15 flex items-center justify-center shrink-0">
              <Compass className="w-4 h-4 text-brand-600" />
            </span>
            <h3 className="text-sm font-semibold text-slate-900">{step.title}</h3>
          </div>
          <button onClick={onClose} aria-label="Skip tour" className="p-1 -m-1 text-slate-400 hover:text-slate-600 rounded-lg">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-sm text-slate-600 leading-relaxed">{step.body}</p>

        <div className="mt-4 flex items-center justify-between">
          {/* progress dots */}
          <div className="flex items-center gap-1.5">
            {steps.map((_, i) => (
              <span key={i} className={`h-1.5 rounded-full transition-all ${i === index ? 'w-4 bg-brand-600' : 'w-1.5 bg-slate-200'}`} />
            ))}
          </div>
          <div className="flex items-center gap-2">
            {index === 0 ? (
              <button onClick={onClose} className="text-xs font-medium text-slate-500 hover:text-slate-700 px-2 py-1.5">Skip</button>
            ) : (
              <button onClick={back} className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900 px-2 py-1.5 rounded-lg">
                <ArrowLeft className="w-3.5 h-3.5" />Back
              </button>
            )}
            <button onClick={next} className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium">
              {isLast ? <>Done<Check className="w-3.5 h-3.5" /></> : <>Next<ArrowRight className="w-3.5 h-3.5" /></>}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default Walkthrough;
