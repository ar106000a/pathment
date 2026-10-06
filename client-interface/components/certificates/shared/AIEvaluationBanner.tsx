'use client';

import React from 'react';
import { Sparkles } from 'lucide-react';
import { QueueProgressBanner } from './QueueProgressBanner';

interface AIEvaluationBannerProps {
  count: number;
  failedCount?: number;
  skippedCount?: number;
  ranAt: string | null;
  runningAI?: boolean;
  progressCount?: number;
  totalCount?: number;
}

export function AIEvaluationBanner({
  count,
  failedCount = 0,
  skippedCount = 0,
  ranAt,
  runningAI = false,
  progressCount = 0,
  totalCount = 0,
}: AIEvaluationBannerProps) {
  return (
    <>
    {failedCount > 0 && <p role="status" className="mb-2 text-xs text-amber-700 dark:text-amber-400">{failedCount} evaluation(s) failed. Retry to evaluate these mentees; their previous decisions are unchanged.</p>}
    {skippedCount > 0 && <p role="status" className="mb-2 text-xs text-muted-foreground">Skipped {skippedCount} finalized mentee{skippedCount === 1 ? '' : 's'}—reviewed, approved, and issued decisions were preserved.</p>}
    <QueueProgressBanner
      title="Evaluating mentees with AI..."
      completed={progressCount}
      total={totalCount}
      active={runningAI}
      icon={Sparkles}
      lastRunAt={ranAt}
      count={count}
      completedLabel={`AI Evaluated ${count} mentee${count !== 1 ? 's' : ''}`}
    />
    </>
  );
}
