import { Text, UnstyledButton } from "@mantine/core";
import { ReactNode } from "react";
import { TbArrowDown, TbArrowUp, TbArrowsSort } from "react-icons/tb";

export type SortDirection = "asc" | "desc";

const SortableHeader = <Field,>({
  field,
  currentField,
  currentDir,
  onSort,
  children,
}: {
  field: Field;
  currentField: Field;
  currentDir: SortDirection;
  onSort: (_field: Field) => void;
  children: ReactNode;
}) => {
  const active = currentField === field;
  const Icon = active
    ? currentDir === "asc"
      ? TbArrowUp
      : TbArrowDown
    : TbArrowsSort;
  return (
    <UnstyledButton
      onClick={() => onSort(field)}
      style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
    >
      <Text fw={700} size="sm" style={{ whiteSpace: "nowrap" }}>
        {children}
      </Text>
      <Icon size={14} style={{ flexShrink: 0, opacity: active ? 1 : 0.5 }} />
    </UnstyledButton>
  );
};

export default SortableHeader;
