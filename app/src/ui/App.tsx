import React, { useState, useEffect } from "react";
import { OnboardingWizard } from "./OnboardingWizard";
import { AuthShell } from "./AuthShell";
import { Dashboard } from "./Dashboard";
import { useTrackerStore } from "../store/trackerStore";
import { useAuth } from "../hooks/useAuth";

export const App: React.FC = () => {
  const { trackers, syncTrackersFromFirestore } = useTrackerStore();
  const { user, isAuthenticated } = useAuth();
  const [showWizard, setShowWizard] = useState(trackers.length === 0);
  
  // Sync trackers from Firestore when user authenticates
  useEffect(() => {
    if (isAuthenticated && user) {
      syncTrackersFromFirestore(user.uid).then(() => {
        // Update wizard state after sync
        const { trackers: syncedTrackers } = useTrackerStore.getState();
        setShowWizard(syncedTrackers.length === 0);
      });
    }
  }, [isAuthenticated, user, syncTrackersFromFirestore]);

  return (
    <div className="app-root">
      <AuthShell>
        {showWizard ? (
          <OnboardingWizard
            onComplete={() => setShowWizard(false)}
          />
        ) : (
          <div style={{ width: "100%" }}>
            <Dashboard onAddTracker={() => setShowWizard(true)} />
          </div>
        )}
      </AuthShell>
    </div>
  );
};


