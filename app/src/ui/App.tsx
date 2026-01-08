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
          <Dashboard onAddTracker={() => setShowWizard(true)} />

          {showWizard && (
            <div
              className="modal-overlay modal-overlay-enter"
              style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.7)",
                backdropFilter: "blur(3px)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 2000,
                padding: "20px",
              }}
            >
              <div
                className="modal-card modal-card-enter"
                style={{ width: "100%", maxWidth: "760px", position: "relative" }}
                onClick={(e) => e.stopPropagation()}
              >
                <div
                  style={{
                    background: "#181818",
                    borderRadius: "18px",
                    padding: "1px",
                    border: "1px solid #2b2b2b",
                  }}
                >
                  <div
                    style={{
                      background: "#181818",
                      borderRadius: "17px",
                      padding: "28px",
                      maxHeight: "90vh",
                      overflowY: "auto",
                      overflowX: "hidden",
                      position: "relative",
                    }}
                  >
                    <OnboardingWizard onComplete={() => setShowWizard(false)} />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </AuthShell>
    </div>
  );
};


