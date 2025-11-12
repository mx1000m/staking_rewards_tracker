import React, { useState } from "react";
import { useAuth } from "../hooks/useAuth";

export const AuthShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const { user, loading, signInWithGoogle, signInWithGitHub, logout } = useAuth();
	const [error, setError] = useState<string | null>(null);
	const [signingIn, setSigningIn] = useState(false);

	const handleGoogleSignIn = async () => {
		setSigningIn(true);
		setError(null);
		
		// Safety timeout: reset state after 5 seconds max (in case Firebase is slow to detect popup closure)
		const timeout = setTimeout(() => {
			setSigningIn(false);
		}, 5000);
		
		try {
			await signInWithGoogle();
			clearTimeout(timeout);
			setSigningIn(false);
		} catch (err: any) {
			clearTimeout(timeout);
			// Don't show error if user closed the popup
			if (err.code === "auth/popup-closed-by-user") {
				// User closed popup, reset state immediately
				setSigningIn(false);
				return;
			}
			setError(err.message || "Failed to sign in with Google");
			setSigningIn(false);
		}
	};

	const handleGitHubSignIn = async () => {
		setSigningIn(true);
		setError(null);
		
		// Safety timeout: reset state after 5 seconds max (in case Firebase is slow to detect popup closure)
		const timeout = setTimeout(() => {
			setSigningIn(false);
		}, 5000);
		
		try {
			await signInWithGitHub();
			clearTimeout(timeout);
			setSigningIn(false);
		} catch (err: any) {
			clearTimeout(timeout);
			// Don't show error if user closed the popup
			if (err.code === "auth/popup-closed-by-user") {
				// User closed popup, reset state immediately
				setSigningIn(false);
				return;
			}
			setError(err.message || "Failed to sign in with GitHub");
			setSigningIn(false);
		}
	};

	const handleWalletConnect = () => {
		// TODO: Implement wallet connect
		alert("Wallet connect (to be wired)");
	};

	if (loading) {
		return (
			<div className="card">
				<p>Loading...</p>
			</div>
		);
	}

	if (user) {
		// User is signed in, show the wizard
		return (
			<>
				<div className="card" style={{ marginBottom: 16, width: "100%", maxWidth: "1400px" }}>
					<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
						<div>
							<p style={{ margin: 0, fontSize: "0.9rem", color: "#9aa0b4" }}>Signed in as</p>
							<p style={{ margin: 0, fontWeight: 600 }}>{user.displayName || user.email}</p>
						</div>
						<button onClick={logout} style={{ background: "#2a2a44" }}>Sign out</button>
					</div>
				</div>
				{children}
			</>
		);
	}

	// User is not signed in, show sign-in options only
	return (
		<div className="card">
			<h2>Sign in</h2>
			<p className="muted">Choose a method to continue.</p>
			{error && (
				<div style={{ padding: "12px", background: "#2a1a1a", border: "1px solid #ff4444", borderRadius: "8px", marginBottom: "16px", color: "#ff8888" }}>
					{error}
				</div>
			)}
			<div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
				<button onClick={handleGoogleSignIn} disabled={signingIn}>
					{signingIn ? "Signing in..." : "Google"}
				</button>
				<button onClick={handleGitHubSignIn} disabled={signingIn}>
					{signingIn ? "Signing in..." : "GitHub"}
				</button>
				<button onClick={handleWalletConnect} disabled={signingIn}>
					Connect Wallet
				</button>
			</div>
		</div>
	);
};
