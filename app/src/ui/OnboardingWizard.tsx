import React, { useMemo, useState } from "react";
import { useTrackerStore, Currency } from "../store/trackerStore";
import { useAuth } from "../hooks/useAuth";

type OnboardingWizardProps = {
  onComplete?: () => void;
};

const COUNTRY_DEFAULT_TAX: Record<string, number> = {
  Croatia: 24,
  Germany: 25,
  France: 30,
  USA: 22
};

export const OnboardingWizard: React.FC<OnboardingWizardProps> = ({ onComplete }) => {
  const { addTracker, syncTrackerToFirestore, trackers } = useTrackerStore();
  const { user } = useAuth();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [currency, setCurrency] = useState<Currency>("EUR");
  const [country, setCountry] = useState("Croatia");
  const [taxRate, setTaxRate] = useState<number>(COUNTRY_DEFAULT_TAX["Croatia"]);
  const [etherscanKey, setEtherscanKey] = useState("");

  const isFirstTracker = trackers.length === 0;

  const canNext = useMemo(() => {
    if (step === 0) return name.trim().length > 0;
    if (step === 1) return /^0x[a-fA-F0-9]{40}$/.test(walletAddress);
    if (step === 2) return currency === "EUR" || currency === "USD";
    if (step === 3) return taxRate >= 0 && taxRate <= 100;
    if (step === 4) return etherscanKey.trim().length > 0;
    return true;
  }, [step, name, walletAddress, currency, taxRate, etherscanKey]);

  const next = async () => {
    if (!canNext) return;
    if (step === 4) {
      // Save tracker and complete
      addTracker({
        walletAddress,
        currency,
        country,
        taxRate,
        etherscanKey,
        name: name.trim() || `Node ${walletAddress.slice(0, 6)}...`,
      });
      
      // Sync to Firestore if authenticated
      if (user) {
        const { trackers } = useTrackerStore.getState();
        const newTracker = trackers[trackers.length - 1];
        if (newTracker) {
          await syncTrackerToFirestore(user.uid, newTracker);
        }
      }
      
      onComplete?.();
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
    <section className="card" style={{ position: "relative" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
        <h1 style={{ margin: 0, fontSize: "1.5rem", fontWeight: 600 }}>
          {isFirstTracker ? "Set up your first Node Tracker" : "Set up your next Node Tracker"}
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
      <div className="steps">Step {step + 1} of 5</div>
      {step === 0 && (
        <div>
          <h2>Name</h2>
          <input
            className="input"
            placeholder="Node Tracker 1"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      )}
      {step === 1 && (
        <div>
          <h2>Wallet receiving staking rewards</h2>
          <input
            className="input"
            placeholder="0x..."
            value={walletAddress}
            onChange={(e) => setWalletAddress(e.target.value.trim())}
          />
        </div>
      )}
      {step === 2 && (
        <div>
          <h2>Currency preference</h2>
          <div className="row">
            <label><input type="radio" checked={currency === "EUR"} onChange={() => setCurrency("EUR")} /> Euro</label>
            <label><input type="radio" checked={currency === "USD"} onChange={() => setCurrency("USD")} /> Dollar</label>
          </div>
        </div>
      )}
      {step === 3 && (
        <div>
          <h2>Country and tax rate</h2>
          <div className="row">
            <select value={country} onChange={(e) => onChangeCountry(e.target.value)}>
              {Object.keys(COUNTRY_DEFAULT_TAX).map((c) => (
                <option key={c} value={c}>{c}</option>
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
            />
            <span>%</span>
          </div>
        </div>
      )}
      {step === 4 && (
        <div>
          <h2>Your Etherscan API key</h2>
          <p className="muted">Each user should bring their own Etherscan API key.</p>
          <input
            className="input"
            placeholder="ETHERSCAN_API_KEY"
            value={etherscanKey}
            onChange={(e) => setEtherscanKey(e.target.value)}
          />
        </div>
      )}
      <div className="actions">
        {step > 0 && <button onClick={back}>Back</button>}
        <button disabled={!canNext} onClick={next}>Next</button>
      </div>
    </section>
  );
};


