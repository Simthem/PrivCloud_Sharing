// This worker receives deadlines only. File data and credentials stay in their
// existing contexts. One timer serves all pending upload control deadlines.
var deadlines = new Map();
var timer = null;

function arm() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (deadlines.size === 0) return;
  var earliest = Math.min.apply(null, Array.from(deadlines.values()));
  timer = setTimeout(tick, Math.max(0, earliest - Date.now()));
}

function tick() {
  timer = null;
  var now = Date.now();
  deadlines.forEach(function (deadline, id) {
    if (deadline <= now) {
      deadlines.delete(id);
      self.postMessage({ type: "elapsed", id: id });
    }
  });
  arm();
}

self.onmessage = function (event) {
  // The dedicated worker's implicit port has no Window source or origin URL.
  if (
    event.origin !== "" ||
    event.isTrusted !== true ||
    event.currentTarget !== self ||
    event.source !== null ||
    event.ports.length !== 0
  )
    return;
  var message = event.data;
  if (
    message === null ||
    typeof message !== "object" ||
    Array.isArray(message) ||
    !Object.prototype.hasOwnProperty.call(message, "type") ||
    !Object.prototype.hasOwnProperty.call(message, "id") ||
    !Number.isSafeInteger(message.id) ||
    message.id <= 0
  )
    return;
  if (
    message.type === "schedule" &&
    Reflect.ownKeys(message).length === 3 &&
    Object.prototype.hasOwnProperty.call(message, "deadline") &&
    Number.isFinite(message.deadline) &&
    message.deadline >= 0 &&
    message.deadline <= Number.MAX_SAFE_INTEGER
  ) {
    deadlines.set(message.id, message.deadline);
  } else if (
    message.type === "cancel" &&
    Reflect.ownKeys(message).length === 2
  ) {
    deadlines.delete(message.id);
  } else return;
  arm();
};
