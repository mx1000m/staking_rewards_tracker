import React, { useMemo, useState } from "react";
import { useTrackerStore, Currency } from "../store/trackerStore";

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
  const { addTracker, trackers } = useTrackerStore();
  const [step, setStep] = useState(0);
  const [name, setName] = useState(`Node Tracker ${trackers.length + 1}`);
  const [walletAddress, setWalletAddress] = useState("");
  const [currency, setCurrency] = useState<Currency>("EUR");
  const [country, setCountry] = useState("Croatia");
  const [taxRate, setTaxRate] = useState<number>(COUNTRY_DEFAULT_TAX["Croatia"]);
  const [etherscanKey, setEtherscanKey] = useState("");

  const canNext = useMemo(() => {
    if (step === 0) return name.trim().length > 0;
    if (step === 1) return /^0x[a-fA-F0-9]{40}$/.test(walletAddress);
    if (step === 2) return currency === "EUR" || currency === "USD";
    if (step === 3) return taxRate >= 0 && taxRate <= 100;
    if (step === 4) return etherscanKey.trim().length > 0;
    return true;
  }, [step, name, walletAddress, currency, taxRate, etherscanKey]);

  const next = () => {
    if (!canNext) return;
    if (step === 4) {
      // Save tracker and complete
      addTracker({
        name: name.trim(),
        walletAddress,
        currency,
        country,
        taxRate,
        etherscanKey,
      });
      onComplete?.();
    } else {
      setStep((s) => s + 1);
    }
  };
  const back = () => setStep((s) => Math.max(0, s - 1));

  const onChangeCountry = (val: string) => {
    setCountry(val);
    const def = COUNTRY_DEFAULT_TAX[val];
    if (typeof def === "number") setTaxRate(def);
  };


  return (
    <section className="card">
      <h1 style={{ margin: "0 0 8px 0", fontSize: "1.5rem", fontWeight: 600 }}>Set up your first Node Tracker</h1>
      <div className="steps">Step {step + 1} of 5</div>
      {step === 0 && (
        <div>
          <h2>Node Tracker Name</h2>
          <p className="muted" style={{ marginBottom: "12px" }}>Give your node tracker a name to easily identify it.</p>
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
      {step === 2 && (
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
      {step === 3 && (
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
        <button disabled={!canNext} onClick={next}>{step === 4 ? "Finish" : "Next"}</button>
      </div>
    </section>
  );
};


