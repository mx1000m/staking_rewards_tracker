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
        <div style={{ width: "100%", position: "relative" }}>
          <Dashboard onAddTracker={() => setShowWizard(true)} />

          {showWizard && (
            <div
              className="modal-overlay modal-overlay-enter"
              style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.6)",
                backdropFilter: "blur(3px)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 2000,
                padding: "16px",
              }}
              onClick={() => setShowWizard(false)}
            >
              <div
                style={{ maxWidth: "760px", width: "100%" }}
                onClick={(e) => e.stopPropagation()}
              >
                <OnboardingWizard onComplete={() => setShowWizard(false)} />
              </div>
            </div>
          )}
        </div>
      </AuthShell>
    </div>
  );
};


