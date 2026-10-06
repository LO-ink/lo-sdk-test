import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "@lo-ink/ui/styles.css";
import "./style.css";
createRoot(document.getElementById("root")!).render(<App />);
