import React, { useState, useEffect, useRef, useMemo } from "react";
import { useTrackerStore, Tracker, Currency } from "../store/trackerStore";
import { clearCache } from "../utils/transactionCache";
import { useAuth } from "../hooks/useAuth";
import { deleteFirestoreTracker, deleteFirestoreTransactions } from "../utils/firestoreAdapter";

const COUNTRY_DEFAULT_TAX: Record<string, number> = {
  Croatia: 24,
  Germany: 25,
  "United Kingdom": 20,
};

interface TrackerSettingsModalProps {
  tracker: Tracker;
  onClose: () => void;
  onSaved?: () => void;
}

export const TrackerSettingsModal: React.FC<TrackerSettingsModalProps> = ({ tracker, onClose, onSaved }) => {
  const { updateTracker, syncTrackerToFirestore, removeTracker, trackers, currency: globalCurrency, setCurrency } = useTrackerStore();
  const { user } = useAuth();
  const [name, setName] = useState(tracker.name);
  const [walletAddress, setWalletAddress] = useState(tracker.walletAddress);
  const [feeRecipientAddress, setFeeRecipientAddress] = useState(tracker.feeRecipientAddress || "");
  const [validatorPublicKey, setValidatorPublicKey] = useState(tracker.validatorPublicKey || "");
  const [beaconApiKeyLocal, setBeaconApiKeyLocal] = useState(tracker.beaconApiKey || "");
  const [mevMode, setMevMode] = useState<"none" | "direct" | "pool" | "mixed">(tracker.mevMode || "none");
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
  const [country, setCountry] = useState(tracker.country);
  const [taxRate, setTaxRate] = useState<number>(tracker.taxRate);
  const [etherscanKey, setEtherscanKey] = useState(tracker.etherscanKey);
  const [confirmChange, setConfirmChange] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteNameInput, setDeleteNameInput] = useState("");
  const [deleteNameError, setDeleteNameError] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [showBeaconApiKey, setShowBeaconApiKey] = useState(false);
  const [saveButtonText, setSaveButtonText] = useState("Save");
  const [animationState, setAnimationState] = useState<"enter" | "exit">("enter");
  const [shakeNameInput, setShakeNameInput] = useState(false);
  const [shakeAddressInput, setShakeAddressInput] = useState(false);
  const [shakeFeeRecipient, setShakeFeeRecipient] = useState(false);
  const [shakeEtherscanKey, setShakeEtherscanKey] = useState(false);
  const [publicKeyCopied, setPublicKeyCopied] = useState(false);
  const closeTimeoutRef = useRef<number | null>(null);
  const MODAL_ANIMATION_DURATION = 175;

  // Check for duplicate name (excluding current tracker)
  const duplicateName = useMemo(() => {
    const trimmedName = name.trim();
    if (!trimmedName) return null;
    return trackers.find((t) => t.id !== tracker.id && t.name === trimmedName) || null;
  }, [name, trackers, tracker.id]);

  // Check for duplicate consensus layer address (excluding current tracker)
  const duplicateTracker = useMemo(() => {
    if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      return null;
    }
    const normalizedAddress = walletAddress.toLowerCase();
    return trackers.find(
      (t) => t.id !== tracker.id && t.walletAddress.toLowerCase() === normalizedAddress
    ) || null;
  }, [walletAddress, trackers, tracker.id]);

  useEffect(() => {
    // Prevent body scroll when modal is open
    // Calculate scrollbar width to prevent layout shift
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    const originalOverflow = document.body.style.overflow;
    const originalPaddingRight = document.body.style.paddingRight;
    
    document.body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }
    setAnimationState("enter");
    
    return () => {
      document.body.style.overflow = originalOverflow;
      document.body.style.paddingRight = originalPaddingRight;
      if (closeTimeoutRef.current) {
        window.clearTimeout(closeTimeoutRef.current);
      }
    };
  }, []);

  const requestClose = () => {
    if (animationState === "exit") return;
    setAnimationState("exit");
    closeTimeoutRef.current = window.setTimeout(() => {
      closeTimeoutRef.current = null;
      onClose();
    }, MODAL_ANIMATION_DURATION);
  };

  const doSave = async () => {
    // Validate inputs
    if (!name.trim()) {
      alert("Please enter a name for the tracker.");
      return;
    }
    if (duplicateName) {
      setShakeNameInput(true);
      setTimeout(() => setShakeNameInput(false), 500);
      return;
    }
    if (taxRate < 0 || taxRate > 100) {
      alert("Tax rate must be between 0 and 100.");
      return;
    }

    const walletChanged = walletAddress.toLowerCase() !== tracker.walletAddress.toLowerCase();
    const feeRecipientChanged = (feeRecipientAddress.trim() || undefined) !== (tracker.feeRecipientAddress || undefined);
    
    // If wallet address changed, delete all transactions from Firestore and clear cache
    if (walletChanged && user) {
      try {
        await deleteFirestoreTransactions(user.uid, tracker.id);
      } catch (error) {
        console.error("Failed to delete transactions from Firestore:", error);
      }
    }
    
    // Clear cache if wallet or fee recipient changed
    if (walletChanged || feeRecipientChanged) {
      await clearCache(tracker.id);
    }

    // Normalize fee recipient address
    const normalizedFeeRecipient =
      mevMode === "direct" ? (feeRecipientAddress.trim() || undefined) : undefined;

    updateTracker(tracker.id, {
      name: name.trim(),
      walletAddress,
      feeRecipientAddress: normalizedFeeRecipient,
      validatorPublicKey: validatorPublicKey.trim() || undefined,
      beaconApiProvider: beaconApiKeyLocal.trim() ? "beaconcha" : undefined,
      beaconApiKey: beaconApiKeyLocal.trim() || undefined,
      mevMode,
      country,
      taxRate,
      // Etherscan is no longer required for direct mode; keep existing key only for future pool support.
      etherscanKey: tracker.etherscanKey,
    });
    
    // Sync to Firestore if authenticated
    if (user) {
      const { trackers } = useTrackerStore.getState();
      const updatedTracker = trackers.find((t) => t.id === tracker.id);
      if (updatedTracker) {
        await syncTrackerToFirestore(user.uid, updatedTracker);
      }
    }
    
    // Show "Saved!" animation
    setSaveButtonText("Saved!");
    await new Promise(resolve => setTimeout(resolve, 200));
    
    onSaved?.();
    requestClose();
  };

  const handleSave = () => {
    const walletChanged = walletAddress.toLowerCase() !== tracker.walletAddress.toLowerCase();
    // Only show confirmation for wallet address changes (not fee recipient)
    if (walletChanged) {
      setConfirmChange(true);
      return;
    }
    doSave();
  };

  const onChangeCountry = (val: string) => {
    setCountry(val);
    const def = COUNTRY_DEFAULT_TAX[val];
    if (typeof def === "number") setTaxRate(def);
  };

  const handleDelete = async () => {
    // Check if input is empty or doesn't match
    const inputValue = deleteNameInput.trim();
    
    if (!inputValue || inputValue !== tracker.name.trim()) {
      setDeleteNameError(true);
      setDeleteNameInput("");
      // Shake animation
      const input = document.getElementById("delete-name-input");
      if (input) {
        input.style.animation = "shake 0.5s";
        setTimeout(() => {
          input.style.animation = "";
        }, 500);
      }
      return;
    }

    // Delete from Firestore if authenticated
    if (user) {
      try {
        await deleteFirestoreTracker(user.uid, tracker.id);
      } catch (error) {
        console.error("Failed to delete tracker from Firestore:", error);
      }
    }

    // Clear cache
    await clearCache(tracker.id);
    
    // Remove from store
    removeTracker(tracker.id);
    
    onSaved?.();
    onClose();
  };

  return (
    <div
      className={`modal-overlay ${animationState === "enter" ? "modal-overlay-enter" : "modal-overlay-exit"}`}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgba(0, 0, 0, 0.7)",
        backdropFilter: "blur(3px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: "20px",
      }}
      onClick={requestClose}
    >
      <div
        className={`modal-card ${animationState === "enter" ? "modal-card-enter" : "modal-card-exit"}`}
        style={{
          width: "100%",
          maxWidth: "650px",
          position: "relative",
        }}
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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px", paddingRight: "48px" }}>
          <h2 style={{ margin: 0, color: "#f0f0f0" }}>Edit validator tracker</h2>
          <button
            onClick={requestClose}
            style={{
              background: "transparent",
              border: "none",
              color: "#9aa0b4",
              fontSize: "24px",
              cursor: "pointer",
              padding: 0,
              width: "32px",
              height: "32px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              position: "absolute",
              top: "12px",
              right: "12px",
            }}
          >
            ×
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "30px" }}>
          {/* Name */}
          <div>
            <label style={{ display: "block", marginBottom: "8px", color: "#f0f0f0", fontSize: "0.9rem" }}>
              Name
            </label>
            <input
              className="input"
              placeholder="Validator 1"
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

          {/* Beacon chain validator public key (read-only, copyable) */}
          <div>
            <label style={{ display: "block", marginBottom: "0px", color: "#f0f0f0", fontSize: "0.9rem" }}>
              Beacon chain validator public key
            </label>
            <p className="muted" style={{ margin: "4px 0 9px 0", fontSize: "0.8rem", color: "#aaaaaa" }}>
              Used to identify your validator on the beacon chain (consensus layer). Create a new tracker if you want to track a different validator.
            </p>
            <div style={{ position: "relative" }}>
              <input
                className="input"
                readOnly
                onFocus={(e) => {
                  // Show full key when focused for easier selection
                  e.currentTarget.value = validatorPublicKey;
                  // Select all text so user can copy quickly
                  e.currentTarget.select();
                }}
                onBlur={(e) => {
                  // Restore truncated display on blur
                  const truncated =
                    validatorPublicKey && validatorPublicKey.length > 30
                      ? `${validatorPublicKey.slice(0, 15)}...${validatorPublicKey.slice(-15)}`
                      : validatorPublicKey;
                  e.currentTarget.value = truncated;
                }}
                defaultValue={
                  validatorPublicKey && validatorPublicKey.length > 30
                    ? `${validatorPublicKey.slice(0, 15)}...${validatorPublicKey.slice(-15)}`
                    : validatorPublicKey
                }
                style={{ paddingRight: "40px", cursor: "text" }}
              />
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(validatorPublicKey);
                    setPublicKeyCopied(true);
                    setTimeout(() => setPublicKeyCopied(false), 1200);
                  } catch (e) {
                    console.error("Failed to copy validator public key:", e);
                  }
                }}
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
                  src="/staking_rewards_tracker/icons/copy_icon.svg"
                  alt={publicKeyCopied ? "Copied" : "Copy"}
                  style={{
                    width: "18px",
                    height: "18px",
                    filter: "brightness(0) saturate(1) invert(60%)",
                  }}
                />
              </button>
            </div>
            {publicKeyCopied && (
              <p style={{ margin: "6px 0 0 0", fontSize: "0.8rem", color: "#d9b569" }}>Copied to clipboard.</p>
            )}
          </div>

          {/* Beaconcha.in API key */}
          <div>
            <label style={{ display: "block", marginBottom: "0px", color: "#f0f0f0", fontSize: "0.9rem" }}>
              Your beaconcha.in API key
            </label>
            <p className="muted" style={{ margin: "4px 0 9px 0", fontSize: "0.8rem", color: "#aaaaaa" }}>
              Get your API key by signing up for free on{" "}
              <a
                href="https://beaconcha.in"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "#aaaaaa", textDecoration: "underline" }}
              >
                beaconcha.in
              </a>
              .
            </p>
            <div style={{ position: "relative" }}>
              <input
                className="input"
                placeholder="Beaconcha.in API key"
                type={showBeaconApiKey ? "text" : "password"}
                value={beaconApiKeyLocal}
                onChange={(e) => setBeaconApiKeyLocal(e.target.value.trim())}
                style={{ paddingRight: "40px" }}
              />
              <button
                type="button"
                onClick={() => setShowBeaconApiKey(!showBeaconApiKey)}
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
                  src={showBeaconApiKey ? "/staking_rewards_tracker/icons/eye_off_icon.svg" : "/staking_rewards_tracker/icons/eye_icon.svg"}
                  alt={showBeaconApiKey ? "Hide" : "Show"}
                  style={{ width: "20px", height: "20px", filter: "brightness(0) saturate(1) invert(60%)" }}
                />
              </button>
            </div>
          </div>

          {/* Execution rewards */}
          <div>
            <label style={{ display: "block", marginBottom: "0px", color: "#f0f0f0", fontSize: "0.9rem" }}>
              Execution rewards
            </label>
            <p className="muted" style={{ margin: "4px 0 9px 0", fontSize: "0.8rem", color: "#aaaaaa" }}>
              Track MEV and priority fees accurately.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "8px" }}>
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
                  name="settingsExecutionRewardsMode"
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
                  name="settingsExecutionRewardsMode"
                  value="direct"
                  checked={mevMode === "direct"}
                  onChange={() => setMevMode("direct")}
                  style={{ accentColor: "#f0f0f0" }}
                />
                <span>Priority fees and/or MEV rewards</span>
              </label>

              {/* No extra fields are required for Priority fees and/or MEV rewards.
                  Execution income is fetched directly from Beaconcha.in aggregates. */}

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
                  name="settingsExecutionRewardsMode"
                  value="pool"
                  disabled
                  checked={mevMode === "pool"}
                  onChange={() => {}}
                  style={{ accentColor: "#555555" }}
                />
                <span>MEV with smoothing pool (coming soon)</span>
              </label>
            </div>
          </div>

          {/* Currency preference */}
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

          {/* Country / Income tax rate */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: "8px" }}>
              <label style={{ display: "block", color: "#f0f0f0", fontSize: "0.9rem" }}>
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
                {Object.keys(COUNTRY_DEFAULT_TAX).map((c) => {
                  const isDisabled = c !== "Croatia";
                  return (
                    <option key={c} value={c} disabled={isDisabled}>
                      {c}{isDisabled ? " (coming soon)" : ""}
                    </option>
                  );
                })}
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
        </div>

        <div style={{ marginTop: "45px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <button
              onClick={() => {
                setShowDeleteConfirm(true);
                setDeleteNameInput("");
                setDeleteNameError(false);
              }}
              style={{
                background: "#ef4444",
                color: "white",
                padding: "10px 20px",
                border: "none",
                borderRadius: "8px",
                cursor: "pointer",
                fontWeight: 500,
                transition: "background 0.2s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "#dc2626";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "#ef4444";
              }}
            >
            Delete
          </button>
          <div className="actions" style={{ margin: 0 }}>
            <button
              onClick={requestClose}
              style={{
                background: "#2b2b2b",
                color: "#aaaaaa",
                padding: "10px 20px",
                borderRadius: "10px",
                textTransform: "none",
                border: "none",
                transition: "background 0.2s",
                fontWeight: 400,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "#383838";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "#2b2b2b";
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              style={{
                background: "#555555",
                border: "none",
                borderRadius: "10px",
                padding: "10px 20px",
                color: "#f0f0f0",
                textTransform: "none",
                fontWeight: 600,
                transition: "background 0.2s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "#666666";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "#555555";
              }}
            >
              {saveButtonText}
            </button>
          </div>
        </div>

        {confirmChange && (
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0, 0, 0, 0.7)",
              backdropFilter: "blur(3px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 1100,
              padding: "20px",
            }}
            onClick={() => setConfirmChange(false)}
          >
            <div
              style={{
                width: "100%",
                maxWidth: "520px",
                position: "relative",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div
                style={{
                  background: "#2a0808",
                  borderRadius: "18px",
                  padding: "1px",
                  border: "1px solid #ca3a32",
                }}
              >
                <div
                  style={{
                    background: "#2a0808",
                    borderRadius: "17px",
                    padding: "28px",
                  }}
                >
                  <h2 style={{ margin: 0, marginBottom: "16px", color: "#f0f0f0" }}>
                    Are you sure you want to change the consensus layer wallet address?
                  </h2>
                  <p style={{ margin: "0 0 16px", color: "#e8e8f0" }}>
                    ⚠ This will erase all data related to your previous wallet address. This action cannot be undone.
                  </p>
                  <div className="actions" style={{ marginTop: "24px" }}>
                    <button
                      style={{ background: "#2b2b2b" }}
                      onClick={() => setConfirmChange(false)}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = "#383838";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "#2b2b2b";
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => { setConfirmChange(false); doSave(); }}
                      style={{
                        background: "#ef4444",
                        color: "white",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = "#dc2626";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "#ef4444";
                      }}
                    >
                      Confirm
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {showDeleteConfirm && (
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0, 0, 0, 0.7)",
              backdropFilter: "blur(3px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 1100,
              padding: "20px",
            }}
            onClick={() => {
              setShowDeleteConfirm(false);
              setDeleteNameInput("");
              setDeleteNameError(false);
            }}
          >
            <div
              style={{
                width: "100%",
                maxWidth: "520px",
                position: "relative",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div
                style={{
                  background: "#2a0808",
                  borderRadius: "18px",
                  padding: "1px",
                  border: "1px solid #ca3a32",
                }}
              >
                <div
                  style={{
                    background: "#2a0808",
                    borderRadius: "17px",
                    padding: "28px",
                  }}
                >
                  <h2 style={{ margin: 0, marginBottom: "16px", color: "#f0f0f0" }}>
                    Are you sure you want to delete {tracker.name}?
                  </h2>
                  <p style={{ margin: "0 0 16px", color: "#e8e8f0" }}>
                    ⚠ This action cannot be undone.
                  </p>
                  <p style={{ margin: "0 0 8px", color: "#e8e8f0", fontSize: "0.9rem" }}>
                    Type the exact name of your validator tracker to confirm deletion:
                  </p>
                  <input
                    id="delete-name-input"
                    className="input"
                    value={deleteNameInput}
                    placeholder="Enter validator tracker name"
                    onChange={(e) => {
                      setDeleteNameInput(e.target.value);
                      setDeleteNameError(false);
                    }}
                    style={{
                      width: "100%",
                      marginBottom: "16px",
                      borderColor: deleteNameError ? "#ef4444" : undefined,
                      color: deleteNameError ? "#ef4444" : "#e8e8f0",
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        handleDelete();
                      }
                    }}
                  />
                  <div className="actions" style={{ marginTop: "24px" }}>
                    <button
                      style={{ background: "#2b2b2b" }}
                      onClick={() => {
                        setShowDeleteConfirm(false);
                        setDeleteNameInput("");
                        setDeleteNameError(false);
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = "#383838";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "#2b2b2b";
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleDelete}
                      style={{
                        background: "#ef4444",
                        color: "white",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = "#dc2626";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "#ef4444";
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
          </div>
        </div>
      </div>
    </div>
  );
};

