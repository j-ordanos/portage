// Applies a saved Light/Dark choice before first paint, so there is no flash. (An external file: the CSP forbids inline scripts.)
try {
  const t = localStorage.getItem("portage-theme");
  if (t === "light" || t === "dark")
    document.documentElement.setAttribute("data-theme", t);
} catch {
  // storage unavailable: follow the system theme
}
