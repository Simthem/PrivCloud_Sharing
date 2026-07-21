---
id: upgrading
---

# Upgrading

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
