let uploadActive = false;
let uploadEndedAt = 0;

const UPLOAD_COOLDOWN_MS = 5 * 60 * 1000;

export const setUploadActive = (active: boolean) => {
  uploadActive = active;
  if (!active) uploadEndedAt = Date.now();
};

export const isUploadActive = () => uploadActive;

export const isUploadCoolingDown = () =>
  Date.now() - uploadEndedAt < UPLOAD_COOLDOWN_MS;
