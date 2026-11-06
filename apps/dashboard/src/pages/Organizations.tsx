"use client";

import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getOrganizations, type OrganizationDto } from "@/api/client";
import { DashboardLayout } from "@/components/layout";
import {
  BUIBadge,
  BUIButton,
  BUIInput,
  BUIPagination,
  BUITable,
  BUITableBody,
  BUITableCell,
  BUITableColumn,
  BUITableHeader,
  BUITableRow,
} from "@/components/ui";
import { Search, Building2 } from "lucide-react";

const STATUS_LABELS: Record<string, string> = {
  active: "Ativo",
  pending: "Pendente",
  inactive: "Inativo",
  suspended: "Suspenso",
  onboarding: "Onboarding",
};

const STATUS_CLASS: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-800 border-emerald-200",
  pending: "bg-amber-100 text-amber-800 border-amber-200",
  inactive: "bg-muted text-muted-foreground border-muted",
  suspended: "bg-red-100 text-red-800 border-red-200",
  onboarding: "bg-blue-100 text-blue-800 border-blue-200",
};

type OrgColumn = keyof OrganizationDto | "actions";

const columns: OrgColumn[] = [
  "tenantId",
  "name",
  "document",
  "createdAt",
  "status",
  "actions",
];

export default function OrganizationsPage() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(10);
  const [sort, setSort] = useState<{ id: OrgColumn; desc: boolean }>({
    id: "createdAt",
    desc: true,
  });

  const { data: organizations = [], isLoading, error } = useQuery({
    queryKey: ["organizations"],
    queryFn: getOrganizations,
    staleTime: 30_000,
  });

  // Aplica filtro manualmente (pesquisa por nome, documento ou ID)
  const filtered = useMemo(
    () =>
      organizations.filter(
        (o) =>
          o.name.toLowerCase().includes(search.toLowerCase()) ||
          (o.document ?? "").toLowerCase().includes(search.toLowerCase()) ||
          o.tenantId.includes(search),
    ),
    [organizations, search],
  );

  // Ordena
  const sorted = useMemo(() => {
    const dir = sort.desc ? -1 : 1;
    return [...filtered].sort((a, b) => {
      const id = sort.id as keyof OrganizationDto;
      const av = (a as unknown as Record<string, unknown>)[id];
      const bv = (b as unknown as Record<string, unknown>)[id];
      if (av === bv) return 0;
      if (av === undefined || av === null) return 1;
      if (bv === undefined || bv === null) return -1;
      if (typeof av === "string" && typeof bv === "string") {
        return av.localeCompare(bv) * dir;
      }
      return (Number(av) - Number(bv)) * dir;
    });
  }, [filtered, sort]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages);
  if (safePage !== page) {
    setPage(safePage);
  }

  const pageData = sorted.slice((safePage - 1) * pageSize, safePage * pageSize);

  const handleCreate = useCallback(() => {
    // eslint-disable-next-line no-alert
    alert("Cadastro de organização em breve");
  }, []);

  const handleSort = useCallback((id: OrgColumn) => {
    setSort((s) => (s.id === id ? { id, desc: !s.desc } : { id, desc: false }));
  }, []);

  return (
    <DashboardLayout activePage="organizations">
      <div className="space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Organizações</h1>
            <p className="text-sm text-muted-foreground">
              Gerencie as organizações do sistema
            </p>
          </div>

          <div className="flex items-center gap-2 w-full lg:w-auto">
            <div className="relative flex-1 lg:w-64">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <BUIInput
                placeholder="Buscar organização…"
                value={search}
                onChange={(value: string) => {
                  setSearch(value);
                  setPage(1);
                }}
                className="pl-9"
              />
            </div>
            <BUIButton onClick={handleCreate}>
              <Building2 className="h-4 w-4 mr-2" />
              Nova organização
            </BUIButton>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card shadow-sm">
          <div className="overflow-auto">
            <BUITable size="md">
              <BUITableHeader>
                <BUITableRow>
                  {columns.map((id) => {
                    if (id === "actions") {
                      return (
                        <BUITableColumn key={id}>
                          <BUITableCell className="font-medium">Ações</BUITableCell>
                        </BUITableColumn>
                      );
                    }
                    return (
                      <BUITableColumn
                        key={id}
                        onClick={() => handleSort(id)}
                        className="cursor-pointer font-medium select-none"
                        data-sorted={sort.id === id ? (sort.desc ? "desc" : "asc") : undefined}
                      >
                        <BUITableCell>
                          {id === "tenantId" ? "ID" : id === "name" ? "Nome" : id === "document" ? "Documento" : id === "createdAt" ? "Criado em" : "Status"}
                          {sort.id === id && (sort.desc ? " ▼" : " ▲")}
                        </BUITableCell>
                      </BUITableColumn>
                    );
                  })}
                </BUITableRow>
              </BUITableHeader>
              <BUITableBody>
                {pageData.map((row) => (
                  <BUITableRow key={row.tenantId}>
                    {columns.map((id) => {
                      if (id === "actions") {
                        return (
                          <BUITableCell key={id}>
                            <div className="flex items-center gap-2">
                              <BUIButton
                                variant="ghost"
                                size="xs"
                                onClick={() => {
                                  // eslint-disable-next-line no-alert
                                  alert(
                                    `Organização: ${row.name}\nID: ${row.tenantId}\nStatus: ${row.status}`,
                                  );
                                }}
                              >
                                Ver
                              </BUIButton>
                            </div>
                          </BUITableCell>
                        );
                      }
                      const value = row[id];
                      if (id === "status") {
                        const status = String(value ?? "");
                        return (
                          <BUITableCell key={id}>
                            <BUIBadge color="neutral" className={STATUS_CLASS[status]}>
                              {STATUS_LABELS[status] ?? status}
                            </BUIBadge>
                          </BUITableCell>
                        );
                      }
                      if (id === "createdAt") {
                        return (
                          <BUITableCell key={id}>
                            <span className="text-xs text-muted-foreground">
                              {new Date(String(value)).toLocaleDateString("pt-BR")}
                            </span>
                          </BUITableCell>
                        );
                      }
                      if (id === "tenantId") {
                        return (
                          <BUITableCell key={id}>
                            <span className="font-mono text-xs text-muted-foreground">
                              {String(value ?? "").slice(0, 8)}…
                            </span>
                          </BUITableCell>
                        );
                      }
                      if (id === "document") {
                        return (
                          <BUITableCell key={id}>
                            {value ? (
                              <span className="font-mono text-xs text-muted-foreground">
                                {value}
                              </span>
                            ) : (
                              <span className="text-xs text-muted-foreground/50">—</span>
                            )}
                          </BUITableCell>
                        );
                      }
                      return (
                        <BUITableCell key={id}>
                          <span className="text-xs text-muted-foreground">
                            {String(value)}
                          </span>
                        </BUITableCell>
                      );
                    })}
                  </BUITableRow>
                ))}
              </BUITableBody>
            </BUITable>
          </div>
        </div>

        {sorted.length === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-sm font-medium text-muted-foreground">
              Nenhuma organização encontrada
            </p>
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Exibindo{" "}
              {Math.min((safePage - 1) * pageSize + 1, sorted.length)}{"-"}{Math.min(
                safePage * pageSize,
                sorted.length,
              )} de {sorted.length} resultados
            </p>
            <BUIPagination
              page={safePage}
              totalPages={totalPages}
              onChange={(p: number) => {
                setPage(p);
              }}
              previousLabel="Anterior"
              nextLabel="Próximo"
            />
          </div>
        )}

        {error && (
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : "Erro ao carregar organizações"}
          </p>
        )}
      </div>
    </DashboardLayout>
  );
}
