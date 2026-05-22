import { ActionIcon } from "@mantine/core";
import { Dispatch, SetStateAction } from "react";
import { TbChevronDown, TbChevronUp, TbSelector } from "react-icons/tb";

export type TableSort = {
  property?: string;
  direction: "asc" | "desc";
};

const TableSortIcon = ({
  sort,
  setSort,
  property,
}: {
  sort: TableSort;
  setSort: Dispatch<SetStateAction<TableSort>>;
  property: string;
}) => {
  if (sort.property === property) {
    return (
      <ActionIcon
        variant="subtle"
        color="gray"
        size="sm"
        onClick={() =>
          setSort({
            property,
            direction: sort.direction === "asc" ? "desc" : "asc",
          })
        }
      >
        {sort.direction === "asc" ? <TbChevronDown size={14} /> : <TbChevronUp size={14} />}
      </ActionIcon>
    );
  } else {
    return (
      <ActionIcon
        variant="subtle"
        color="gray"
        size="sm"
        onClick={() => setSort({ property, direction: "asc" })}
      >
        <TbSelector size={14} />
      </ActionIcon>
    );
  }
};

export default TableSortIcon;
