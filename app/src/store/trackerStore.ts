import { create } from "zustand";
import { persist } from "zustand/middleware";
import { saveFirestoreTracker, getFirestoreTrackers } from "../utils/firestoreAdapter";

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
  syncTrackersFromFirestore: (uid: string) => Promise<void>;
  syncTrackerToFirestore: (uid: string, tracker: Tracker) => Promise<void>;
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

