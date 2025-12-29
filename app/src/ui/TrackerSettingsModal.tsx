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
  const { updateTracker, syncTrackerToFirestore, removeTracker, trackers } = useTrackerStore();
  const { user } = useAuth();
  const [name, setName] = useState(tracker.name);
  const [walletAddress, setWalletAddress] = useState(tracker.walletAddress);
  const [feeRecipientAddress, setFeeRecipientAddress] = useState(tracker.feeRecipientAddress || "");
  const [currency, setCurrency] = useState<Currency>(tracker.currency);
  const [country, setCountry] = useState(tracker.country);
  const [taxRate, setTaxRate] = useState<number>(tracker.taxRate);
  const [etherscanKey, setEtherscanKey] = useState(tracker.etherscanKey);
  const [confirmChange, setConfirmChange] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteNameInput, setDeleteNameInput] = useState("");
  const [deleteNameError, setDeleteNameError] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [saveButtonText, setSaveButtonText] = useState("Save");
  const [animationState, setAnimationState] = useState<"enter" | "exit">("enter");
  const [shakeInput, setShakeInput] = useState(false);
  const closeTimeoutRef = useRef<number | null>(null);
  const MODAL_ANIMATION_DURATION = 175;

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
    if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      alert("Please enter a valid Ethereum withdrawal address.");
      return;
    }
    if (duplicateTracker) {
      // Trigger shake animation
      setShakeInput(true);
      setTimeout(() => setShakeInput(false), 500);
      return;
    }
    // Validate fee recipient address if provided
    if (feeRecipientAddress.trim() && !/^0x[a-fA-F0-9]{40}$/.test(feeRecipientAddress.trim())) {
      alert("Please enter a valid Ethereum fee recipient address or leave it empty.");
      return;
    }
    if (taxRate < 0 || taxRate > 100) {
      alert("Tax rate must be between 0 and 100.");
      return;
    }
    if (!etherscanKey.trim()) {
      alert("Please enter an Etherscan API key.");
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

    // Normalize fee recipient address: if empty, don't store it (will default to walletAddress)
    const normalizedFeeRecipient = feeRecipientAddress.trim() || undefined;
    
    updateTracker(tracker.id, {
      name: name.trim(),
      walletAddress,
      feeRecipientAddress: normalizedFeeRecipient,
      currency,
      country,
      taxRate,
      etherscanKey,
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
          <h2 style={{ margin: 0, color: "#f0f0f0" }}>Edit node tracker</h2>
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
          <div>
            <label style={{ display: "block", marginBottom: "8px", color: "#f0f0f0", fontSize: "0.9rem" }}>
              Name
            </label>
            <input
              className="input"
              placeholder="Node Tracker 1"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

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
                animation: shakeInput ? "shake 0.5s" : undefined,
              }}
            />
            {duplicateTracker && (
              <p style={{ margin: "8px 0 0 0", fontSize: "0.8rem", color: "#ef4444" }}>
                ⚠ This staking node is already being tracked in {duplicateTracker.name || "another tracker"}.
              </p>
            )}
          </div>

          <div>
            <label style={{ display: "block", marginBottom: "0px", color: "#f0f0f0", fontSize: "0.9rem" }}>
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

          <div>
            <label style={{ display: "block", marginBottom: "8px", color: "#f0f0f0", fontSize: "0.9rem" }}>
              Currency preference
            </label>
            <div style={{ display: "flex", gap: "12px" }}>
              <button
                type="button"
                onClick={() => setCurrency("EUR")}
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
                onClick={() => setCurrency("USD")}
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
                placeholder="ETHERSCAN_API_KEY"
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
                    Type the exact name of your node to confirm deletion:
                  </p>
                  <input
                    id="delete-name-input"
                    className="input"
                    value={deleteNameInput}
                    placeholder="Enter node name"
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

