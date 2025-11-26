import React, { useState, useEffect, useRef } from "react";
import * as THREE from "three";

interface LandingProps {
  onSignInClick: () => void;
}

export const Landing: React.FC<LandingProps> = ({ onSignInClick }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    tubes: THREE.Mesh[];
    mouse: THREE.Vector2;
    targetMouse: THREE.Vector2;
    points: THREE.Vector3[];
  } | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    const width = window.innerWidth;
    const height = window.innerHeight;

    // Scene setup
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1b1945);

    const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
    camera.position.z = 5;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    // Mouse tracking
    const mouse = new THREE.Vector2();
    const targetMouse = new THREE.Vector2();
    const points: THREE.Vector3[] = [];
    const maxPoints = 30;

    // Colors for tubes (pink, cyan, green, blue, purple)
    const colors = [
      new THREE.Color(0xff00ff), // Pink
      new THREE.Color(0x00ffff), // Cyan
      new THREE.Color(0x00ff88), // Green
      new THREE.Color(0x0088ff), // Blue
      new THREE.Color(0x8800ff), // Purple
    ];

    const tubes: THREE.Mesh[] = [];
    const tubeCount = 5;

    // Create tubes
    for (let i = 0; i < tubeCount; i++) {
      const geometry = new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3([
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(0, 0, 0),
        ]),
        64,
        0.03 + i * 0.015,
        16,
        false
      );

      const material = new THREE.MeshStandardMaterial({
        color: colors[i % colors.length],
        emissive: colors[i % colors.length],
        emissiveIntensity: 1.5,
        metalness: 0.1,
        roughness: 0.1,
        transparent: true,
        opacity: 0.9,
      });

      const tube = new THREE.Mesh(geometry, material);
      scene.add(tube);
      tubes.push(tube);
    }

    // Add lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    const lights = [
      new THREE.PointLight(colors[0], 1, 10),
      new THREE.PointLight(colors[1], 1, 10),
      new THREE.PointLight(colors[2], 1, 10),
      new THREE.PointLight(colors[3], 1, 10),
    ];

    lights.forEach((light, i) => {
      light.position.set(
        (i - 1.5) * 2,
        (i % 2) * 2 - 1,
        2
      );
      scene.add(light);
    });

    // Mouse move handler
    const handleMouseMove = (e: MouseEvent) => {
      targetMouse.x = (e.clientX / width) * 2 - 1;
      targetMouse.y = -(e.clientY / height) * 2 + 1;
    };

    window.addEventListener("mousemove", handleMouseMove);

    // Animation
    const lerpFactor = 0.15;
    let animationFrameId: number;

    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);

      // Smooth mouse tracking
      mouse.lerp(targetMouse, lerpFactor);

      // Convert mouse position to 3D space
      const vector = new THREE.Vector3(mouse.x * 3, mouse.y * 3, 0);

      // Add point to trail
      points.push(vector.clone());
      if (points.length > maxPoints) {
        points.shift();
      }

      // Update tubes
      tubes.forEach((tube, tubeIndex) => {
        if (points.length < 3) {
          // Initialize with current position
          const initPoints = [
            vector.clone(),
            vector.clone(),
            vector.clone(),
          ];
          const curve = new THREE.CatmullRomCurve3(initPoints);
          const newGeometry = new THREE.TubeGeometry(
            curve,
            64,
            0.03 + tubeIndex * 0.015,
            16,
            false
          );
          tube.geometry.dispose();
          tube.geometry = newGeometry;
          return;
        }

        // Create curve with offset for each tube
        const offset = (tubeIndex - tubeCount / 2) * 0.15;
        const time = Date.now() * 0.001;
        const curvePoints = points.map((p, i) => {
          const progress = i / points.length;
          const offsetVec = new THREE.Vector3(
            Math.sin(i * 0.15 + tubeIndex + time) * offset * (1 - progress * 0.5),
            Math.cos(i * 0.15 + tubeIndex + time) * offset * (1 - progress * 0.5),
            Math.sin(i * 0.08 + tubeIndex * 0.5 + time) * 0.3 * (1 - progress)
          );
          return p.clone().add(offsetVec);
        });

        // Ensure we have enough points
        while (curvePoints.length < 3) {
          curvePoints.push(curvePoints[curvePoints.length - 1].clone());
        }

        const curve = new THREE.CatmullRomCurve3(curvePoints);
        const newGeometry = new THREE.TubeGeometry(
          curve,
          64,
          0.03 + tubeIndex * 0.015,
          16,
          false
        );

        // Update geometry
        tube.geometry.dispose();
        tube.geometry = newGeometry;

        // Update material color with slight variation
        const colorIndex = (tubeIndex + Math.floor(time * 0.3)) % colors.length;
        const nextColorIndex = (colorIndex + 1) % colors.length;
        const color = colors[colorIndex].clone().lerp(colors[nextColorIndex], (time * 0.3) % 1);
        
        (tube.material as THREE.MeshStandardMaterial).color = color;
        (tube.material as THREE.MeshStandardMaterial).emissive = color;
        (tube.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.5 + Math.sin(time + tubeIndex) * 0.3;
      });

      // Update light positions
      lights.forEach((light, i) => {
        const time = Date.now() * 0.001;
        light.position.x = Math.sin(time + i) * 2;
        light.position.y = Math.cos(time * 0.7 + i) * 2;
        light.position.z = 2 + Math.sin(time * 0.5 + i) * 0.5;
      });

      renderer.render(scene, camera);
    };

    // Handle resize
    const handleResize = () => {
      const newWidth = window.innerWidth;
      const newHeight = window.innerHeight;

      camera.aspect = newWidth / newHeight;
      camera.updateProjectionMatrix();

      renderer.setSize(newWidth, newHeight);
    };

    window.addEventListener("resize", handleResize);

    // Store refs for cleanup
    sceneRef.current = {
      scene,
      camera,
      renderer,
      tubes,
      mouse,
      targetMouse,
      points,
    };

    animate();

    // Cleanup
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("resize", handleResize);
      cancelAnimationFrame(animationFrameId);

      // Dispose of geometries and materials
      tubes.forEach((tube) => {
        tube.geometry.dispose();
        (tube.material as THREE.Material).dispose();
        scene.remove(tube);
      });

      lights.forEach((light) => {
        scene.remove(light);
      });

      scene.remove(ambientLight);
      renderer.dispose();
      container.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div
      ref={containerRef}
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
      <div
        style={{
          position: "relative",
          zIndex: 10,
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
