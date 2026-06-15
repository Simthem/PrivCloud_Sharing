document.getElementById("open").addEventListener("click", async () => {
  await browser.tabs.create({
    url: "https://share.example.com/upload?source=thunderbird",
  });
  window.close();
});
