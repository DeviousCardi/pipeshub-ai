'use client';

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { Load } from '../ai-accounts/components/load-state';
import { isHarnessError, toHarnessError } from '../harness-ui/refusal';
import { MemoriesApi, type AgentMemories, type Memory, type MemoryFilter, type MemoryPolicy } from './api';

const failed = (error: unknown) =>
  ({ status: 'error', error: isHarnessError(error) ? error : toHarnessError(error) }) as const;

interface MemoriesState {
  filter: MemoryFilter;
  own: Load<Memory[]>;
  policy: Load<MemoryPolicy>;
  agent: Load<AgentMemories>;
  loadOwn: (filter?: MemoryFilter, quiet?: boolean) => Promise<void>;
  loadPolicy: () => Promise<void>;
  loadAgent: (quiet?: boolean) => Promise<void>;
  /** Rejects with a `HarnessError`; the list it touched is re-read. */
  editOwn: (memoryId: string, content: string) => Promise<void>;
  reviewOwn: (memoryId: string, decision: 'accepted' | 'rejected') => Promise<void>;
  removeOwn: (memoryId: string) => Promise<void>;
  savePolicy: (policy: MemoryPolicy) => Promise<void>;
  reviewAgent: (memoryId: string, decision: 'accepted' | 'rejected') => Promise<void>;
  removeAgent: (memoryId: string) => Promise<void>;
  reset: () => void;
}

const initial = {
  filter: 'all' as MemoryFilter,
  own: { status: 'loading' } as Load<Memory[]>,
  policy: { status: 'loading' } as Load<MemoryPolicy>,
  agent: { status: 'loading' } as Load<AgentMemories>,
};

export const useMemoriesStore = create<MemoriesState>()(
  devtools(
    (set, get) => ({
      ...initial,

      loadOwn: async (filter = get().filter, quiet = false) => {
        set({ filter, ...(quiet ? {} : { own: { status: 'loading' } }) });
        try {
          set({ own: { status: 'ready', data: await MemoriesApi.listOwn(filter) } });
        } catch (error) {
          set({ own: failed(error) });
        }
      },

      loadPolicy: async () => {
        set({ policy: { status: 'loading' } });
        try {
          set({ policy: { status: 'ready', data: await MemoriesApi.policy() } });
        } catch (error) {
          set({ policy: failed(error) });
        }
      },

      loadAgent: async (quiet = false) => {
        if (!quiet) set({ agent: { status: 'loading' } });
        try {
          set({ agent: { status: 'ready', data: await MemoriesApi.listAgent() } });
        } catch (error) {
          set({ agent: failed(error) });
        }
      },

      editOwn: async (memoryId, content) => {
        await MemoriesApi.edit(memoryId, content);
        await get().loadOwn(undefined, true);
      },

      reviewOwn: async (memoryId, decision) => {
        await MemoriesApi.review(memoryId, decision);
        await get().loadOwn(undefined, true);
      },

      removeOwn: async (memoryId) => {
        await MemoriesApi.remove(memoryId);
        await get().loadOwn(undefined, true);
      },

      savePolicy: async (policy) => {
        set({ policy: { status: 'ready', data: await MemoriesApi.setPolicy(policy) } });
      },

      reviewAgent: async (memoryId, decision) => {
        await MemoriesApi.reviewAgent(memoryId, decision);
        await get().loadAgent(true);
      },

      removeAgent: async (memoryId) => {
        await MemoriesApi.removeAgent(memoryId);
        await get().loadAgent(true);
      },

      reset: () => set(initial),
    }),
    { name: 'agent-memories' },
  ),
);
