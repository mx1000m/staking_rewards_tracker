import React, { useState, useRef, useEffect } from "react";
import { useAuth } from "../hooks/useAuth";

export const AuthShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const { user, loading, signInWithGoogle, signInWithGitHub, logout } = useAuth();
	const [error, setError] = useState<string | null>(null);
	const [signingIn, setSigningIn] = useState(false);
	const [userMenuVisible, setUserMenuVisible] = useState(false);
	const [userMenuAnimation, setUserMenuAnimation] = useState<"enter" | "exit">("exit");
	const [userCardHovered, setUserCardHovered] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);
	const menuAnimationTimeoutRef = useRef<number | null>(null);
	const USER_MENU_ANIMATION_DURATION = 450;

	const headerStroke = "linear-gradient(45deg, #3788fd, #01e1fd)";
	const panelGradient = "linear-gradient(45deg, #232055, #292967)";
	const accentBlue = "#24a7fd";
	const glowShadow = "0 0 8px rgba(1, 225, 253, 0.8), 0 0 20px rgba(1, 225, 253, 0.45)";

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

	const openUserMenu = () => {
		if (menuAnimationTimeoutRef.current) {
			window.clearTimeout(menuAnimationTimeoutRef.current);
			menuAnimationTimeoutRef.current = null;
		}
		setUserMenuVisible(true);
		setUserMenuAnimation("enter");
	};

	const closeUserMenu = () => {
		setUserMenuAnimation("exit");
		if (menuAnimationTimeoutRef.current) {
			window.clearTimeout(menuAnimationTimeoutRef.current);
		}
		menuAnimationTimeoutRef.current = window.setTimeout(() => {
			setUserMenuVisible(false);
			menuAnimationTimeoutRef.current = null;
		}, USER_MENU_ANIMATION_DURATION);
	};

	const toggleUserMenu = () => {
		if (userMenuVisible && userMenuAnimation === "enter") {
			closeUserMenu();
		} else {
			openUserMenu();
		}
	};

	// Close user menu when clicking outside
	useEffect(() => {
		if (!userMenuVisible) return;

		const handleClickOutside = (event: MouseEvent) => {
			if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
				closeUserMenu();
			}
		};

		document.addEventListener("mousedown", handleClickOutside);
		return () => {
			document.removeEventListener("mousedown", handleClickOutside);
		};
	}, [userMenuVisible]);

	useEffect(() => {
		return () => {
			if (menuAnimationTimeoutRef.current) {
				window.clearTimeout(menuAnimationTimeoutRef.current);
			}
		};
	}, []);

	if (loading) {
		return (
			<div className="card">
				<p>Loading...</p>
			</div>
		);
	}

	if (user) {
		// User is signed in, show header with user menu
		const userName = user.displayName || user.email?.split("@")[0] || "User";
		const userEmail = user.email || "";
		const userPhoto = user.photoURL || "";

		return (
			<>
				<header 
					className="app-header" 
					style={{ 
						display: "flex", 
						justifyContent: "space-between", 
						alignItems: "center", 
						padding: "16px 24px",
						background: "linear-gradient(45deg, #232055, #292967)",
						position: "relative",
					}}
				>
					{/* Bottom border only */}
					<div style={{
						position: "absolute",
						bottom: 0,
						left: 0,
						right: 0,
						height: "1px",
						background: "linear-gradient(90deg, #3788fd, #01e1fd)",
					}}></div>
					{/* Glow effect - positioned outside only */}
					<div style={{
						position: "absolute",
						bottom: "-1px",
						left: 0,
						right: 0,
						height: "1px",
						background: "linear-gradient(90deg, #3788fd, #01e1fd)",
						boxShadow: glowShadow,
						pointerEvents: "none",
					}}></div>
						<div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
						{/* Logo with gradient */}
						<div style={{ 
							fontSize: "2rem", 
							fontWeight: 700, 
							fontFamily: "Retronoid, ui-sans-serif, system-ui",
							background: "linear-gradient(45deg, #01e1fd, #3788fd)",
							WebkitBackgroundClip: "text",
							WebkitTextFillColor: "transparent",
							backgroundClip: "text",
						}}>Solobeam</div>
					</div>
					<div style={{ position: "relative" }} ref={menuRef}>
						<div
							style={{
								background: "linear-gradient(45deg, #3788fd, #01e1fd)",
								padding: "1px",
								borderRadius: "8px",
								display: "inline-block",
								transition: "transform 0.2s",
								transform: userCardHovered ? "scale(1.05)" : "scale(1)",
							}}
							onMouseEnter={() => setUserCardHovered(true)}
							onMouseLeave={() => setUserCardHovered(false)}
						>
							<div
								style={{
									display: "flex",
									alignItems: "center",
									gap: "12px",
									cursor: "pointer",
									padding: "4px 8px",
									borderRadius: "7px",
									background: "linear-gradient(45deg, #232055, #292967)",
									transition: "all 0.2s",
								}}
								onClick={toggleUserMenu}
								onMouseEnter={(e) => {
									e.currentTarget.style.background = "linear-gradient(45deg, #2a2a5f, #323277)";
								}}
								onMouseLeave={(e) => {
									e.currentTarget.style.background = "linear-gradient(45deg, #232055, #292967)";
								}}
							>
								<span style={{ fontSize: "0.9rem", fontWeight: 500, color: "#24a7fd" }}>
									{userName}
								</span>
								{userPhoto ? (
									<img
										src={userPhoto}
										alt={userName}
										style={{
											width: "32px",
											height: "32px",
											borderRadius: "50%",
											objectFit: "cover",
										}}
									/>
								) : (
									<div
										style={{
											width: "32px",
											height: "32px",
											borderRadius: "50%",
											background: "#6b6bff",
											display: "flex",
											alignItems: "center",
											justifyContent: "center",
											color: "white",
											fontWeight: 600,
											fontSize: "0.9rem",
										}}
									>
										{userName.charAt(0).toUpperCase()}
									</div>
								)}
							</div>
						</div>

						{/* User Menu Popup */}
						{userMenuVisible && (
							<div
								className={`user-menu-popup ${userMenuAnimation === "enter" ? "user-menu-enter" : "user-menu-exit"}`}
								style={{
									position: "absolute",
									top: "calc(100% + 8px)",
									right: 0,
									background: "linear-gradient(45deg, #3788fd, #01e1fd)",
									borderRadius: "14px",
									padding: "1px",
									minWidth: "280px",
									boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
									zIndex: 1000,
								}}
							>
								<div style={{ background: "linear-gradient(45deg, #232055, #292967)", borderRadius: "13px", padding: "20px", position: "relative" }}>
								<button
									onClick={closeUserMenu}
									style={{
										position: "absolute",
										top: "10px",
										right: "10px",
										background: "transparent",
										border: "none",
										color: "#9aa0b4",
										fontSize: "22px",
										cursor: "pointer",
										padding: 0,
										width: "28px",
										height: "28px",
										display: "flex",
										alignItems: "center",
										justifyContent: "center",
										transition: "color 0.2s, transform 0.2s",
									}}
									onMouseEnter={(e) => {
										e.currentTarget.style.color = "#e8e8f0";
										e.currentTarget.style.transform = "scale(1.05)";
									}}
									onMouseLeave={(e) => {
										e.currentTarget.style.color = "#9aa0b4";
										e.currentTarget.style.transform = "scale(1)";
									}}
								>
									×
								</button>
								<div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px" }}>
									<div style={{ display: "flex", alignItems: "center", gap: "12px", flex: 1 }}>
										{userPhoto ? (
											<img
												src={userPhoto}
												alt={userName}
											style={{
												width: "48px",
												height: "48px",
												borderRadius: "50%",
												objectFit: "cover",
											}}
											/>
										) : (
											<div
												style={{
													width: "48px",
													height: "48px",
													borderRadius: "50%",
													background: "#6b6bff",
													display: "flex",
													alignItems: "center",
													justifyContent: "center",
													color: "white",
													fontWeight: 600,
													fontSize: "1.2rem",
												}}
											>
												{userName.charAt(0).toUpperCase()}
											</div>
										)}
										<div>
											<p style={{ margin: 0, fontSize: "1rem", fontWeight: 600, color: "#e8e8f0" }}>
												GM {userName}!
											</p>
											{userEmail && (
												<p style={{ margin: "4px 0 0 0", fontSize: "0.85rem", color: "#9aa0b4" }}>
													{userEmail}
												</p>
											)}
										</div>
									</div>
								</div>
								<button
									onClick={() => {
										logout();
										closeUserMenu();
									}}
									style={{
										width: "100%",
										background: "#110e3f",
										color: "#24a7fd",
										padding: "10px 16px",
										border: "none",
										borderRadius: "10px",
										cursor: "pointer",
										fontWeight: 500,
										transition: "all 0.2s",
										transform: "scale(1)",
									}}
									onMouseEnter={(e) => {
										e.currentTarget.style.background = "#1a1648";
										e.currentTarget.style.transform = "scale(1.05)";
									}}
									onMouseLeave={(e) => {
										e.currentTarget.style.background = "#110e3f";
										e.currentTarget.style.transform = "scale(1)";
									}}
								>
									Sign out
								</button>
								</div>
							</div>
						)}
					</div>
				</header>
				<main className="app-main" style={{ placeItems: "stretch" }}>
					{children}
				</main>
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
