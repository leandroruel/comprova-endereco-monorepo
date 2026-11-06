"use client";

/**
 * Board UI table primitives re-exported from the shared UI barrel.
 *
 * The `<BUITable>` wrapper renders Board UI's React Aria `Table` inside a
 * scroll container. The consumer drives sorting/filtering/pagination with
 * `@tanstack/react-table` and renders rows/cells directly (see
 * `apps/dashboard/src/pages/Organizations.tsx`).
 *
 * Both the admin and verifier dashboards consume these from `@/components/ui`.
 */
export {
  Table as BUITable,
  TableHeader as BUITableHeader,
  TableBody as BUITableBody,
  TableRow as BUITableRow,
  TableCell as BUITableCell,
  TableColumn as BUITableColumn,
} from "@/components/base/table/table";
export type { TableSize as BUITableSize } from "@/components/base/table/table";
