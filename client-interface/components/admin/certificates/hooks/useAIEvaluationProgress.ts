'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { certificatesApi } from '@/lib/services/certificates-api';
import { getSocket } from '@/lib/services/socket-client';

/** Polls and completion events contain only this run's recipients. */
function mergeResults<T extends { mentee_id?: string; _failed?: boolean }>(previous: T[], incoming: T[]): T[] {
  const results = new Map(previous.map(result => [result.mentee_id, result]));
  for (const result of incoming) {
    if (result.mentee_id && !result._failed) results.set(result.mentee_id, result);
  }
  return [...results.values()];
}

export interface UseAIEvaluationProgressOptions {
  templateId?: string | null;
  onSingleProgress?: (result: any) => void;
  onBatchComplete?: (results: any[]) => void;
}

export function useAIEvaluationProgress(options: UseAIEvaluationProgressOptions = {}) {
  const { templateId, onSingleProgress, onBatchComplete } = options;
  const callbacks = useRef({ onSingleProgress, onBatchComplete });
  useEffect(() => { callbacks.current = { onSingleProgress, onBatchComplete }; }, [onSingleProgress, onBatchComplete]);

  const [aiResults, setAiResults] = useState<any[]>([]);
  const [aiRanAt, setAiRanAt] = useState<string | null>(null);
  const [runningAI, setRunningAI] = useState(false);
  const [failedCount, setFailedCount] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);
  const [aiProgressCount, setAiProgressCount] = useState(0);
  const [aiTotalCount, setAiTotalCount] = useState(0);
  const [aiEvaluationRunId, setAiEvaluationRunId] = useState<string | null>(null);

  useEffect(() => {
    if (!aiEvaluationRunId || !templateId) return;

    let cancelled = false;
    const socket = getSocket();
    let pollInterval: NodeJS.Timeout | null = null;

    const handleProgress = (data: { runId: string; menteeId: string; result: any; completed: number; total: number }) => {
      if (data.runId !== aiEvaluationRunId) return;
      setAiProgressCount(data.completed);
      setAiTotalCount(data.total);

      if (data.result._failed || data.result._skipped) return;
      setAiResults(prev => {
        const index = prev.findIndex(r => r.mentee_id === data.result.mentee_id);
        if (index > -1) {
          const updated = [...prev];
          updated[index] = data.result;
          return updated;
        } else {
          return [...prev, data.result];
        }
      });

      callbacks.current.onSingleProgress?.(data.result);
    };

    const handleComplete = (data: { runId: string; results: any[]; ranAt: string; failed?: number; skipped?: number }) => {
      if (data.runId !== aiEvaluationRunId) return;
      setAiResults(prev => mergeResults(prev, data.results || []));
      setAiRanAt(data.ranAt);
      setFailedCount(data.failed ?? 0);
      setSkippedCount(data.skipped ?? 0);
      setRunningAI(false);
      setAiEvaluationRunId(null);

      callbacks.current.onBatchComplete?.((data.results || []).filter(r => !r._failed));

      if (data.failed) toast.warning(`${data.failed} evaluation(s) failed. Their previous decisions are unchanged; retry to evaluate them.`);
      else toast.success(`AI evaluation completed for ${(data.results || []).length} mentees.`);
    };

    if (socket) {
      socket.on('ai-eval:progress', handleProgress);
      socket.on('ai-eval:complete', handleComplete);
    }

    pollInterval = setInterval(async () => {
      try {
        const res: any = await certificatesApi.getAIEvaluationStatus(templateId, aiEvaluationRunId);
        if (!cancelled && res.success) {
          const payload = res.data?.data ? res.data : res;
          const completed = payload.completed ?? res.completed ?? 0;
          const total = payload.total ?? res.total ?? 0;
          const isDone = payload.isDone ?? res.isDone ?? false;
          const resultsList = payload.data ?? res.data ?? [];

          setFailedCount(payload.failed ?? res.failed ?? 0);
          setSkippedCount(payload.skipped ?? res.skipped ?? 0);
          setAiProgressCount(completed);
          setAiTotalCount(total);

          if (Array.isArray(resultsList) && resultsList.length > 0) {
            setAiResults(prev => mergeResults(prev, resultsList));
            callbacks.current.onBatchComplete?.(resultsList.filter(r => !r._failed));
          }

          if (isDone) {
            setAiRanAt(payload.ranAt || res.ranAt || new Date().toISOString());
            setRunningAI(false);
            setAiEvaluationRunId(null);
            if (pollInterval) clearInterval(pollInterval);
            if (payload.failed ?? res.failed) toast.warning('Some evaluations failed. Retry them; this does not mean No certificate.');
            else toast.success('AI evaluation completed.');
          }
        }
      } catch (err) {
        console.error('AI status poll error:', err);
      }
    }, 4000);

    return () => {
      cancelled = true;
      if (socket) {
        socket.off('ai-eval:progress', handleProgress);
        socket.off('ai-eval:complete', handleComplete);
      }
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [aiEvaluationRunId, templateId]);

  const runAIEvaluation = useCallback(async (targetTemplateId?: string, menteeIds?: string[]) => {
    const idToUse = targetTemplateId || templateId;
    if (!idToUse) return;

    try {
      setRunningAI(true);
      setFailedCount(0);
      setSkippedCount(0);
      setAiProgressCount(0);
      setAiTotalCount(0);

      const res: any = await certificatesApi.runAIEvaluation(idToUse, undefined, menteeIds);
      const runId = res.runId || res.data?.runId;
      const total = res.total ?? res.data?.total ?? 0;
      const skipped = res.skipped ?? res.data?.skipped ?? { total: 0 };

      if (res.success && runId) {
        setAiEvaluationRunId(runId);
        setAiTotalCount(total);
        toast.info(`AI evaluation started for ${total} mentees...`);
      } else if (res.success) {
        setRunningAI(false);
        setSkippedCount(skipped.total ?? 0);
        toast.info(res.message || 'There are no unreviewed mentees to evaluate.');
      }
    } catch (err: any) {
      toast.error(err.message || 'AI evaluation failed. Check AI connection in Settings.');
      setRunningAI(false);
    }
  }, [templateId]);

  useEffect(() => {
    if (!templateId) return;

    let isMounted = true;
    async function checkInitialStatus() {
      try {
        const statusRes: any = await certificatesApi.getAIEvaluationStatus(templateId!);
        if (statusRes.success && isMounted) {
          const payload = statusRes.data?.data ? statusRes.data : statusRes;
          setFailedCount(payload.failed ?? statusRes.failed ?? 0);
          setSkippedCount(payload.skipped ?? statusRes.skipped ?? 0);
          const activeRunId = payload.runId || statusRes.runId;
          const isDone = payload.isDone ?? statusRes.isDone ?? true;
          const completed = payload.completed ?? statusRes.completed ?? 0;
          const total = payload.total ?? statusRes.total ?? 0;

          if (!isDone && activeRunId) {
            setAiEvaluationRunId(activeRunId);
            setRunningAI(true);
            setAiProgressCount(completed);
            setAiTotalCount(total);
          }
        }
      } catch (e) {
      }
    }

    checkInitialStatus();
    return () => { isMounted = false; };
  }, [templateId]);

  const aiEvalMap = useMemo(() => {
    const map: Record<string, any> = {};
    (aiResults || []).forEach(r => {
      if (r.mentee_id) map[r.mentee_id] = r;
    });
    return map;
  }, [aiResults]);

  return {
    aiResults,
    setAiResults,
    aiRanAt,
    setAiRanAt,
    runningAI,
    failedCount,
    skippedCount,
    setRunningAI,
    aiProgressCount,
    setAiProgressCount,
    aiTotalCount,
    setAiTotalCount,
    aiEvaluationRunId,
    setAiEvaluationRunId,
    aiEvalMap,
    runAIEvaluation,
  };
}
