'use client';

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { Load } from '../ai-accounts/components/load-state';
import { isHarnessError, toHarnessError } from '../harness-ui/refusal';
import { UnknownEffectsApi, type ParkedEffect, type Resolution } from './api';

/** What the console's routes answered: 404 (`HARNESS_RECONCILE` off) or a member's refusal is `off`. */
export type ConsoleAvailability = 'unknown' | 'on' | 'off';

interface UnknownEffectsState {
  availability: ConsoleAvailability;
  items: Load<ParkedEffect[]>;
  /** The listed effects' agents by key, from the list's own answer (ADR-UI-03). */
  agentNames: Record<string, string>;
  load: (quiet?: boolean) => Promise<void>;
  /** Rejects with a `HarnessError`; the list is re-read either way. */
  resolve: (effect: ParkedEffect, resolution: Resolution, idempotencyKey: string) => Promise<void>;
  reset: () => void;
}

const initial = {
  availability: 'unknown' as ConsoleAvailability,
  items: { status: 'loading' } as Load<ParkedEffect[]>,
  agentNames: {} as Record<string, string>,
};

const availabilityAfter = (error: unknown): ConsoleAvailability => {
  const failure = isHarnessError(error) ? error : toHarnessError(error);
  if (failure.kind === 'not_found') return 'off';
  if (failure.kind === 'forbidden') return 'off';
  return 'unknown';
};

export const useUnknownEffectsStore = create<UnknownEffectsState>()(
  devtools(
    (set, get) => ({
      ...initial,

      load: async (quiet = false) => {
        if (!quiet) set({ items: { status: 'loading' } });
        try {
          const { effects, agentNames } = await UnknownEffectsApi.list();
          set({ items: { status: 'ready', data: effects }, agentNames, availability: 'on' });
        } catch (error) {
          const failure = isHarnessError(error) ? error : toHarnessError(error);
          set({ items: { status: 'error', error: failure }, availability: availabilityAfter(failure) });
        }
      },

      resolve: async (effect, resolution, idempotencyKey) => {
        try {
          await UnknownEffectsApi.resolve(effect, resolution, idempotencyKey);
        } finally {
          await get().load(true);
        }
      },

      reset: () => set(initial),
    }),
    { name: 'unknown-effects' },
  ),
);
