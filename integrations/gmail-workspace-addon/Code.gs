const PRIVCLOUD_ORIGIN = "https://share.example.com";
const PRIVCLOUD_UPLOAD_URL = PRIVCLOUD_ORIGIN + "/upload?source=gmail-addon";
const PRIVCLOUD_GUIDE_URL = "https://share.example.com/install/gmail-workspace-addon/README.md";
const PRIVCLOUD_LOGO_URL = "https://share.example.com/install/assets/privcloud-gmail-logo-v1.png";

// Run once from the Apps Script editor before installing or updating the test
// deployment. Google asks for the scopes declared in appsscript.json.
function authorizePrivCloud() {
  console.info("PrivCloud : revenez dans Gmail après avoir installé le déploiement de test. / Return to Gmail after installing the test deployment.");
}

function text_(e, fr, en) {
  const locale = e && e.commonEventObject && e.commonEventObject.userLocale;
  return !locale || /^fr(?:[-_]|$)/i.test(locale) ? fr : en;
}

function homepage(e) {
  return buildPrivCloudCard_(e, false);
}

function composeAction(e) {
  return buildPrivCloudCard_(e, true);
}

function buildPrivCloudCard_(e, composing) {
  const section = CardService.newCardSection()
    .addWidget(CardService.newTextParagraph().setText(text_(e,
      "<b>1. Envoyez vos fichiers</b><br>Ouvrez PrivCloud dans un autre onglet, choisissez vos fichiers et terminez l'envoi.",
      "<b>1. Upload your files</b><br>Open PrivCloud in another tab, choose your files and finish the upload.")))
    .addWidget(CardService.newTextButton()
      .setText(text_(e, "Choisir mes fichiers dans PrivCloud", "Choose my files in PrivCloud"))
      .setOpenLink(CardService.newOpenLink().setUrl(PRIVCLOUD_UPLOAD_URL)))
    .addWidget(CardService.newTextParagraph().setText(text_(e,
      "<b>2. Copiez le lien de partage</b><br>À la fin de l'envoi, cliquez sur \"Copier le lien\", puis collez-le dans le champ ci-dessous sans la partie #key=... s'il y en a une. Cette clé de déchiffrement ne doit pas figurer dans le mail : transmettez-la par une messagerie chiffrée de bout en bout, comme Signal ou Nextcloud Talk. Votre destinataire l'ajoutera à la fin du lien pour ouvrir les fichiers.",
      "<b>2. Copy the share link</b><br>When the upload finishes, select Copy link, then paste it below without the #key=... part, if there is one. This decryption key should not appear in the email: send it through an end-to-end encrypted messenger, such as Signal or Nextcloud Talk. Your recipient adds it to the end of the link to open the files.")));

  if (composing) {
    section
      .addWidget(CardService.newTextParagraph().setText(text_(e,
        "<b>3. Revenez dans ce brouillon</b><br>Collez le lien ci-dessous, puis cliquez sur \"Insérer le lien dans le mail\".",
        "<b>3. Return to this draft</b><br>Paste the link below, then select Insert link into email.")))
      .addWidget(CardService.newTextInput()
        .setFieldName("shareLink")
        .setTitle(text_(e, "Lien de partage PrivCloud", "PrivCloud share link"))
        .setHint("https://share.example.com/s/..."))
      .addWidget(CardService.newTextButton()
        .setText(text_(e, "Insérer le lien dans le mail", "Insert link into email"))
        .setOnClickAction(CardService.newAction().setFunctionName("insertShareLink")));
  } else {
    section.addWidget(CardService.newTextParagraph().setText(text_(e,
      "<b>3. Insérez le lien dans votre mail</b><br>Ouvrez un nouveau message ou une réponse, puis choisissez l'icône PrivCloud dans la barre du brouillon. Vous pouvez aussi coller le lien directement dans le message.",
      "<b>3. Insert the link into your email</b><br>Start a new message or reply, then select the PrivCloud icon in the draft toolbar. You can also paste the link directly into the message.")));
  }
  section.addWidget(CardService.newTextParagraph().setText(text_(e,
    "Les fichiers sont choisis et chiffrés dans PrivCloud. Le module insère uniquement le lien que vous lui fournissez. Vous envoyez ensuite le mail vous-même.",
    "Files are selected and encrypted in PrivCloud. The add-on only inserts the link you provide. You send the email yourself.")));

  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader()
      .setTitle("PrivCloud")
      .setSubtitle(text_(e, "Partager des fichiers par mail", "Share files by email"))
      .setImageUrl(PRIVCLOUD_LOGO_URL))
    .addSection(section)
    .addSection(CardService.newCardSection().addWidget(
      CardService.newTextButton()
        .setText(text_(e, "Installation et aide", "Installation and help"))
        .setOpenLink(CardService.newOpenLink().setUrl(PRIVCLOUD_GUIDE_URL)),
    ))
    .build();
}

function notify_(message) {
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(message))
    .build();
}

// Apps Script V8 does not provide the browser URL constructor. Restrict the
// origin and recipient share route explicitly, and never fetch or log the link.
function validatedShareLink_(value) {
  if (typeof value !== "string" || value.length > 8192) return null;
  const link = value.trim();
  if (!link.startsWith(PRIVCLOUD_ORIGIN + "/s/")) return null;
  const route = link.slice(PRIVCLOUD_ORIGIN.length);
  return /^\/s\/(?:v2\.)?[A-Za-z0-9_-]+(?:\?[^#\s<>"'\\]*)?(?:#[^\s<>"'\\]*)?$/.test(route) ? link : null;
}

function escapeHtml_(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function insertShareLink(e) {
  const inputs = e && e.commonEventObject && e.commonEventObject.formInputs;
  const values = inputs && inputs.shareLink && inputs.shareLink.stringInputs;
  const link = validatedShareLink_(values && values.value && values.value[0]);
  if (!link) return notify_(text_(e,
    "Collez le lien complet obtenu après l'envoi dans PrivCloud (https://share.example.com/s/...).",
    "Paste the complete link provided after uploading in PrivCloud (https://share.example.com/s/...)."));

  try {
    const content = '<p><a href="' + escapeHtml_(link) + '">' + text_(e,
      "Télécharger les fichiers avec PrivCloud", "Download files with PrivCloud") + '</a></p>';
    return CardService.newUpdateDraftActionResponseBuilder()
      .setUpdateDraftBodyAction(CardService.newUpdateDraftBodyAction()
        .addUpdateContent(content, CardService.ContentType.MUTABLE_HTML)
        .setUpdateType(CardService.UpdateDraftBodyType.IN_PLACE_INSERT))
      .build();
  } catch (_) {
    return notify_(text_(e,
      "L'insertion n'a pas abouti. Collez le lien directement dans le corps de votre mail, puis envoyez-le normalement.",
      "The link could not be inserted. Paste it directly into your email body, then send the email normally."));
  }
}
