import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GonvexClient } from "../gonvex/_generated/client";
import { GonvexProvider } from "../gonvex/_generated/react";
import App from "./App";
import { TooltipProvider } from "./components/ui/tooltip";
import { withGonvexProject } from "./lib/gonvex-url";
import "./styles.css";

const gonvexBaseURL = import.meta.env.VITE_GONVEX_WS_URL ?? "wss://gonvex-unified-dev.whagons.com/ws";
const gonvexProjectID = import.meta.env.VITE_GONVEX_PROJECT_ID ?? "skills";

function devJWT() {
  const encode = (value: object) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ sub: "skills-vault", email: "skills@whagons.local" })}.vault`;
}

const gonvex = new GonvexClient(withGonvexProject(gonvexBaseURL, gonvexProjectID), {
  project: gonvexProjectID,
  token: devJWT(),
  tenant: gonvexProjectID,
  queryCache: false,
  errorReporting: false,
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GonvexProvider client={gonvex}>
      <TooltipProvider delayDuration={250}>
        <App />
      </TooltipProvider>
    </GonvexProvider>
  </StrictMode>,
);
