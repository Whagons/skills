import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BackendProvider } from "@backend";
import App from "./App";
import { TooltipProvider } from "./components/ui/tooltip";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BackendProvider>
      <TooltipProvider delayDuration={250}>
        <App />
      </TooltipProvider>
    </BackendProvider>
  </StrictMode>,
);
