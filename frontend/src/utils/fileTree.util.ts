export type FileTreeItem = {
  id: string;
  name: string;
  uploadRelativePath?: string | null;
  relativePath?: string | null;
  webkitRelativePath?: string;
  path?: string;
};

const CONTROL_CHARS = /[\x00-\x1F\x7F]/;
const UNSAFE_SEGMENT = /[\\/]|\.\.|\x00/;

const isSafeSegment = (segment: string) =>
  !!segment &&
  segment !== "." &&
  !UNSAFE_SEGMENT.test(segment) &&
  !CONTROL_CHARS.test(segment);

export type FileTreeFolderNode<T extends FileTreeItem> = {
  type: "folder";
  key: string;
  name: string;
  path: string;
  depth: number;
  fileCount: number;
  children: FileTreeNode<T>[];
};

export type FileTreeFileNode<T extends FileTreeItem> = {
  type: "file";
  key: string;
  name: string;
  path: string;
  depth: number;
  file: T;
};

export type FileTreeNode<T extends FileTreeItem> =
  | FileTreeFolderNode<T>
  | FileTreeFileNode<T>;

type MutableFolderNode<T extends FileTreeItem> = Omit<
  FileTreeFolderNode<T>,
  "children"
> & {
  children: Array<MutableFolderNode<T> | FileTreeFileNode<T>>;
  folderChildren: Map<string, MutableFolderNode<T>>;
};

const getFilePathSegments = (file: FileTreeItem): string[] => {
  const rawPath =
    file.uploadRelativePath ||
    file.relativePath ||
    file.webkitRelativePath ||
    file.path;
  const normalizedPath = rawPath?.replace(/^\/+/, "");
  const path =
    normalizedPath &&
    !normalizedPath.includes("\\") &&
    !normalizedPath.includes("\x00")
      ? normalizedPath
      : file.name;
  const segments = path.split("/").filter(Boolean);

  if (
    segments.length === 0 ||
    segments.some((segment) => !isSafeSegment(segment)) ||
    segments[segments.length - 1] !== file.name
  ) {
    return [file.name];
  }

  return path.split("/").filter(Boolean);
};

const createFolderNode = <T extends FileTreeItem>(
  name: string,
  path: string,
  depth: number,
): MutableFolderNode<T> => ({
  type: "folder",
  key: `folder:${path}`,
  name,
  path,
  depth,
  fileCount: 0,
  children: [],
  folderChildren: new Map(),
});

const stripMutableFields = <T extends FileTreeItem>(
  node: MutableFolderNode<T>,
): FileTreeFolderNode<T> => {
  const children: FileTreeNode<T>[] = node.children.map((child) =>
    child.type === "folder" ? stripMutableFields(child) : child,
  );
  return {
    type: node.type,
    key: node.key,
    name: node.name,
    path: node.path,
    depth: node.depth,
    fileCount: node.fileCount,
    children,
  };
};

export const hasNestedFilePaths = <T extends FileTreeItem>(files: T[]): boolean =>
  files.some((file) => getFilePathSegments(file).length > 1);

export const buildFileTree = <T extends FileTreeItem>(
  files: T[],
): FileTreeNode<T>[] => {
  const root = createFolderNode<T>("", "", -1);

  files.forEach((file) => {
    const segments = getFilePathSegments(file);
    const fileName = segments[segments.length - 1] || file.name;
    let parent = root;

    segments.slice(0, -1).forEach((segment, depth) => {
      const folderPath = parent.path ? `${parent.path}/${segment}` : segment;
      let folder = parent.folderChildren.get(segment);

      if (!folder) {
        folder = createFolderNode<T>(segment, folderPath, depth);
        parent.folderChildren.set(segment, folder);
        parent.children.push(folder);
      }

      folder.fileCount += 1;
      parent = folder;
    });

    parent.children.push({
      type: "file",
      key: `file:${file.id}`,
      name: fileName,
      path: segments.join("/"),
      depth: Math.max(0, segments.length - 1),
      file,
    });
  });

  return root.children.map((child) =>
    child.type === "folder" ? stripMutableFields(child) : child,
  );
};

export const flattenFileTree = <T extends FileTreeItem>(
  nodes: FileTreeNode<T>[],
  collapsedFolders: Set<string>,
): FileTreeNode<T>[] => {
  const flattened: FileTreeNode<T>[] = [];

  nodes.forEach((node) => {
    flattened.push(node);

    if (node.type === "folder" && !collapsedFolders.has(node.path)) {
      flattened.push(...flattenFileTree(node.children, collapsedFolders));
    }
  });

  return flattened;
};
