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

export const useTrackerStore = create<TrackerStore>()(
  persist(
    (set) => ({
      trackers: [],
      activeTrackerId: null,
      currency: "EUR" as Currency, // Default to EUR
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
          const firestoreTrackerIds = new Set(firestoreTrackers.map(t => t.id));
          
          set((state) => {
            // Find local trackers that don't exist in Firestore (deleted on another device)
            const deletedTrackerIds: string[] = [];
            state.trackers.forEach((localTracker) => {
              if (!firestoreTrackerIds.has(localTracker.id)) {
                deletedTrackerIds.push(localTracker.id);
              }
            });
            
            // If there are deleted trackers, clear their cache
            if (deletedTrackerIds.length > 0) {
              console.log(`Detected ${deletedTrackerIds.length} tracker(s) deleted on another device, clearing cache...`);
              // Import clearCache dynamically to avoid circular dependencies
              import("../utils/transactionCache").then(({ clearCache }) => {
                deletedTrackerIds.forEach((trackerId) => {
                  clearCache(trackerId).catch((err) => {
                    console.error(`Failed to clear cache for deleted tracker ${trackerId}:`, err);
                  });
                });
              });
            }
            
            // Merge Firestore trackers with local ones (Firestore takes precedence)
            // Remove local trackers that don't exist in Firestore
            const localMap = new Map(state.trackers.map((t) => [t.id, t]));
            firestoreTrackers.forEach((ft) => {
              localMap.set(ft.id, ft);
            });
            
            // Only keep trackers that exist in Firestore
            const syncedTrackers = Array.from(localMap.values()).filter(t => 
              firestoreTrackerIds.has(t.id)
            );
            
            // Update activeTrackerId if the current one was deleted
            let newActiveTrackerId = state.activeTrackerId;
            if (state.activeTrackerId && !firestoreTrackerIds.has(state.activeTrackerId)) {
              newActiveTrackerId = syncedTrackers.length > 0 ? syncedTrackers[0].id : null;
            } else if (!newActiveTrackerId && syncedTrackers.length > 0) {
              newActiveTrackerId = syncedTrackers[0].id;
            }
            
            return {
              trackers: syncedTrackers,
              activeTrackerId: newActiveTrackerId,
            };
          });
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
    { name: "tracker-storage" }
  )
);

