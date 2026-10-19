---
id: upgrading
---

# Upgrading

## Version 1.25.3: contractor access and account passkeys

Back up the SQLite database and stored files before applying
`20261019120000_add_external_access_and_passkeys`. Run the normal migrations
before starting the updated backend. Existing shares, files and Team requests
are retained. The new audit records deliberately survive Team deletion until
their retention ends or an authorized evidence-vault erasure is confirmed.

`TEAM_MAX_EXTERNAL_SEATS=0` leaves contractor capacity unrestricted. Set a
positive integer for an instance-specific limit. Preview page size, page count,
access duration and invitation lifetime remain bounded.

Frontend builds now generate decoder and evidence-verification assets. Build
from the repository root layout and retain the required local vendor archives,
`verification/contractor`, and scripts when preparing a source distribution.

The application no longer stores an offline page or static-asset cache in its
service worker. Existing caches are removed when the updated worker activates.
Decrypted preview streams remain temporary and are not saved in Cache Storage.

The Docker entrypoint loads the backend proxy bootstrap automatically. Remove
old container-level `NODE_OPTIONS` arguments that require
`node_modules/global-agent/bootstrap`: global-agent 4 no longer ships that file.
Rebuild or pull the updated image, then recreate the container.

### Upgrade to a new version

As PrivCloud_Sharing is in an early stage, see the release notes for breaking changes before upgrading.

#### Docker

```bash
docker compose pull
docker compose up -d
```
### Portainer

1. In your container page, click on Recreate.
2. Check the Re-Pull image toggle.
3. Click on Recreate.

#### Stand-alone

1. Stop the running app

   ```bash
   pm2 stop privcloud-sharing-backend privcloud-sharing-frontend
   ```

2. Repeat the steps from the [installation guide](./installation#stand-alone-installation) except the `git clone` step.

   ```bash
   cd PrivCloud_Sharing

   # Checkout the latest version
   git fetch --tags && git checkout $(git describe --tags `git rev-list --tags --max-count=1`)

   # Start the backend
   cd backend
   npm install
   npm run build
   pm2 restart privcloud-sharing-backend

   # Start the frontend
   cd ../frontend
   npm install
   npm run build
   pm2 restart privcloud-sharing-frontend
   ```

Environment variables are not refreshed by a regular `pm2 restart`. If their values changed, restart both processes with:

```bash
pm2 restart privcloud-sharing-backend privcloud-sharing-frontend --update-env
```
