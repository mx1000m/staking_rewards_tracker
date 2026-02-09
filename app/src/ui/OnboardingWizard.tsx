import React, { useMemo, useState, useEffect } from "react";
import { useTrackerStore, Currency } from "../store/trackerStore";
import { useAuth } from "../hooks/useAuth";

type OnboardingWizardProps = {
  onComplete?: () => void;
};

const COUNTRY_DEFAULT_TAX: Record<string, number> = {
  Croatia: 24,
  Germany: 25,
  "United Kingdom": 20,
};

export const OnboardingWizard: React.FC<OnboardingWizardProps> = ({ onComplete }) => {
  const { addTracker, syncTrackerToFirestore, trackers, currency: globalCurrency, setCurrency } = useTrackerStore();
  const { user } = useAuth();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [feeRecipientAddress, setFeeRecipientAddress] = useState("");
  const [validatorPublicKey, setValidatorPublicKey] = useState("");
  const [mevMode, setMevMode] = useState<"none" | "direct" | "pool" | "mixed">("none");
  const [mevPoolPayoutAddress, setMevPoolPayoutAddress] = useState("");
  const [beaconApiKey, setBeaconApiKeyLocal] = useState("");
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
  const [country, setCountry] = useState("Croatia");
  const [taxRate, setTaxRate] = useState<number>(COUNTRY_DEFAULT_TAX["Croatia"]);
  const [etherscanKey, setEtherscanKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [shakeNameInput, setShakeNameInput] = useState(false);

  // Get next available tracker name
  const getNextAvailableName = useMemo(() => {
    let num = 1;
    while (trackers.some((t) => t.name === `Validator Tracker ${num}`)) {
      num++;
    }
    return `Validator Tracker ${num}`;
  }, [trackers]);

  // Check for duplicate name
  const duplicateName = useMemo(() => {
    const trimmedName = name.trim();
    if (!trimmedName) return null;
    return trackers.find((t) => t.name === trimmedName) || null;
  }, [name, trackers]);

  // Check for duplicate consensus layer address
  const duplicateTracker = useMemo(() => {
    if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      return null;
    }
    const normalizedAddress = walletAddress.toLowerCase();
    return trackers.find(
      (t) => t.walletAddress.toLowerCase() === normalizedAddress
    ) || null;
  }, [walletAddress, trackers]);

  // Prevent background scrolling while the wizard is open
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  // Pre-fill Etherscan API key from existing tracker if available
  useEffect(() => {
    if (trackers.length > 0 && trackers[0].etherscanKey) {
      setEtherscanKey(trackers[0].etherscanKey);
    }
  }, [trackers]);

  const isFirstTracker = trackers.length === 0;

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
      const walletValid = /^0x[a-fA-F0-9]{40}$/.test(walletAddress);
      const feeRecipientValid = !feeRecipientAddress.trim() || /^0x[a-fA-F0-9]{40}$/.test(feeRecipientAddress.trim());
      const noDuplicate = !duplicateTracker; // Prevent proceeding if address is duplicate
      return walletValid && feeRecipientValid && noDuplicate;
    }
    if (step === 2) return currency === "EUR" || currency === "USD";
    if (step === 3) return taxRate >= 0 && taxRate <= 100;
    if (step === 4) return etherscanKey.trim().length > 0;
    if (step === 5) {
      const hasValidatorKey = validatorPublicKey.trim().length > 0;
      const mevPoolValid =
        mevMode !== "pool" && mevMode !== "mixed"
          ? true
          : /^0x[a-fA-F0-9]{40}$/.test(mevPoolPayoutAddress.trim());
      return hasValidatorKey && mevPoolValid;
    }
    return true;
  }, [step, name, walletAddress, feeRecipientAddress, currency, taxRate, etherscanKey, validatorPublicKey, mevMode, mevPoolPayoutAddress, duplicateTracker, duplicateName]);

  const next = async () => {
    if (!canNext) {
      // Trigger shake animation if trying to proceed with duplicate name
      if (step === 0 && duplicateName) {
        setShakeNameInput(true);
        setTimeout(() => setShakeNameInput(false), 500);
      }
      return;
    }
    if (step === 5) {
      // Save tracker and complete
      // Use placeholder name if name is empty
      const defaultName = name.trim() || `Validator Tracker ${trackers.length + 1}`;
      
      // Update global currency preference (already updated via handleCurrencyChange)
      
      // Add tracker (currency is now global, but we keep it in tracker for backward compatibility)
      addTracker({
        walletAddress,
        feeRecipientAddress: feeRecipientAddress.trim() || undefined,
        currency, // Keep for backward compatibility, but global currency is used for display
        country,
        taxRate,
        etherscanKey,
        name: defaultName,
        validatorPublicKey: validatorPublicKey.trim() || undefined,
        beaconApiProvider: beaconApiKeyLocal ? "beaconcha" : undefined,
        beaconApiKey: beaconApiKeyLocal.trim() || undefined,
        mevMode,
        mevPoolPayoutAddress:
          mevMode === "pool" || mevMode === "mixed"
            ? mevPoolPayoutAddress.trim() || undefined
            : undefined,
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

  const onChangeCountry = (val: string) => {
    setCountry(val);
    const def = COUNTRY_DEFAULT_TAX[val];
    if (typeof def === "number") setTaxRate(def);
  };


  return (
    <section style={{ position: "relative", width: "100%", boxSizing: "border-box" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
        <h1 style={{ margin: 0, fontSize: "1.5rem", fontWeight: 600 }}>
          {isFirstTracker ? "Set up your first validator tracker" : "Set up your next validator tracker"}
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
            Name:
          </label>
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
            Consensus layer withdrawal address
          </label>
          <p className="muted" style={{ margin: "4px 0 9px 0", fontSize: "0.8rem", color: "#aaaaaa" }}>
            Receives staking rewards directly from the beacon chain (partial withdrawals).
          </p>
          <input
            className="input"
            placeholder="0x..."
            value={walletAddress}
            onChange={(e) => setWalletAddress(e.target.value.trim())}
            style={{
              borderColor: duplicateTracker ? "#ef4444" : undefined,
              borderWidth: duplicateTracker ? "2px" : undefined,
            }}
          />
          {duplicateTracker && (
            <p style={{ margin: "8px 0 0 0", fontSize: "0.8rem", color: "#ef4444" }}>
              ⚠ This validator is already being tracked in {duplicateTracker.name || `Validator Tracker ${trackers.findIndex((t) => t.id === duplicateTracker.id) + 1}`}.
            </p>
          )}
          <label style={{ display: "block", marginTop: "20px", marginBottom: "0px", color: "#f0f0f0", fontSize: "0.9rem" }}>
            Execution layer withdrawal address (optional)
          </label>
          <p className="muted" style={{ margin: "4px 0 9px 0", fontSize: "0.8rem", color: "#aaaaaa" }}>
            Receives MEV and priority fee rewards.
          </p>
          <input
            className="input"
            placeholder="0x... (leave empty if same as withdrawal address)"
            value={feeRecipientAddress}
            onChange={(e) => setFeeRecipientAddress(e.target.value.trim())}
          />
        </div>
      )}
      {step === 2 && (
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
      {step === 3 && (
        <div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-end",
              marginBottom: "8px",
            }}
          >
            <label style={{ display: "block", marginBottom: "0px", color: "#f0f0f0", fontSize: "0.9rem" }}>
              Country
            </label>
            <div style={{ width: "120px", display: "flex", justifyContent: "flex-start" }}>
              <label style={{ display: "block", color: "#f0f0f0", fontSize: "0.9rem", marginLeft: "-20px" }}>
                Income tax rate
              </label>
            </div>
          </div>
          <div className="row">
            <select
              className="gradient-select"
              value={country}
              onChange={(e) => onChangeCountry(e.target.value)}
              style={{ flex: 1 }}
            >
              {Object.keys(COUNTRY_DEFAULT_TAX).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <input
                className="input"
                type="number"
                min={0}
                max={100}
                step={0.1}
                value={taxRate}
                onChange={(e) => setTaxRate(parseFloat(e.target.value))}
                style={{ width: "120px" }}
              />
              <span style={{ color: "#9aa0b4" }}>%</span>
            </div>
          </div>
          <p className="muted" style={{ margin: "4px 0 3px 0", fontSize: "0.8rem", color: "#aaaaaa" }}>
            The country income tax rate is simply indicative. Please check with your local authorities for your exact tax rate.
          </p>
        </div>
      )}
      {step === 4 && (
        <div>
          <label style={{ display: "block", marginBottom: "0px", color: "#f0f0f0", fontSize: "0.9rem" }}>
            Etherscan API key
          </label>
          <p className="muted" style={{ margin: "4px 0 9px 0", fontSize: "0.8rem", color: "#aaaaaa" }}>
            Create an account on{" "}
            <a
              href="https://etherscan.io/apidashboard"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "#aaaaaa", textDecoration: "underline" }}
            >
              Etherscan
            </a>{" "}
            for free to get an API key.
          </p>
          <div style={{ position: "relative" }}>
            <input
              className="input"
              placeholder="Etherscan API key"
              type={showApiKey ? "text" : "password"}
              value={etherscanKey}
              onChange={(e) => setEtherscanKey(e.target.value)}
              style={{ paddingRight: "40px" }}
            />
            <button
              type="button"
              onClick={() => setShowApiKey(!showApiKey)}
              style={{
                position: "absolute",
                right: "12px",
                top: "50%",
                transform: "translateY(-50%)",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                padding: "4px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#9aa0b4",
                transition: "color 0.2s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "#e8e8f0";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "#9aa0b4";
              }}
            >
              <img
                src={showApiKey ? "/staking_rewards_tracker/icons/eye_off_icon.svg" : "/staking_rewards_tracker/icons/eye_icon.svg"}
                alt={showApiKey ? "Hide" : "Show"}
                style={{ width: "20px", height: "20px", filter: "brightness(0) saturate(1) invert(60%)" }}
              />
            </button>
          </div>
        </div>
      )}
      {step === 5 && (
        <div>
          <label style={{ display: "block", marginBottom: "8px", color: "#f0f0f0", fontSize: "0.9rem" }}>
            Beaconcha validator public key
          </label>
          <input
            className="input"
            placeholder="0x... validator pubkey"
            value={validatorPublicKey}
            onChange={(e) => setValidatorPublicKey(e.target.value.trim())}
          />
          <p className="muted" style={{ margin: "8px 0 16px 0", fontSize: "0.8rem", color: "#aaaaaa" }}>
            Used to fetch consensus-layer staking rewards from the beacon chain.
          </p>

          <label style={{ display: "block", marginBottom: "8px", color: "#f0f0f0", fontSize: "0.9rem" }}>
            Beaconcha API key (optional)
          </label>
          <input
            className="input"
            placeholder="Beaconcha API key (can be shared across validators)"
            value={beaconApiKeyLocal}
            onChange={(e) => setBeaconApiKeyLocal(e.target.value.trim())}
          />
          <p className="muted" style={{ margin: "8px 0 16px 0", fontSize: "0.8rem", color: "#aaaaaa" }}>
            Free API key from beaconcha.in. If omitted, only execution-layer rewards will be tracked.
          </p>

          <label style={{ display: "block", marginBottom: "8px", color: "#f0f0f0", fontSize: "0.9rem" }}>
            How do you receive MEV rewards?
          </label>
          <div style={{ display: "flex", gap: "12px", marginBottom: "12px" }}>
            <button
              type="button"
              onClick={() => setMevMode("none")}
              style={{
                flex: 1,
                padding: "10px 16px",
                background: mevMode === "none" ? "#2b2b2b" : "#1f1f1f",
                border: "none",
                borderRadius: "10px",
                color: mevMode === "none" ? "#f0f0f0" : "#aaaaaa",
                cursor: "pointer",
              }}
            >
              No MEV
            </button>
            <button
              type="button"
              onClick={() => setMevMode("direct")}
              style={{
                flex: 1,
                padding: "10px 16px",
                background: mevMode === "direct" ? "#2b2b2b" : "#1f1f1f",
                border: "none",
                borderRadius: "10px",
                color: mevMode === "direct" ? "#f0f0f0" : "#aaaaaa",
                cursor: "pointer",
              }}
            >
              Direct to fee recipient
            </button>
            <button
              type="button"
              onClick={() => setMevMode("pool")}
              style={{
                flex: 1,
                padding: "10px 16px",
                background: mevMode === "pool" ? "#2b2b2b" : "#1f1f1f",
                border: "none",
                borderRadius: "10px",
                color: mevMode === "pool" ? "#f0f0f0" : "#aaaaaa",
                cursor: "pointer",
              }}
            >
              MEV pool / smoothing
            </button>
          </div>

          {(mevMode === "pool" || mevMode === "mixed") && (
            <>
              <label style={{ display: "block", marginBottom: "8px", color: "#f0f0f0", fontSize: "0.9rem" }}>
                MEV pool payout address
              </label>
              <input
                className="input"
                placeholder="0x... address receiving MEV pool payouts"
                value={mevPoolPayoutAddress}
                onChange={(e) => setMevPoolPayoutAddress(e.target.value.trim())}
              />
              <p className="muted" style={{ margin: "8px 0 0 0", fontSize: "0.8rem", color: "#aaaaaa" }}>
                All incoming ETH to this address will be treated as MEV pool income.
              </p>
            </>
          )}
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
            Next
          </button>
        </div>
      </div>
    </section>
  );
};


