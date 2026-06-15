const statusEl = document.getElementById("status");
const openButton = document.getElementById("open");

chrome.runtime.sendMessage(
  {
    type: "privcloud.companion.health",
    origin: "chrome-extension://popup",
    payload: {},
  },
  (response) => {
    if (response?.ok) {
      statusEl.textContent = `Companion ready (${response.result.version})`;
      return;
    }
    statusEl.textContent = "Companion non détecté";
  },
);

openButton.addEventListener("click", () => {
  chrome.runtime.sendMessage({
    type: "privcloud.open",
    path: "/upload?source=extension",
  });
});
