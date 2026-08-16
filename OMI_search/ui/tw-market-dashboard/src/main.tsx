import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { McpAppsBridge } from "./bridge";
import styles from "./styles.css";

const style = document.createElement("style");
style.textContent = styles;
document.head.append(style);

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(
  <React.StrictMode>
    <App bridge={new McpAppsBridge()} />
  </React.StrictMode>,
);
