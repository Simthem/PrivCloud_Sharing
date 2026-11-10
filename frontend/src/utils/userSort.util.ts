import type User from "../types/user.type";

export type UserSortField = "username" | "email" | "created" | "admin";

export type UserSort = {
  field: UserSortField;
  direction: "asc" | "desc";
};

export const DEFAULT_USER_SORT: UserSort = {
  field: "created",
  direction: "asc",
};

const time = (date?: string | null) =>
  date ? new Date(date).getTime() : undefined;

const sortValue = (user: User, field: UserSortField) => {
  switch (field) {
    case "username":
      return user.username;
    case "email":
      return user.email;
    case "created":
      return time(user.createdAt);
    case "admin":
      return user.isAdmin ? 1 : 0;
  }
};

const compare = (a?: string | number, b?: string | number) =>
  typeof a === "string" && typeof b === "string"
    ? a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
    : (a as number) - (b as number);

/** Accounts without a value stay last, equal ones keep their signup order. */
export function sortUsers(users: User[], { field, direction }: UserSort) {
  const factor = direction === "asc" ? 1 : -1;
  return [...users].sort((a, b) => {
    const [valueA, valueB] = [sortValue(a, field), sortValue(b, field)];
    if (valueA === undefined || valueB === undefined) {
      if (valueA !== valueB) return valueA === undefined ? 1 : -1;
    } else {
      const order = compare(valueA, valueB);
      if (order !== 0) return factor * order;
    }
    return (
      (time(a.createdAt) ?? 0) - (time(b.createdAt) ?? 0) ||
      a.id.localeCompare(b.id)
    );
  });
}
