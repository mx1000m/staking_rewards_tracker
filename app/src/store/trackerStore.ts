import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Currency = "EUR" | "USD";

export interface Tracker {
  id: string;
  walletAddress: string;
  currency: Currency;
  country: string;
  taxRate: number;
  etherscanKey: string;
  name: string;
  createdAt: number;
}

interface TrackerStore {
  trackers: Tracker[];
  activeTrackerId: string | null;
  addTracker: (tracker: Omit<Tracker, "id" | "createdAt">) => void;
  updateTracker: (id: string, updates: Partial<Omit<Tracker, "id" | "createdAt">>) => void;
  setActiveTracker: (id: string) => void;
  removeTracker: (id: string) => void;
}

export const useTrackerStore = create<TrackerStore>()(
  persist(
    (set) => ({
      trackers: [],
      activeTrackerId: null,
      addTracker: (tracker) => {
        const newTracker: Tracker = {
          ...tracker,
          id: `tracker-${Date.now()}`,
          createdAt: Date.now(),
        };
        set((state) => ({
          trackers: [...state.trackers, newTracker],
          activeTrackerId: newTracker.id,
        }));
      },
      updateTracker: (id, updates) =>
        set((state) => ({
          trackers: state.trackers.map((t) =>
            t.id === id ? { ...t, ...updates } : t
          ),
        })),
      setActiveTracker: (id) => set({ activeTrackerId: id }),
      removeTracker: (id) =>
        set((state) => ({
          trackers: state.trackers.filter((t) => t.id !== id),
          activeTrackerId:
            state.activeTrackerId === id
              ? state.trackers.find((t) => t.id !== id)?.id || null
              : state.activeTrackerId,
        })),
    }),
    { name: "tracker-storage" }
  )
);

