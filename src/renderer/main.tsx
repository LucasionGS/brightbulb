import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initStore } from "./lib/store";
import "./styles/app.scss";

void initStore();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
