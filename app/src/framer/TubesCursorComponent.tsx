import { useEffect, useRef } from "react";

// The third-party build does not ship types, so we fall back to `any`.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import TubesCursor from "threejs-components/build/cursors/tubes1.min.js";

export interface TubesCursorProps {
  tubes?: number;
  bloom?: boolean;
  bloomThreshold?: number;
  bloomStrength?: number;
  bloomRadius?: number;
  colors?: string[];
  lightsColors?: string[];
  lightsIntensity?: number;
  metalness?: number;
  roughness?: number;
  lerp?: number;
  noise?: number;
  sleepRadiusX?: number;
  sleepRadiusY?: number;
  sleepTimeScale1?: number;
  sleepTimeScale2?: number;
  backgroundColor?: string;
  className?: string;
  style?: React.CSSProperties;
}

const TubesCursorComponent: React.FC<TubesCursorProps> = ({
  tubes = 8,
  bloom = true,
  bloomThreshold = 0,
  bloomStrength = 1.5,
  bloomRadius = 0.5,
  colors = ["#f967fb", "#53bc28", "#6958d5"],
  lightsColors = ["#83f36e", "#fe8a2e", "#ff008a", "#60aed5"],
  lightsIntensity = 200,
  metalness = 1,
  roughness = 0.25,
  lerp = 0.5,
  noise = 0.05,
  sleepRadiusX = 300,
  sleepRadiusY = 150,
  sleepTimeScale1 = 1,
  sleepTimeScale2 = 2,
  backgroundColor = "#000000",
  className,
  style,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const appRef = useRef<any>(null);

  useEffect(() => {
    if (!canvasRef.current) return;

    canvasRef.current.style.background = backgroundColor;

    const options: any = {
      bloom: false,
      tubes: {
        count: tubes,
        colors,
        lights: {
          intensity: lightsIntensity,
          colors: lightsColors,
        },
        material: {
          metalness,
          roughness,
        },
        lerp,
        noise,
      },
      sleepRadiusX,
      sleepRadiusY,
      sleepTimeScale1,
      sleepTimeScale2,
    };

    if (bloom) {
      options.bloom = {
        threshold: bloomThreshold,
        strength: bloomStrength,
        radius: bloomRadius,
      };
    }

    appRef.current = TubesCursor(canvasRef.current, options);
    appRef.current?.renderer?.setClearColor?.(backgroundColor, 1);

    return () => {
      appRef.current?.dispose?.();
      appRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tubes, bloom]);

  useEffect(() => {
    if (!appRef.current?.bloomPass) return;
    appRef.current.bloomPass.threshold.value = bloomThreshold;
    appRef.current.bloomPass.strength.value = bloomStrength;
    appRef.current.bloomPass.radius.value = bloomRadius;
  }, [bloomThreshold, bloomStrength, bloomRadius]);

  useEffect(() => {
    if (!appRef.current?.tubes) return;
    appRef.current.tubes.setColors(colors);
  }, [colors]);

  useEffect(() => {
    if (!appRef.current?.tubes) return;
    appRef.current.tubes.setLightsColors(lightsColors);
    appRef.current.tubes.setLightsIntensity(lightsIntensity);
  }, [lightsColors, lightsIntensity]);

  useEffect(() => {
    if (!appRef.current?.tubes?.options) return;
    appRef.current.tubes.options.lerp = lerp;
    appRef.current.tubes.options.noise = noise;
  }, [lerp, noise]);

  useEffect(() => {
    if (!appRef.current?.options) return;
    appRef.current.options.sleepRadiusX = sleepRadiusX;
    appRef.current.options.sleepRadiusY = sleepRadiusY;
  }, [sleepRadiusX, sleepRadiusY]);

  useEffect(() => {
    if (!appRef.current?.options) return;
    appRef.current.options.sleepTimeScale1 = sleepTimeScale1;
    appRef.current.options.sleepTimeScale2 = sleepTimeScale2;
  }, [sleepTimeScale1, sleepTimeScale2]);

  useEffect(() => {
    if (!canvasRef.current) return;
    canvasRef.current.style.background = backgroundColor;
    appRef.current?.renderer?.setClearColor?.(backgroundColor, 1);
  }, [backgroundColor]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{
        width: "100%",
        height: "100%",
        display: "block",
        ...style,
      }}
    />
  );
};

export default TubesCursorComponent;

