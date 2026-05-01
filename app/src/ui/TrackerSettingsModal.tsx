import React, { useState } from "react";
import { Tracker, useTrackerStore } from "../store/trackerStore";
import { useAuth } from "../hooks/useAuth";

interface TrackerSettingsModalProps {
  tracker: Tracker;
  onClose: () => void;
  onSaved?: () => void;
}

export const TrackerSettingsModal: React.FC<TrackerSettingsModalProps> = ({
  tracker,
  onClose,
  onSaved,
}) => {
  const { updateTracker, setCurrency, syncTrackerToFirestore, currency: globalCurrency } =
    useTrackerStore();
  const { user } = useAuth();
  const [name, setName] = useState<string>(tracker.name || "");
  const [taxRate, setTaxRate] = useState<number>(tracker.taxRate ?? 24);
  const [currency, setLocalCurrency] = useState<"EUR" | "USD">(globalCurrency);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const normalizedName = name.trim() || tracker.name || "Validator 1";
      const normalizedTaxRate = Number.isFinite(taxRate) ? Math.max(0, Math.min(100, taxRate)) : 24;
      updateTracker(tracker.id, { name: normalizedName, taxRate: normalizedTaxRate, currency });
      setCurrency(currency);
      if (user) {
        await syncTrackerToFirestore(user.uid, {
          ...tracker,
          name: normalizedName,
          taxRate: normalizedTaxRate,
          currency,
        });
      }
      onSaved?.();
      onClose();
    } catch (e: any) {
      setError(e?.message || "Failed to save settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ color: "#f0f0f0" }}>
      <h3 style={{ margin: "0 0 6px 0", fontSize: "1.5rem" }}>Settings</h3>
      <p style={{ margin: "0 0 20px 0", color: "#aaaaaa", fontSize: "0.92rem" }}>
        Configure validator name, tax, and currency preferences.
      </p>

      <div style={{ display: "grid", gap: "14px" }}>
        <div>
          <label style={{ display: "block", color: "#cccccc", fontSize: "0.88rem", marginBottom: "6px" }}>
            Validator name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Validator 1"
            style={{
              width: "100%",
              background: "#222222",
              border: "1px solid #444444",
              borderRadius: "10px",
              padding: "10px 12px",
              color: "#f0f0f0",
              boxSizing: "border-box",
            }}
          />
        </div>
        <div>
          <label style={{ display: "block", color: "#cccccc", fontSize: "0.88rem", marginBottom: "6px" }}>
            Income tax rate (%)
          </label>
          <input
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={taxRate}
            onChange={(e) => setTaxRate(Number(e.target.value))}
            style={{
              width: "100%",
              background: "#222222",
              border: "1px solid #444444",
              borderRadius: "10px",
              padding: "10px 12px",
              color: "#f0f0f0",
              boxSizing: "border-box",
            }}
          />
        </div>

        <div>
          <label style={{ display: "block", color: "#cccccc", fontSize: "0.88rem", marginBottom: "6px" }}>
            Currency
          </label>
          <select
            value={currency}
            onChange={(e) => setLocalCurrency(e.target.value as "EUR" | "USD")}
            style={{
              width: "100%",
              background: "#222222",
              border: "1px solid #444444",
              borderRadius: "10px",
              padding: "10px 12px",
              color: "#f0f0f0",
              boxSizing: "border-box",
            }}
          >
            <option value="EUR">EUR</option>
            <option value="USD">USD</option>
          </select>
        </div>
      </div>

      {error && <p style={{ color: "#ff9b9b", marginTop: "12px" }}>{error}</p>}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "20px" }}>
        <button
          onClick={onClose}
          style={{
            background: "transparent",
            border: "1px solid #555555",
            color: "#cccccc",
            borderRadius: "10px",
            padding: "9px 14px",
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            background: "#555555",
            border: "none",
            color: "#f0f0f0",
            borderRadius: "10px",
            padding: "9px 16px",
            cursor: saving ? "default" : "pointer",
            opacity: saving ? 0.65 : 1,
            fontWeight: 600,
          }}
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
};
