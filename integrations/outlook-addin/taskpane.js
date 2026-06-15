Office.onReady(() => {
  document.getElementById("open").addEventListener("click", () => {
    window.open("https://share.example.com/upload?source=outlook", "_blank", "noopener");
  });
});
