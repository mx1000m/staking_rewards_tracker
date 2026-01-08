import { create } from "zustand";
import { persist } from "zustand/middleware";
import { saveFirestoreTracker, getFirestoreTrackers } from "../utils/firestoreAdapter";

export type Currency = "EUR" | "USD";

export interface Tracker {
  id: string;
  walletAddress: string; // Withdrawal address (Consensus Layer) - required
  feeRecipientAddress?: string; // Fee recipient (Execution Layer) - optional, defaults to walletAddress
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
  currency: Currency; // Global currency preference for all nodes
  setCurrency: (currency: Currency) => void;
  addTracker: (tracker: Omit<Tracker, "id" | "createdAt">) => void;
  updateTracker: (id: string, updates: Partial<Omit<Tracker, "id" | "createdAt">>) => void;
  setActiveTracker: (id: string) => void;
  removeTracker: (id: string) => void;
  syncTrackersFromFirestore: (uid: string) => Promise<void>;
  syncTrackerToFirestore: (uid: string, tracker: Tracker) => Promise<void>;
}

interface TrackerStoreWithHydration extends TrackerStore {
  _hasHydrated: boolean;
  setHasHydrated: (hasHydrated: boolean) => void;
}

export const useTrackerStore = create<TrackerStoreWithHydration>()(
  persist(
    (set) => ({
      trackers: [],
      activeTrackerId: null,
      currency: "EUR" as Currency, // Default to EUR
      _hasHydrated: false,
      setHasHydrated: (hasHydrated: boolean) => {
        set({ _hasHydrated: hasHydrated });
      },
      setCurrency: (currency) => set({ currency }),
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
      syncTrackersFromFirestore: async (uid) => {
        try {
          const firestoreTrackers = await getFirestoreTrackers(uid);
          if (firestoreTrackers.length > 0) {
            set((state) => {
              // Merge Firestore trackers with local ones (Firestore takes precedence)
              const localMap = new Map(state.trackers.map((t) => [t.id, t]));
              firestoreTrackers.forEach((ft) => {
                localMap.set(ft.id, ft);
              });
              return {
                trackers: Array.from(localMap.values()),
                activeTrackerId: state.activeTrackerId || firestoreTrackers[0]?.id || null,
              };
            });
          }
        } catch (error) {
          console.error("Failed to sync trackers from Firestore:", error);
        }
      },
      syncTrackerToFirestore: async (uid, tracker) => {
        try {
          await saveFirestoreTracker(uid, tracker);
        } catch (error) {
          console.error("Failed to sync tracker to Firestore:", error);
        }
      },
      setActiveTracker: (id) => set({ activeTrackerId: id }),
      removeTracker: (id) =>
        set((state) => {
          const newTrackers = state.trackers.filter((t) => t.id !== id);
          // If we deleted the active tracker, set to first remaining tracker, or null if none remain
          let newActiveTrackerId = state.activeTrackerId;
          if (state.activeTrackerId === id) {
            newActiveTrackerId = newTrackers.length > 0 ? newTrackers[0].id : null;
          }
          // If all trackers are deleted, ensure activeTrackerId is null
          if (newTrackers.length === 0) {
            newActiveTrackerId = null;
          }
          return {
            trackers: newTrackers,
            activeTrackerId: newActiveTrackerId,
          };
        }),
    }),
    {
      name: "tracker-storage",
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.setHasHydrated(true);
        }
      },
    }
  )
);

