import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(
  new URL("../src/components/upload/PendingUploads.tsx", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  },
}).outputText;

// Render the production component with synchronous hooks: effects run on every
// render whose dependencies changed, refs persist like React's.
function fixture(teamFolderId) {
  const refs = [];
  const effects = [];
  let refIndex = 0;
  let effectIndex = 0;
  let pending;
  let settled = 0;
  let dismissed = [];
  let element = null;
  const jsx = (type, props) => ({ type, props });
  const defaultExport = (value) => ({ __esModule: true, default: value });
  const modules = {
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    react: {
      useRef: (value) => (refs[refIndex++] ??= { current: value }),
      useEffect: (effect, deps) => {
        const index = effectIndex++;
        const previous = effects[index];
        if (previous && deps.every((dep, i) => Object.is(dep, previous[i])))
          return;
        effects[index] = deps;
        effect();
      },
    },
    "@mantine/core": {
      Alert: "Alert",
      Button: "Button",
      Group: "Group",
      Stack: "Stack",
      Text: "Text",
    },
    "@mantine/hooks": {
      useLocalStorage: () => [
        dismissed,
        (value) => {
          dismissed = value;
        },
      ],
    },
    "@tanstack/react-query": { useQuery: () => ({ data: pending }) },
    "next/link": defaultExport("Link"),
    "useTranslate.hook": defaultExport(() => (id) => id),
    "user.hook": defaultExport(() => ({ user: { id: "owner" } })),
    "share.service": defaultExport({ getPendingUploads: async () => [] }),
    "fileSize.util": { byteToHumanSizeString: () => "0 B" },
    dayjs: defaultExport(() => ({ format: () => "" })),
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require: (name) => {
      const found = modules[name] ?? modules[name.split("/").at(-1)];
      if (!found) throw new Error("Missing fixture dependency " + name);
      return found;
    },
  });
  return {
    render(uploads) {
      pending = uploads;
      refIndex = effectIndex = 0;
      element = exports.default({
        teamFolderId,
        onSettled: () => settled++,
      });
      return element;
    },
    close() {
      element.props.onClose();
    },
    get dismissed() {
      return dismissed;
    },
    get settled() {
      return settled;
    },
  };
}

const upload = (id, teamFolderId, fileCount = 1) => ({
  id,
  teamFolderId,
  createdAt: "2026-10-14T12:00:00.000Z",
  fileCount,
  size: 1,
  canResume: true,
});

test("a folder upload that leaves the pending list refreshes its folder", () => {
  const view = fixture("folder-a");
  view.render(undefined);
  view.render([upload("native", "folder-a"), upload("other", "folder-b")]);
  assert.equal(view.settled, 0);
  view.render([upload("other", "folder-b")]);
  assert.equal(view.settled, 1);
  view.render([]);
  assert.equal(view.settled, 1);
});

test("uploads of other folders and new uploads do not refresh the folder", () => {
  const view = fixture("folder-a");
  view.render([upload("other", "folder-b")]);
  view.render([upload("native", "folder-a")]);
  view.render([upload("native", "folder-a"), upload("next", "folder-a")]);
  assert.equal(view.settled, 0);
});

test("the first listing after mount is a baseline, not a settlement", () => {
  const view = fixture("folder-a");
  view.render([]);
  view.render([upload("native", "folder-a")]);
  assert.equal(view.settled, 0);
});

test("uploads without any saved file are not listed", () => {
  const view = fixture();
  assert.equal(view.render([upload("empty", "folder-a", 0)]), null);
  assert.notEqual(
    view.render([upload("empty", "folder-a", 0), upload("saved", "folder-a")]),
    null,
  );
});

test("a closed notice comes back only for a new upload", () => {
  const view = fixture();
  view.render([upload("first", "folder-a")]);
  view.close();
  assert.deepEqual([...view.dismissed], ["first"]);
  assert.equal(view.render([upload("first", "folder-a")]), null);
  assert.notEqual(
    view.render([upload("first", "folder-a"), upload("second", "folder-a")]),
    null,
  );
  view.render([upload("second", "folder-a")]);
  assert.deepEqual([...view.dismissed], []);
});
