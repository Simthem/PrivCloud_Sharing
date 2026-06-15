const BUTTON_ID = "privcloud-gmail-compose-action";

function injectButton() {
  if (document.getElementById(BUTTON_ID)) return;
  const toolbar = document.querySelector('[role="toolbar"]');
  if (!toolbar) return;

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
    "font:500 12px Arial,sans-serif",
    "padding:5px 9px",
    "cursor:pointer",
  ].join(";");
  button.addEventListener("click", () => {
    chrome.runtime.sendMessage({
      type: "privcloud.open",
      path: "/upload?source=gmail",
      origin: window.location.origin,
    });
  });
  toolbar.appendChild(button);
}

new MutationObserver(injectButton).observe(document.documentElement, {
  childList: true,
  subtree: true,
});
injectButton();
