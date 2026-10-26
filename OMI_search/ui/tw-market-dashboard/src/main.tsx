import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { WorkspaceApp } from "./WorkspaceApp";
import { McpAppsBridge } from "./bridge";
import styles from "./styles.css";

const style = document.createElement("style");
style.textContent = styles;
document.head.append(style);

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(
  <React.StrictMode>
    {document.documentElement.dataset.omiWorkspace === "true"
      ? <WorkspaceApp bridge={new McpAppsBridge()} />
      : <App bridge={new McpAppsBridge()} />}
  </React.StrictMode>,
);
