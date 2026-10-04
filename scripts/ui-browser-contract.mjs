// Shared diagnostic labels contain no browser expressions, URLs or credentials.
export const UI_BROWSER_STAGES = Object.freeze([
  "browser_startup", "browser_connect", "browser_setup", "dashboard_navigation", "dashboard_initial", "dashboard_idle",
  "clients_navigation", "clients_details", "dashboard_return", "dashboard_headings", "locale_navigation", "locale_details",
  "mobile_layout", "browser_close",
]);
export const UI_BROWSER_NAVIGATION_STATES = Object.freeze([
  "frame_pending", "location_pending", "document_pending", "locale_pending", "initialization_pending", "navigation_busy", "frame_changed", "context_changed", "deadline_exhausted",
]);
