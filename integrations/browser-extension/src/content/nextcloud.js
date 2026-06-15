const BUTTON_ID = "privcloud-nextcloud-action";

function injectButton() {
  if (document.getElementById(BUTTON_ID)) return;
  const header = document.querySelector("#controls, .files-controls, header");
  if (!header) return;

  const button = document.createElement("button");
  button.id = BUTTON_ID;
  button.type = "button";
  button.textContent = "PrivCloud";
  button.style.cssText = [
    "margin-left:8px",
    "border:1px solid #2f7ed8",
    "background:#1c7ed6",
    "color:white",
    "border-radius:4px",
    "font:500 13px sans-serif",
    "padding:6px 10px",
    "cursor:pointer",
  ].join(";");
  button.addEventListener("click", () => {
    chrome.runtime.sendMessage({
      type: "privcloud.open",
      path: `/upload?source=nextcloud&return=${encodeURIComponent(window.location.href)}`,
      origin: window.location.origin,
    });
  });
  header.appendChild(button);
}

new MutationObserver(injectButton).observe(document.documentElement, {
  childList: true,
  subtree: true,
});
injectButton();
