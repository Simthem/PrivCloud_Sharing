const APP_URL = "https://share.example.com/upload?source=thunderbird";

browser.composeAction.onClicked.addListener(async () => {
  await browser.tabs.create({ url: APP_URL });
});

browser.runtime.onMessage.addListener(async (message) => {
  if (message?.type !== "privcloud.compose.attachments") return null;
  const [tab] = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!tab?.id) return { attachments: [] };
  const details = await browser.compose.getComposeDetails(tab.id);
  return {
    subject: details.subject || "",
    to: details.to || [],
    cc: details.cc || [],
    bcc: details.bcc || [],
    attachments: details.attachments || [],
  };
});
