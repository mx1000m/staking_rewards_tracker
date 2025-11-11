import React, { useState, useEffect } from "react";
import { useTrackerStore, Tracker, Currency } from "../store/trackerStore";

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
  const { updateTracker } = useTrackerStore();
  const [name, setName] = useState(tracker.name);
  const [walletAddress, setWalletAddress] = useState(tracker.walletAddress);
  const [currency, setCurrency] = useState<Currency>(tracker.currency);
  const [country, setCountry] = useState(tracker.country);
  const [taxRate, setTaxRate] = useState<number>(tracker.taxRate);
  const [etherscanKey, setEtherscanKey] = useState(tracker.etherscanKey);
  const [confirmChange, setConfirmChange] = useState(false);

  useEffect(() => {
    // Prevent body scroll when modal is open
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "unset";
    };
  }, []);

  const doSave = () => {
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

    updateTracker(tracker.id, {
      name: name.trim(),
      walletAddress,
      currency,
      country,
      taxRate,
      etherscanKey,
    });
    onSaved?.();
    onClose();
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

  return (
    <div
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
      onClick={onClose}
    >
      <div
        className="card"
        style={{
          width: "100%",
          maxWidth: "600px",
          maxHeight: "90vh",
          overflowY: "auto",
          position: "relative",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
          <h2 style={{ margin: 0 }}>Edit Node Tracker</h2>
          <button
            onClick={onClose}
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
            <div className="row">
              <label>
                <input
                  type="radio"
                  checked={currency === "EUR"}
                  onChange={() => setCurrency("EUR")}
                />{" "}
                Euro
              </label>
              <label>
                <input
                  type="radio"
                  checked={currency === "USD"}
                  onChange={() => setCurrency("USD")}
                />{" "}
                Dollar
              </label>
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
          </div>

          <div>
            <label style={{ display: "block", marginBottom: "8px", color: "#e8e8f0", fontSize: "0.9rem" }}>
              Etherscan API Key
            </label>
            <input
              className="input"
              placeholder="ETHERSCAN_API_KEY"
              type="password"
              value={etherscanKey}
              onChange={(e) => setEtherscanKey(e.target.value)}
            />
            <p className="muted" style={{ marginTop: "8px", fontSize: "0.85rem" }}>
              Each user should bring their own Etherscan API key.
            </p>
          </div>
        </div>

        <div className="actions" style={{ marginTop: "24px" }}>
          <button onClick={onClose} style={{ background: "#2a2a44" }}>
            Cancel
          </button>
          <button onClick={handleSave}>Confirm</button>
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
                <button style={{ background: "#2a2a44" }} onClick={() => setConfirmChange(false)}>
                  Cancel
                </button>
                <button onClick={() => { setConfirmChange(false); doSave(); }}>
                  Confirm
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};


