import React, { useState, useEffect, useRef } from "react";
import { useTrackerStore, Tracker, Currency } from "../store/trackerStore";
import { clearCache } from "../utils/transactionCache";
import { useAuth } from "../hooks/useAuth";
import { deleteFirestoreTracker } from "../utils/firestoreAdapter";

const COUNTRY_DEFAULT_TAX: Record<string, number> = {
  Croatia: 24,
  Germany: 25,
  France: 30,
  USA: 22
};

interface TrackerSettingsModalProps {
  tracker: Tracker;
  onClose: () => void;
  onSaved?: () => void;
}

export const TrackerSettingsModal: React.FC<TrackerSettingsModalProps> = ({ tracker, onClose, onSaved }) => {
  const { updateTracker, syncTrackerToFirestore, removeTracker } = useTrackerStore();
  const { user } = useAuth();
  const [name, setName] = useState(tracker.name);
  const [walletAddress, setWalletAddress] = useState(tracker.walletAddress);
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
  const closeTimeoutRef = useRef<number | null>(null);
  const MODAL_ANIMATION_DURATION = 350;

  useEffect(() => {
    // Prevent body scroll when modal is open
    document.body.style.overflow = "hidden";
    setAnimationState("enter");
    return () => {
      document.body.style.overflow = "unset";
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
      alert("Please enter a valid Ethereum wallet address.");
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
    
    // Clear cache if wallet changed
    if (walletChanged) {
      await clearCache(tracker.id);
    }

    updateTracker(tracker.id, {
      name: name.trim(),
      walletAddress,
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
            background: "linear-gradient(45deg, #3788fd, #01e1fd)",
            padding: "1px",
            borderRadius: "18px",
          }}
        >
          <div
            style={{
              background: "#1c1948",
              borderRadius: "17px",
              padding: "28px",
              maxHeight: "90vh",
              overflowY: "auto",
              overflowX: "hidden",
            }}
          >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
          <h2 style={{ margin: 0 }}>Edit node tracker</h2>
          <button
            onClick={requestClose}
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
            }}
          >
            ×
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          <div>
            <label style={{ display: "block", marginBottom: "8px", color: "#e8e8f0", fontSize: "0.9rem" }}>
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
            <label style={{ display: "block", marginBottom: "8px", color: "#e8e8f0", fontSize: "0.9rem" }}>
              Wallet Address (receiving staking rewards)
            </label>
            <input
              className="input"
              placeholder="0x..."
              value={walletAddress}
              onChange={(e) => setWalletAddress(e.target.value.trim())}
            />
          </div>

          <div>
            <label style={{ display: "block", marginBottom: "8px", color: "#e8e8f0", fontSize: "0.9rem" }}>
              Currency Preference
            </label>
            <div style={{ display: "flex", gap: "12px" }}>
              <button
                type="button"
                onClick={() => setCurrency("EUR")}
                style={{
                  flex: 1,
                  padding: "12px 20px",
                  background: currency === "EUR" ? "linear-gradient(45deg, #01e1fd, #3788fd)" : "#110e3f",
                  border: currency === "EUR" ? "none" : "1px solid #1a1a2e",
                  borderRadius: "10px",
                  color: currency === "EUR" ? "#ffffff" : "#24a7fd",
                  textTransform: "none",
                  cursor: "pointer",
                  fontWeight: currency === "EUR" ? 600 : 400,
                  transition: "all 0.2s",
                }}
                onMouseEnter={(e) => {
                  if (currency !== "EUR") {
                    e.currentTarget.style.background = "#1a1648";
                  }
                }}
                onMouseLeave={(e) => {
                  if (currency !== "EUR") {
                    e.currentTarget.style.background = "#110e3f";
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
                  background: currency === "USD" ? "linear-gradient(45deg, #01e1fd, #3788fd)" : "#110e3f",
                  border: currency === "USD" ? "none" : "1px solid #1a1a2e",
                  borderRadius: "10px",
                  color: currency === "USD" ? "#ffffff" : "#24a7fd",
                  textTransform: "none",
                  cursor: "pointer",
                  fontWeight: currency === "USD" ? 600 : 400,
                  transition: "all 0.2s",
                }}
                onMouseEnter={(e) => {
                  if (currency !== "USD") {
                    e.currentTarget.style.background = "#1a1648";
                  }
                }}
                onMouseLeave={(e) => {
                  if (currency !== "USD") {
                    e.currentTarget.style.background = "#110e3f";
                  }
                }}
              >
                Dollar
              </button>
            </div>
          </div>

          <div>
            <label style={{ display: "block", marginBottom: "8px", color: "#e8e8f0", fontSize: "0.9rem" }}>
              Country and Tax Rate
            </label>
            <div className="row">
              <select
                value={country}
                onChange={(e) => onChangeCountry(e.target.value)}
                style={{
                  padding: "12px 14px",
                  background: "#0e0e1a",
                  border: "1px solid #1a1a2e",
                  borderRadius: "10px",
                  color: "#e8e8f0",
                  flex: 1,
                }}
              >
                {Object.keys(COUNTRY_DEFAULT_TAX).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
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
            <p className="muted" style={{ marginTop: "8px", fontSize: "0.85rem" }}>
              Disclaimer: The country tax rate is simply indicative. Please check with your local authorities for your exact tax rate.
            </p>
          </div>

          <div>
            <label style={{ display: "block", marginBottom: "8px", color: "#e8e8f0", fontSize: "0.9rem" }}>
              Etherscan API Key
            </label>
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
            <p className="muted" style={{ marginTop: "8px", fontSize: "0.85rem" }}>
              You can find your{" "}
              <a
                href="https://etherscan.io/apidashboard"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "#24a7fd", textDecoration: "underline" }}
              >
                Etherscan API key here
              </a>.
            </p>
          </div>
        </div>

        <div style={{ marginTop: "32px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
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
              transition: "all 0.2s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "#dc2626";
              e.currentTarget.style.transform = "scale(1.05)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "#ef4444";
              e.currentTarget.style.transform = "scale(1)";
            }}
          >
            Delete
          </button>
          <div className="actions" style={{ margin: 0 }}>
            <button
              onClick={requestClose}
              style={{
                background: "#110e3f",
                color: "#24a7fd",
                padding: "10px 20px",
                borderRadius: "10px",
                textTransform: "none",
                border: "none",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "#1a1648";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "#110e3f";
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              style={{
                background: "linear-gradient(45deg, #01e1fd, #3788fd)",
                border: "none",
                borderRadius: "10px",
                padding: "10px 20px",
                color: "#ffffff",
                textTransform: "none",
                fontWeight: 600,
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
              background: "rgba(0,0,0,0.6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 1100,
            }}
            onClick={() => setConfirmChange(false)}
          >
            <div className="card" style={{ maxWidth: "520px" }} onClick={(e) => e.stopPropagation()}>
              <h3 style={{ marginTop: 0 }}>Change wallet address?</h3>
              <p style={{ margin: "8px 0 16px", color: "#e8e8f0" }}>
                Are you sure you want to change the wallet address?
              </p>
              <p className="muted" style={{ marginTop: 0 }}>
                This will erase all data from your previous node/wallet.
              </p>
              <div className="actions">
                <button
                  style={{ background: "#2a2a44" }}
                  onClick={() => setConfirmChange(false)}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "#3a3a54";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "#2a2a44";
                  }}
                >
                  Cancel
                </button>
                <button onClick={() => { setConfirmChange(false); doSave(); }}>
                  Confirm
                </button>
              </div>
            </div>
          </div>
        )}

        {showDeleteConfirm && (
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 1100,
            }}
            onClick={() => {
              setShowDeleteConfirm(false);
              setDeleteNameInput("");
              setDeleteNameError(false);
            }}
          >
            <div className="card" style={{ maxWidth: "520px" }} onClick={(e) => e.stopPropagation()}>
              <h3 style={{ marginTop: 0 }}>Delete {tracker.name}?</h3>
              <p style={{ margin: "8px 0 16px", color: "#e8e8f0" }}>
                Are you sure you want to delete "{tracker.name}"? This action cannot be undone.
              </p>
              <p style={{ margin: "8px 0 8px", color: "#e8e8f0", fontSize: "0.9rem" }}>
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
                  width: "calc(100% - 24px)",
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
              <div className="actions">
                <button
                  style={{ background: "#2a2a44" }}
                  onClick={() => {
                    setShowDeleteConfirm(false);
                    setDeleteNameInput("");
                    setDeleteNameError(false);
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "#3a3a54";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "#2a2a44";
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
        )}
          </div>
        </div>
      </div>
    </div>
  );
};

