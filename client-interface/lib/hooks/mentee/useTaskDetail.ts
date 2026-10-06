/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { taskApi } from '@/lib/services/task-api';
import { qk, useApiQuery } from '@/lib/query';
import { useClan } from '@/lib/context/ClanContext';

export interface UseTaskDetailReturn {
  task: any;
  loading: boolean;
  error: string;
  /** HTTP status when the load failed — lets the page tell 403 from 404. */
  errorStatus: number | null;
  refetch: () => Promise<void>;
}

export function useTaskDetail(taskId: string): UseTaskDetailReturn {
  const { menteeActiveClanId } = useClan();

  const { data, loading, error, errorStatus, refetch } = useApiQuery<any>({
    queryKey: qk.me.task(taskId, menteeActiveClanId),
    queryFn: async () => (await taskApi.getTaskById(taskId)).data.task,
    enabled: !!taskId,
    errorMessage: 'Failed to load task',
  });

  // Hide Standee work when the completed cohort (or another clan) is selected.
  const clanMismatch = Boolean(
    data?.clanId && menteeActiveClanId && data.clanId !== menteeActiveClanId,
  );

  return {
    task: clanMismatch ? null : (data ?? null),
    loading,
    error: clanMismatch ? 'This task belongs to another clan' : (error ?? ''),
    errorStatus: clanMismatch ? 404 : errorStatus,
    refetch,
  };
}
