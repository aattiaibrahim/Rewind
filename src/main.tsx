import { getCurrentWindow } from "@tauri-apps/api/window";
import React from "react";
import ReactDOM from "react-dom/client";
import App, { useEscapeToHide } from "./App";
import "./App.css";
import { Flyout } from "./Flyout";

function FlyoutRoot() {
  useEscapeToHide();
  return <Flyout />;
}

async function start() {
  // In a plain browser during development, use fake sample data.
  if (import.meta.env.DEV) (await import("./devMock")).installDevMock();
  const isFlyout = getCurrentWindow().label === "flyout";
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>{isFlyout ? <FlyoutRoot /> : <App />}</React.StrictMode>,
  );
}

start();
