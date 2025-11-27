import React, { useMemo } from "react";
import TubesCursorComponent from "../framer/TubesCursorComponent";

interface LandingProps {
  onSignInClick: () => void;
}

export const Landing: React.FC<LandingProps> = ({ onSignInClick }) => {
  const tubeColors = useMemo(
    () => ["#f967fb", "#60aed5", "#8b5cf6"],
    []
  );

  const lightColors = useMemo(
    () => ["#83f36e", "#fe8a2e", "#ff008a", "#60aed5"],
    []
  );

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        background: "#1b1945",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 1,
          pointerEvents: "none",
        }}
      >
        <TubesCursorComponent
          tubes={10}
          colors={tubeColors}
          lightsColors={lightColors}
          bloom
          bloomStrength={1.4}
          bloomRadius={0.45}
          lerp={0.4}
          noise={0.08}
          className="landing-tubes-canvas"
        />
      </div>
      <div
        style={{
          position: "relative",
          zIndex: 2,
          textAlign: "center",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "24px",
          pointerEvents: "auto",
        }}
      >
        <h1
          style={{
            fontSize: "clamp(3rem, 8vw, 6rem)",
            fontWeight: 700,
            fontFamily: "Retronoid, ui-sans-serif, system-ui",
            color: "#ffffff",
            margin: 0,
            textShadow: "0 0 30px rgba(255, 255, 255, 0.3)",
            letterSpacing: "0.05em",
          }}
        >
          SOLOBEAM
        </h1>
        <p
          style={{
            fontSize: "clamp(1rem, 2vw, 1.25rem)",
            color: "#ffffff",
            margin: 0,
            fontWeight: 400,
            letterSpacing: "0.02em",
          }}
        >
          Your staking rewards, perfectly logged.
        </p>
        <button
          onClick={onSignInClick}
          style={{
            background: "#ffffff",
            border: "none",
            borderRadius: "12px",
            padding: "14px 32px",
            color: "#1b1945",
            fontSize: "1.1rem",
            fontWeight: 600,
            cursor: "pointer",
            transition: "all 0.3s ease",
            boxShadow: "0 4px 20px rgba(255, 255, 255, 0.2)",
            marginTop: "8px",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = "scale(1.05)";
            e.currentTarget.style.boxShadow = "0 6px 30px rgba(255, 255, 255, 0.3)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = "scale(1)";
            e.currentTarget.style.boxShadow = "0 4px 20px rgba(255, 255, 255, 0.2)";
          }}
        >
          Sign in
        </button>
      </div>
    </div>
  );
};
