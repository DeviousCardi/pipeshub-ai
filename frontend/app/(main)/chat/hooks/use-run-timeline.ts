'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore } from '../store';
import { ChatApi } from '../api';
import type { RunTimelineView } from '../types';

export interface DurableSessionRoute {
  agentId?: string;
  sessionId: string;
}

/** The active conversation's durable session routes, when it has a server id. */
export function useDurableSession(): DurableSessionRoute | null {
  const convId = useChatStore((s) => (s.activeSlotId ? (s.slots[s.activeSlotId]?.convId ?? null) : null));
  const agentId = useChatStore((s) => (s.activeSlotId ? (s.slots[s.activeSlotId]?.threadAgentId ?? null) : null));
  if (!convId) return null;
  return { ...(agentId ? { agentId } : {}), sessionId: convId };
}

/** True while the active conversation follows a durable run (the live stream is Node's projection). */
export function useFollowsDurableRun(): boolean {
  return useChatStore((s) => (s.activeSlotId ? Boolean(s.slots[s.activeSlotId]?.durableRun) : false));
}

export interface RunTimelineState {
  timeline: RunTimelineView | null;
  failed: boolean;
  reload: () => Promise<void>;
}

/**
 * One durable run's timeline (U3), read when `enabled`; `refreshKey` re-reads it (e.g. when the live card says the
 * task ended). Never on a timer: a running job's steps come from its own stream (CLASSIC-JOBS D13).
 */
export function useRunTimeline(
  session: DurableSessionRoute | null,
  runId: string | undefined,
  options: { enabled: boolean; refreshKey?: unknown },
): RunTimelineState {
  const [timeline, setTimeline] = useState<RunTimelineView | null>(null);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);
  const agentId = session?.agentId;
  const sessionId = session?.sessionId;

  const reload = useCallback(async () => {
    if (!sessionId || !runId) return;
    try {
      const read = await ChatApi.getRunTimeline({ ...(agentId ? { agentId } : {}), sessionId, runId });
      if (!alive.current) return;
      setTimeline(read);
      setFailed(false);
    } catch {
      if (alive.current) setFailed(true);
    }
  }, [agentId, sessionId, runId]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (options.enabled) void reload();
  }, [options.enabled, options.refreshKey, reload]);

  return { timeline, failed, reload };
}
