export { PromptView } from "./node.mjs";

// The host extension owns the node's single DOM widget and loads this stylesheet
// once alongside its own styles.
export const promptStylesheetUrl = new URL("./style.css", import.meta.url).href;
