const PRIVCLOUD_UPLOAD_URL = "https://share.example.com/upload?source=gmail-addon";

function homepage() {
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle("PrivCloud"))
    .addSection(
      CardService.newCardSection().addWidget(
        CardService.newTextButton()
          .setText("Ouvrir PrivCloud")
          .setOpenLink(CardService.newOpenLink().setUrl(PRIVCLOUD_UPLOAD_URL)),
      ),
    )
    .build();
}

function composeAction() {
  return homepage();
}
