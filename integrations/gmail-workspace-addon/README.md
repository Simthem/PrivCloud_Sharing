# PrivCloud Gmail add-on

This Apps Script add-on opens the instance's upload page and inserts a supplied
share link at the cursor of an active Gmail draft. It does not read messages,
inspect draft metadata, upload files or send mail. The user sends the draft.

1. Run the integration packager with your HTTPS instance URL:

   ```sh
   npm run build:integrations -- --base-url https://files.example.org
   ```

2. Extract the Google Workspace add-on archive from `integrations/dist/` and copy
   `Code.gs` and `appsscript.json` into an Apps Script project.
3. Review the instance origin, logo URL and allowed link prefix. In the editor,
   run `authorizePrivCloud` once and grant the declared add-on and compose scopes.
4. Install a test deployment, open Gmail and select PrivCloud. For insertion,
   open a draft and select the PrivCloud compose action.

Instructions follow the Gmail interface language, with French and English text.
Only valid `/s/` share links from the configured origin are accepted. The link is
escaped before insertion and is never fetched or logged by the add-on.

Keep an E2E key fragment out of email when recipients should receive the key
through a separate encrypted channel. If a full key-bearing link is pasted,
the add-on preserves it in the draft. Anyone receiving that full link can use
its key. A deployment test in the operator's Google account is still required
before distributing the add-on to users.
