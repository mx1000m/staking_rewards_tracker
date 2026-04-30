import React, { useEffect } from "react";
import { AuthShell } from "./AuthShell";
import { Dashboard } from "./Dashboard";
import { useTrackerStore } from "../store/trackerStore";
import { useAuth } from "../hooks/useAuth";

export const App: React.FC = () => {
  const { syncTrackersFromFirestore } = useTrackerStore();
  const { user, isAuthenticated } = useAuth();

  // Sync trackers from Firestore when user authenticates
  useEffect(() => {
    if (isAuthenticated && user) {
      syncTrackersFromFirestore(user.uid);
      
      // Set up periodic sync to detect deletions on other devices
      // Sync every 30 seconds when user is authenticated
      const syncInterval = setInterval(() => {
        syncTrackersFromFirestore(user.uid).catch((error) => {
          console.error("Periodic sync failed:", error);
        });
      }, 30000); // 30 seconds
      
      return () => clearInterval(syncInterval);
    }
  }, [isAuthenticated, user, syncTrackersFromFirestore]);

  return (
    <div className="app-root">
      <AuthShell>
        <div style={{ width: "100%", position: "relative" }}>
          <Dashboard />
        </div>
      </AuthShell>
    </div>
  );
};


