import React from "react";

export const AuthShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	// Placeholder buttons; wire to Firebase or wallet connect later
	return (
		<div className="card" style={{ marginBottom: 16 }}>
			<h2>Sign in</h2>
			<p className="muted">Choose a method to continue.</p>
			<div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
				<button onClick={() => alert("Connect with Google (to be wired)")}>Google</button>
				<button onClick={() => alert("Connect with GitHub (to be wired)")}>GitHub</button>
				<button onClick={() => alert("Connect wallet (to be wired)")}>Connect Wallet</button>
			</div>
			<div style={{ marginTop: 16 }}>
				{children}
			</div>
		</div>
	);
};
