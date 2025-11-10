import React, { useState } from "react";
import { OnboardingWizard } from "./OnboardingWizard";
import { AuthShell } from "./AuthShell";
import { Dashboard } from "./Dashboard";
import { useTrackerStore } from "../store/trackerStore";

export const App: React.FC = () => {
  const { trackers } = useTrackerStore();
  const [showWizard, setShowWizard] = useState(trackers.length === 0);

  return (
    <div className="app-root">
      <header className="app-header">Staking Rewards Tracker</header>
      <main className="app-main" style={!showWizard ? { placeItems: "stretch" } : {}}>
        <AuthShell>
          {showWizard ? (
            <OnboardingWizard
              onComplete={() => setShowWizard(false)}
            />
          ) : (
            <div style={{ width: "100%", maxWidth: "1400px" }}>
              <div style={{ marginBottom: "16px", display: "flex", justifyContent: "flex-end" }}>
                <button onClick={() => setShowWizard(true)}>+ Add Node Tracker</button>
              </div>
              <Dashboard />
            </div>
          )}
        </AuthShell>
      </main>
    </div>
  );
};


