import React, { useMemo, useState, useEffect } from "react";
import { useTrackerStore, Currency } from "../store/trackerStore";
import { useAuth } from "../hooks/useAuth";

type OnboardingWizardProps = {
  onComplete?: () => void;
};

export const OnboardingWizard: React.FC<OnboardingWizardProps> = ({ onComplete }) => {
  const { addTracker, syncTrackerToFirestore, trackers, currency: globalCurrency, setCurrency } = useTrackerStore();
  const { user } = useAuth();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [feeRecipientAddress, setFeeRecipientAddress] = useState("");
  const [validatorPublicKey, setValidatorPublicKey] = useState("");
  const [mevMode, setMevMode] = useState<"none" | "direct" | "pool" | "mixed">("none");
  const [currency, setCurrencyLocal] = useState<Currency>(globalCurrency);
  
  // Update local currency when global currency changes
  useEffect(() => {
    setCurrencyLocal(globalCurrency);
  }, [globalCurrency]);
  
  // Wrapper to update both local and global currency
  const handleCurrencyChange = (newCurrency: Currency) => {
    setCurrencyLocal(newCurrency);
    setCurrency(newCurrency); // Update global currency
  };
  const [taxRate, setTaxRate] = useState<number>(24);
  const [shakeNameInput, setShakeNameInput] = useState(false);
  const [shakeBeaconValidator, setShakeBeaconValidator] = useState(false);

  // Get next available validator name
  const getNextAvailableName = useMemo(() => {
    let num = 1;
    // Support both old "Validator Tracker X" and new "Validator X" naming
    while (
      trackers.some(
        (t) => t.name === `Validator ${num}` || t.name === `Validator Tracker ${num}`
      )
    ) {
      num++;
    }
    return `Validator ${num}`;
  }, [trackers]);

  // Check for duplicate name
  const duplicateName = useMemo(() => {
    const trimmedName = name.trim();
    if (!trimmedName) return null;
    return trackers.find((t) => t.name === trimmedName) || null;
  }, [name, trackers]);

  // Prevent background scrolling while the wizard is open
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const canNext = useMemo(() => {
    if (step === 0) {
      // Prevent proceeding if name is duplicate
      const trimmedName = name.trim();
      if (trimmedName && duplicateName) {
        return false;
      }
      return true; // Allow empty name, will use default
    }
    if (step === 1) {
      // Beacon chain validator public key (98 chars including 0x)
      const key = validatorPublicKey.trim();
      const validatorKeyValid = /^0x[a-fA-F0-9]{96}$/.test(key);
      return validatorKeyValid;
    }
    if (step === 2) return true;
    if (step === 3) return taxRate >= 0 && taxRate <= 100;
    if (step === 4) return currency === "EUR" || currency === "USD";
    return true;
  }, [
    step,
    name,
    feeRecipientAddress,
    currency,
    taxRate,
    validatorPublicKey,
    mevMode,
    duplicateName,
  ]);

  const next = async () => {
    if (!canNext) {
      // Trigger shake animation if trying to proceed with duplicate name
      if (step === 0 && duplicateName) {
        setShakeNameInput(true);
        setTimeout(() => setShakeNameInput(false), 500);
      }
      return;
    }
    if (step === 1) {
      const key = validatorPublicKey.trim();
      const validatorKeyValid = /^0x[a-fA-F0-9]{96}$/.test(key);

      if (!validatorKeyValid) {
        setShakeBeaconValidator(true);
        setTimeout(() => setShakeBeaconValidator(false), 500);
        return;
      }
    }
    if (step === 4) {
      // Save tracker and complete
      // Use generated validator name if name is empty
      const defaultName = name.trim() || getNextAvailableName;
      
      // Update global currency preference (already updated via handleCurrencyChange)
      
      // Add tracker (currency is now global, but we keep it in tracker for backward compatibility)
      addTracker({
        walletAddress: "", // filled by beacon-sync from validator index / Dune
        feeRecipientAddress: feeRecipientAddress.trim() || undefined,
        currency, // Keep for backward compatibility, but global currency is used for display
        taxRate,
        name: defaultName,
        validatorPublicKey: validatorPublicKey.trim() || undefined,
        mevMode,
        capitalGainsTaxRate: 12,
        capitalGainsTaxFreeAfterYears: 2,
      });
      
      // Sync to Firestore if authenticated
      if (user) {
        const { trackers } = useTrackerStore.getState();
        const newTracker = trackers[trackers.length - 1];
        if (newTracker) {
          await syncTrackerToFirestore(user.uid, newTracker);
        }
      }
      
      // Use setTimeout to ensure state updates complete before closing wizard
      // This prevents React hook order issues during the transition
      setTimeout(() => {
        onComplete?.();
      }, 0);
    } else {
      setStep((s) => s + 1);
    }
  };
  const back = () => setStep((s) => Math.max(0, s - 1));
  
  const handleCancel = () => {
    onComplete?.();
  };

  return (
    <section style={{ position: "relative", width: "100%", boxSizing: "border-box" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
        <h1 style={{ margin: 0, fontSize: "1.5rem", fontWeight: 600 }}>
          {step === 0 && "Start by naming your validator"}
          {step === 1 && "Add your validator public key"}
          {step === 2 && "Set up your execution rewards"}
          {step === 3 && "Set your income tax rate"}
          {step === 4 && "Choose your currency preference"}
        </h1>
        <button
          onClick={handleCancel}
          style={{
            background: "transparent",
            border: "none",
            color: "#9aa0b4",
            fontSize: "24px",
            cursor: "pointer",
            padding: "0",
            width: "32px",
            height: "32px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "color 0.2s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "#e8e8f0";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "#9aa0b4";
          }}
        >
          ×
        </button>
      </div>
      <div className="steps" style={{ marginBottom: "32px" }}>Step {step + 1} of 5</div>
      {step === 0 && (
        <div>
          <label style={{ display: "block", marginBottom: "8px", color: "#f0f0f0", fontSize: "0.9rem" }}>
            Validator name
          </label>
          <p className="muted" style={{ margin: "0 0 9px 0", fontSize: "0.8rem", color: "#aaaaaa" }}>
            Give your validator a name to find it more easily later on.
          </p>
          <input
            className="input"
            placeholder={getNextAvailableName}
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{
              borderColor: duplicateName ? "#ef4444" : undefined,
              borderWidth: duplicateName ? "2px" : undefined,
              animation: shakeNameInput ? "shake 0.5s" : undefined,
            }}
          />
            {duplicateName && (
              <p style={{ margin: "8px 0 0 0", fontSize: "0.8rem", color: "#ef4444" }}>
                ⚠ You already have a validator tracker called <strong>{duplicateName.name}</strong>. Please choose a different name.
              </p>
            )}
        </div>
      )}
      {step === 1 && (
        <div>
          <label style={{ display: "block", marginBottom: "0px", color: "#f0f0f0", fontSize: "0.9rem" }}>
            Beacon chain validator public key
          </label>
          <p className="muted" style={{ margin: "4px 0 9px 0", fontSize: "0.8rem", color: "#aaaaaa" }}>
            Used to identify your validator on the beacon chain (consensus layer).
          </p>
          <input
            className="input"
            placeholder="0x... (98 characters long)"
            value={validatorPublicKey}
            onChange={(e) => setValidatorPublicKey(e.target.value.trim())}
            style={{
              borderColor: shakeBeaconValidator ? "#ef4444" : undefined,
              borderWidth: shakeBeaconValidator ? "2px" : undefined,
              animation: shakeBeaconValidator ? "shake 0.5s" : undefined,
            }}
          />
        </div>
      )}
      {step === 2 && (
        <div>
          <label style={{ display: "block", marginBottom: "0px", color: "#f0f0f0", fontSize: "0.9rem" }}>
            How do you receive execution rewards?
          </label>
          <p className="muted" style={{ margin: "4px 0 9px 0", fontSize: "0.8rem", color: "#aaaaaa" }}>
            This helps us track MEV and priority fees accurately.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "11px" }}>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                cursor: "pointer",
                color: mevMode === "none" ? "#ffffff" : "#747474",
                fontSize: "0.9rem",
                fontWeight: mevMode === "none" ? 600 : 400,
              }}
            >
              <input
                type="radio"
                name="executionRewardsMode"
                value="none"
                checked={mevMode === "none"}
                onChange={() => setMevMode("none")}
                style={{ accentColor: "#f0f0f0" }}
              />
              <span>No execution rewards</span>
            </label>

            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                cursor: "pointer",
                color: mevMode === "direct" ? "#ffffff" : "#747474",
                fontSize: "0.9rem",
                fontWeight: mevMode === "direct" ? 600 : 400,
              }}
            >
              <input
                type="radio"
                name="executionRewardsMode"
                value="direct"
                checked={mevMode === "direct"}
                onChange={() => setMevMode("direct")}
                style={{ accentColor: "#f0f0f0" }}
              />
              <span>Priority fees and/or MEV rewards</span>
            </label>

            {/* Execution rewards come from Dune + beacon-sync (Firestore). */}

            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                cursor: "not-allowed",
                color: "#555555",
                fontSize: "0.9rem",
                opacity: 0.6,
              }}
            >
              <input
                type="radio"
                name="executionRewardsMode"
                value="pool"
                disabled
                checked={mevMode === "pool"}
                onChange={() => {}}
                style={{ accentColor: "#555555" }}
              />
              <span>MEV with smoothing pool (coming soon)</span>
            </label>
          </div>

          {/* MEV pool / smoothing configuration is disabled for now. */}
        </div>
      )}
      {step === 3 && (
        <div>
          <label style={{ display: "block", marginBottom: "6px", color: "#f0f0f0", fontSize: "0.9rem" }}>
            Income tax rate
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", maxWidth: "220px" }}>
            <input
              className="input"
              type="number"
              min={0}
              max={100}
              step={0.1}
              value={taxRate}
              onChange={(e) => setTaxRate(parseFloat(e.target.value))}
              style={{ width: "160px" }}
            />
            <span style={{ color: "#9aa0b4" }}>%</span>
          </div>
          <p className="muted" style={{ margin: "8px 0 3px 0", fontSize: "0.8rem", color: "#aaaaaa" }}>
            Income tax rate is indicative. Please verify with your local tax authority.
          </p>
        </div>
      )}
      {step === 4 && (
        <div>
          <label style={{ display: "block", marginBottom: "0px", color: "#f0f0f0", fontSize: "0.9rem" }}>
            Currency preference
          </label>
          <p className="muted" style={{ margin: "4px 0 9px 0", fontSize: "0.8rem", color: "#aaaaaa" }}>
            Applies to all validators.
          </p>
          <div style={{ display: "flex", gap: "12px" }}>
            <button
              type="button"
              onClick={() => handleCurrencyChange("EUR")}
              style={{
                flex: 1,
                padding: "12px 20px",
                background: currency === "EUR" ? "#2b2b2b" : "#1f1f1f",
                border: "none",
                borderRadius: "10px",
                color: currency === "EUR" ? "#f0f0f0" : "#aaaaaa",
                textTransform: "none",
                cursor: "pointer",
                fontWeight: currency === "EUR" ? 600 : 400,
                transition: "background 0.2s, color 0.2s",
              }}
              onMouseEnter={(e) => {
                if (currency !== "EUR") {
                  e.currentTarget.style.background = "#383838";
                }
              }}
              onMouseLeave={(e) => {
                if (currency !== "EUR") {
                  e.currentTarget.style.background = "#1f1f1f";
                }
              }}
            >
              Euro
            </button>
            <button
              type="button"
              onClick={() => handleCurrencyChange("USD")}
              style={{
                flex: 1,
                padding: "12px 20px",
                background: currency === "USD" ? "#2b2b2b" : "#1f1f1f",
                border: "none",
                borderRadius: "10px",
                color: currency === "USD" ? "#f0f0f0" : "#aaaaaa",
                textTransform: "none",
                cursor: "pointer",
                fontWeight: currency === "USD" ? 600 : 400,
                transition: "background 0.2s, color 0.2s",
              }}
              onMouseEnter={(e) => {
                if (currency !== "USD") {
                  e.currentTarget.style.background = "#383838";
                }
              }}
              onMouseLeave={(e) => {
                if (currency !== "USD") {
                  e.currentTarget.style.background = "#1f1f1f";
                }
              }}
            >
              Dollar
            </button>
          </div>
        </div>
      )}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "12px",
          marginTop: "56px",
        }}
      >
        <button
          type="button"
          onClick={handleCancel}
          style={{
            background: "#ef4444",
            border: "none",
            borderRadius: "10px",
            padding: "10px 20px",
            color: "#f0f0f0",
            textTransform: "none",
            fontWeight: 600,
            transition: "background 0.2s",
            cursor: "pointer",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "#dc2626";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "#ef4444";
          }}
        >
          Cancel
        </button>

        <div style={{ display: "flex", gap: "10px" }}>
          {step > 0 && (
            <button
              type="button"
              onClick={back}
              style={{
                background: "#2b2b2b",
                color: "#aaaaaa",
                padding: "10px 20px",
                borderRadius: "10px",
                textTransform: "none",
                border: "none",
                transition: "background 0.2s",
                fontWeight: 400,
                cursor: "pointer",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "#383838";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "#2b2b2b";
              }}
            >
              Back
            </button>
          )}
          <button
            type="button"
            disabled={!canNext}
            onClick={next}
            style={{
              background: canNext ? "#555555" : "#3a3a3a",
              border: "none",
              borderRadius: "10px",
              padding: "10px 20px",
              color: "#f0f0f0",
              textTransform: "none",
              fontWeight: 600,
              transition: "background 0.2s, opacity 0.2s",
              opacity: canNext ? 1 : 0.6,
              cursor: canNext ? "pointer" : "not-allowed",
            }}
            onMouseEnter={(e) => {
              if (canNext) e.currentTarget.style.background = "#666666";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = canNext ? "#555555" : "#3a3a3a";
            }}
          >
            {step === 4 ? "Finish" : "Next"}
          </button>
        </div>
      </div>
    </section>
  );
};


