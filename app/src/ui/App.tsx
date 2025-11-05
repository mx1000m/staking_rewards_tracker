import React from "react";
import { OnboardingWizard } from "./OnboardingWizard";
import { AuthShell } from "./AuthShell";

export const App: React.FC = () => {
  return (
    <div className="app-root">
      <header className="app-header">Staking Rewards Tracker</header>
      <main className="app-main">
        <AuthShell>
          <OnboardingWizard />
        </AuthShell>
      </main>
    </div>
  );
};


