import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GonvexClient } from "../gonvex/_generated/client";
import { GonvexProvider } from "../gonvex/_generated/react";
import App from "./App";
import "../node_modules/@heroui/styles/dist/heroui.min.css";
import "./styles.css";

const gonvexBaseURL = import.meta.env.VITE_GONVEX_WS_URL ?? "ws://localhost:8080/ws";
const gonvexProjectID = import.meta.env.VITE_GONVEX_PROJECT_ID ?? "skills";
const gonvexURL = new URL(gonvexBaseURL);
gonvexURL.searchParams.set("project", gonvexProjectID);

function devJWT() {
  const encode = (value: object) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ sub: "skills-vault", email: "skills@whagons.local" })}.vault`;
}

const gonvex = new GonvexClient(gonvexURL.toString(), {
  token: devJWT(),
  tenant: gonvexProjectID,
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GonvexProvider client={gonvex}>
      <App />
    </GonvexProvider>
  </StrictMode>,
);
