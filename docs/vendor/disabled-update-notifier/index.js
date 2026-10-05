// Documentation builds do not check npm for updates or maintain an HTTP cache.
// Docusaurus still performs its own Node version check after this interface.
export default function updateNotifier() {
  return Object.freeze({
    disabled: true,
    config: undefined,
    update: undefined,
  });
}
