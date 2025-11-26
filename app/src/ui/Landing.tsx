import React, { useState, useEffect, useRef } from "react";

interface LandingProps {
  onSignInClick: () => void;
}

export const Landing: React.FC<LandingProps> = ({ onSignInClick }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef = useRef<number>();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Set canvas size
    const resizeCanvas = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);

    // Mouse position
    const mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const handleMouseMove = (e: MouseEvent) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
    };
    window.addEventListener("mousemove", handleMouseMove);

    // Tube/particle system
    interface Tube {
      x: number;
      y: number;
      vx: number;
      vy: number;
      radius: number;
      hue: number;
      baseHue: number;
    }

    const tubes: Tube[] = [];
    const tubeCount = 80;

    // Initialize tubes with varied hues (pink, cyan, green, blue, purple)
    const baseHues = [320, 180, 150, 200, 280];
    for (let i = 0; i < tubeCount; i++) {
      const baseHue = baseHues[Math.floor(Math.random() * baseHues.length)];
      tubes.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        radius: Math.random() * 1.5 + 0.5,
        hue: baseHue + (Math.random() - 0.5) * 20,
        baseHue: baseHue,
      });
    }

    let time = 0;

    // Animation loop
    const animate = () => {
      time += 0.01;
      ctx.fillStyle = "#1b1945";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Update and draw tubes
      tubes.forEach((tube, i) => {
        // Move towards mouse with stronger attraction
        const dx = mouse.x - tube.x;
        const dy = mouse.y - tube.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (distance > 0 && distance < 500) {
          const force = Math.min(0.001 * (500 - distance) / 500, 0.002);
          tube.vx += (dx / distance) * force;
          tube.vy += (dy / distance) * force;
        }

        // Add some organic movement
        tube.vx += Math.sin(time + i) * 0.01;
        tube.vy += Math.cos(time + i * 0.5) * 0.01;

        // Apply friction
        tube.vx *= 0.97;
        tube.vy *= 0.97;

        // Update position
        tube.x += tube.vx;
        tube.y += tube.vy;

        // Wrap around edges
        if (tube.x < -50) tube.x = canvas.width + 50;
        if (tube.x > canvas.width + 50) tube.x = -50;
        if (tube.y < -50) tube.y = canvas.height + 50;
        if (tube.y > canvas.height + 50) tube.y = -50;

        // Animate hue
        tube.hue = tube.baseHue + Math.sin(time * 0.5 + i * 0.1) * 30;

        // Draw tube with glow
        const gradient = ctx.createRadialGradient(tube.x, tube.y, 0, tube.x, tube.y, tube.radius * 30);
        gradient.addColorStop(0, `hsla(${tube.hue}, 80%, 65%, 1)`);
        gradient.addColorStop(0.3, `hsla(${tube.hue}, 80%, 60%, 0.6)`);
        gradient.addColorStop(0.6, `hsla(${tube.hue}, 70%, 55%, 0.3)`);
        gradient.addColorStop(1, `hsla(${tube.hue}, 70%, 50%, 0)`);
        
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(tube.x, tube.y, tube.radius * 30, 0, Math.PI * 2);
        ctx.fill();

        // Draw connections between nearby tubes
        tubes.slice(i + 1).forEach((otherTube) => {
          const dx = tube.x - otherTube.x;
          const dy = tube.y - otherTube.y;
          const distance = Math.sqrt(dx * dx + dy * dy);

          if (distance < 200) {
            const opacity = (1 - distance / 200) * 0.4;
            const midHue = (tube.hue + otherTube.hue) / 2;
            ctx.strokeStyle = `hsla(${midHue}, 70%, 60%, ${opacity})`;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(tube.x, tube.y);
            ctx.lineTo(otherTube.x, otherTube.y);
            ctx.stroke();
          }
        });
      });

      animationFrameRef.current = requestAnimationFrame(animate);
    };

    animate();

    return () => {
      window.removeEventListener("resize", resizeCanvas);
      window.removeEventListener("mousemove", handleMouseMove);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

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
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "relative",
          zIndex: 10,
          textAlign: "center",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "24px",
        }}
      >
        <h1
          style={{
            fontSize: "clamp(3rem, 8vw, 6rem)",
            fontWeight: 700,
            fontFamily: "Retronoid, ui-sans-serif, system-ui",
            background: "linear-gradient(45deg, #01e1fd, #3788fd)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
            margin: 0,
            textShadow: "0 0 30px rgba(1, 225, 253, 0.5)",
            letterSpacing: "0.05em",
          }}
        >
          SOLOBEAM
        </h1>
        <p
          style={{
            fontSize: "clamp(1rem, 2vw, 1.25rem)",
            color: "#e8e8f0",
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
            background: "linear-gradient(45deg, #01e1fd, #3788fd)",
            border: "none",
            borderRadius: "12px",
            padding: "14px 32px",
            color: "#ffffff",
            fontSize: "1.1rem",
            fontWeight: 600,
            cursor: "pointer",
            transition: "all 0.3s ease",
            boxShadow: "0 4px 20px rgba(1, 225, 253, 0.4)",
            marginTop: "8px",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = "scale(1.05)";
            e.currentTarget.style.boxShadow = "0 6px 30px rgba(1, 225, 253, 0.6)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = "scale(1)";
            e.currentTarget.style.boxShadow = "0 4px 20px rgba(1, 225, 253, 0.4)";
          }}
        >
          Sign in
        </button>
      </div>
    </div>
  );
};

